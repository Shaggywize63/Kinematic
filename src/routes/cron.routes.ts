/**
 * Internal cron endpoints — gated by a shared secret, NOT user JWT,
 * because they're invoked by pg_cron via a Supabase Edge Function
 * (no human user, no Supabase Auth context).
 *
 * Mounted in app.ts BEFORE the auth catch-all on /api/v1, so requests
 * to /api/v1/cron/* bypass the requireAuth middleware. Anything not
 * carrying `Authorization: Bearer ${KINEMATIC_EDGE_SECRET}` gets a 401.
 *
 * KINEMATIC_EDGE_SECRET must be set on both Railway (this server) and
 * Supabase (the edge function caller). If it's missing on the server,
 * we return 503 so we never silently allow unauthenticated traffic
 * through a misconfigured deploy.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { dispatchPendingPushes } from '../services/notifications.service';
import { rescoreLead } from '../services/crm/leads.service';
import { dispatchDueAlerts } from '../services/crm/emailAlerts.service';
import { runDueReportDigests } from '../services/crm/reportSchedules.service';
import { runDailyBriefings } from '../services/crm/ai/dailyBriefing.service';
import { runScheduledTasks, runProactiveNudges } from '../services/crm/ai/kiniScheduler.service';
import { runRetentionPurge } from '../services/crm/retention.service';
import {
  pullEvents as pullGoogleEvents,
  isConfigured as googleConfigured,
} from '../services/integrations/googleCalendar.service';
import { PlanogramService } from '../services/planogram.service';
import { runAutoReplenishment, runAutoReplenishmentAllProjects } from '../services/distribution/replenishment.service';
import { runWithProject, isKnownProject, fallbackProjectKey, knownProjectKeys } from '../lib/projects';
import { runCarryForward } from '../services/leave.service';
import { runRouteDeviationScan } from '../services/routeDeviation.service';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';

const router = Router();

function requireEdgeSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.KINEMATIC_EDGE_SECRET || '';
  if (!secret) {
    logger.warn('[cron] KINEMATIC_EDGE_SECRET not configured — refusing to authorise');
    return res.status(503).json({
      success: false,
      error: 'KINEMATIC_EDGE_SECRET not configured on the server',
      code: 'CRON_SECRET_MISSING',
    });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized', code: 'BAD_EDGE_SECRET' });
  }
  next();
}

/**
 * POST /api/v1/cron/dispatch-pushes
 *
 * Fan-out for unsent rows in public.notifications. Pulls up to 200
 * rows per call; pg_cron schedules this every minute (see migration
 * crm_reminder_push_dispatch). Idempotent on sent_at, so concurrent
 * invocations cap at "same row twice" worst case — never spam.
 */
router.post('/dispatch-pushes', requireEdgeSecret, async (_req, res) => {
  try {
    const result = await dispatchPendingPushes({ limit: 200 });
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] dispatch-pushes crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/rescore-all-leads-now
 *
 * One-shot backfill that recomputes the score for every non-terminal lead
 * under the new scoring-v2 heuristic. Intended to be invoked ONCE after
 * the scoring-v2 deploy so existing leads pick up the new B2B/B2C-aware
 * scores immediately (the daily `crm-rescore-all-leads` edge function
 * would otherwise take 24h to drift the cap-limited 500-per-run set
 * across the whole tenant pool).
 *
 * Body params:
 *   - org_id?: string   restrict to one tenant (optional — omit for all)
 *   - batch?:  number   leads per batch (default 100, cap 500)
 *   - max_batches?: number  total batch budget (default 50 → 5000 leads)
 *
 * Returns counts only — actual rescores happen in-process and may take
 * several minutes for large tenants. Idempotent: re-running just
 * overwrites with the same heuristic result.
 */
// Guards against overlapping full-rescore runs (the loop can take minutes).
let rescoreAllRunning = false;

async function runRescoreAll(opts: { org_id?: string; batchSize: number; maxBatches: number }): Promise<void> {
  let processed = 0;
  let failed = 0;
  let lastId: string | null = null;
  for (let i = 0; i < opts.maxBatches; i++) {
    let q = supabaseAdmin.from('crm_leads')
      .select('id, org_id')
      .is('deleted_at', null)
      .neq('status', 'converted')
      .neq('status', 'unqualified')
      .neq('status', 'lost')
      .order('id', { ascending: true })
      .limit(opts.batchSize);
    if (opts.org_id) q = q.eq('org_id', opts.org_id);
    if (lastId) q = q.gt('id', lastId);

    const { data: rows, error } = await q;
    if (error) { logger.error(`[cron] rescore-all query failed: ${error.message}`); break; }
    if (!rows || rows.length === 0) break;

    // Sequential per batch — keeps Anthropic 429 risk low even though
    // rescoreLead itself only fires the LLM rerank as fire-and-forget.
    for (const row of rows) {
      try {
        await rescoreLead(row.org_id, row.id);
        processed += 1;
      } catch (e: any) {
        failed += 1;
        logger.warn(`[cron] rescore failed for ${row.id}: ${e?.message || e}`);
      }
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < opts.batchSize) break;
  }
  logger.info(`[cron] rescore-all complete: processed=${processed} failed=${failed}`);
}

// The full rescore can run for several minutes (per-lead heuristic + engagement
// fetch). Run it DETACHED and return 202 immediately, so the request isn't
// bounded by the gateway timeout (a synchronous loop 502s after ~1 min and
// only ever covers the first slice of leads).
router.post('/rescore-all-leads-now', requireEdgeSecret, async (req, res) => {
  const body = (req.body ?? {}) as { org_id?: string; batch?: number; max_batches?: number };
  const batchSize = Math.min(500, Math.max(10, Number(body.batch) || 100));
  const maxBatches = Math.min(500, Math.max(1, Number(body.max_batches) || 50));

  if (rescoreAllRunning) {
    return res.status(409).json({ success: false, error: 'A rescore is already running', code: 'RESCORE_IN_PROGRESS' });
  }
  rescoreAllRunning = true;
  runRescoreAll({ org_id: body.org_id, batchSize, maxBatches })
    .catch((e: any) => logger.error(`[cron] rescore-all crashed: ${e?.message || e}`))
    .finally(() => { rescoreAllRunning = false; });

  res.status(202).json({ success: true, data: { started: true, batch: batchSize, max_batches: maxBatches } });
});

/**
 * POST /api/v1/cron/dispatch-scheduled-emails
 *
 * Picks up crm_email_alerts rows whose scheduled_at has passed and
 * dispatches each one. Wire up via pg_cron + the existing edge function
 * pattern (every minute, 50 alerts per tick).
 */
router.post('/dispatch-scheduled-emails', requireEdgeSecret, async (_req, res) => {
  try {
    const result = await dispatchDueAlerts(50);
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] dispatch-scheduled-emails crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/dispatch-report-digests
 *
 * Renders + emails every active report schedule whose next_run_at has passed.
 * Also runs as an in-process hourly tick (see server.ts) so it works without a
 * pg_cron job, but exposing it here lets pg_cron / a manual call drive it too.
 */
router.post('/dispatch-report-digests', requireEdgeSecret, async (_req, res) => {
  try {
    const result = await runDueReportDigests(25);
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] dispatch-report-digests crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/dispatch-daily-briefings
 *
 * Generates + pushes the KINI morning briefing to each rep with something
 * actionable today (once per rep per day, deduped via crm_daily_briefing_log).
 * Also runs as a once-a-morning in-process tick (see server.ts).
 */
router.post('/dispatch-daily-briefings', requireEdgeSecret, async (_req, res) => {
  try {
    const result = await runDailyBriefings(100);
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] dispatch-daily-briefings crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/kini-scheduled
 *
 * KINI Wave 4a — drains kini_scheduled_tasks whose run_at has passed (reminders
 * the user scheduled from chat via kini_schedule_reminder). Each is delivered
 * through the same notifications → FCM/APNs push path as the daily briefing;
 * `once` tasks complete, daily/weekly advance to their next run. Idempotent and
 * safe on empty. Schedule via pg_cron + the edge-function caller like the other
 * jobs (every minute or few minutes). Body: { limit?: number } (default 100,
 * cap 500).
 */
router.post('/kini-scheduled', requireEdgeSecret, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number((req.body ?? {}).limit) || 100));
    const result = await runScheduledTasks(limit);
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] kini-scheduled crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/kini-proactive
 *
 * KINI Wave 4a — proactive/event-driven nudges (intended daily). Per org (gated
 * behind the KINI agentic-v2 org flag), scans a few high-signal conditions —
 * cold deals (open, owned deals idle N+ days) and reps with no check-in today —
 * and pushes a concise nudge via the same notifications → FCM/APNs path.
 * Bounded (caps) and best-effort: one org's failure never fails the run.
 * Schedule via pg_cron + the edge-function caller like the other jobs. Body:
 * { org_id?: string, days?: number, limit?: number } — restrict to one org, the
 * cold-deal idle window (default 14), and the per-signal per-org nudge cap.
 */
router.post('/kini-proactive', requireEdgeSecret, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { org_id?: string; days?: number; limit?: number };
    const result = await runProactiveNudges({
      org_id: typeof body.org_id === 'string' ? body.org_id : undefined,
      cold_deal_days: Number(body.days) || undefined,
      max_nudges_per_org: Number(body.limit) || undefined,
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] kini-proactive crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/purge-retention
 *
 * Data-retention purge (GDPR Art.5(1)(e) / DPDP §8(7)): hard-removes
 * soft-deleted CRM PII past its grace window and trims old GPS/telemetry.
 * DESTRUCTIVE — runs as a dry run (counts only) unless
 * RETENTION_PURGE_ENABLED=true on the server. Pass ?dry_run=true to force a
 * preview even when enabled. Windows are env-tunable
 * (RETENTION_SOFT_DELETE_DAYS / RETENTION_LOCATION_DAYS / RETENTION_AUDIT_DAYS).
 * Schedule via a pg_cron → edge-function caller like the other jobs.
 */
router.post('/purge-retention', requireEdgeSecret, async (req, res) => {
  try {
    const forceDryRun = req.query.dry_run === 'true' || (req.body && req.body.dryRun === true);
    const result = await runRetentionPurge(forceDryRun ? { dryRun: true } : undefined);
    if (result.dryRun) {
      logger.info(`[cron] purge-retention DRY RUN — ${result.totalRows} rows eligible`);
    } else {
      logger.info(`[cron] purge-retention purged ${result.totalRows} rows`);
    }
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] purge-retention crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/sync-google-calendars
 *
 * Inbound half of the two-way Google Calendar sync: for every connected rep,
 * pull their recent + upcoming Google events into crm_activities (idempotent,
 * upsert-by-google_event_id). Push (CRM → Google) already happens inline on
 * activity writes; this closes the loop so events booked directly in Google
 * appear in Kinematic even when the rep never opens the activities page.
 *
 * Schedule via pg_cron + the edge-function caller like the other jobs (every
 * few minutes). Body: { limit?: number } — reps processed per tick (default
 * 200, cap 500). Sequential + best-effort per rep so one bad token never
 * fails the batch.
 */
router.post('/sync-google-calendars', requireEdgeSecret, async (req, res) => {
  try {
    if (!googleConfigured()) {
      return res.json({ success: true, data: { skipped: 'not_configured' } });
    }
    const limit = Math.min(500, Math.max(1, Number((req.body ?? {}).limit) || 200));
    const { data: rows, error } = await supabaseAdmin
      .from('user_google_integrations')
      .select('user_id, org_id')
      .limit(limit);
    if (error) throw new Error(error.message);

    let users = 0, imported = 0, updated = 0, cancelled = 0;
    for (const row of (rows ?? []) as Array<{ user_id: string; org_id: string }>) {
      try {
        const r = await pullGoogleEvents(row.org_id, row.user_id);
        users += 1;
        imported += r.imported; updated += r.updated; cancelled += r.cancelled;
      } catch (e: any) {
        logger.warn(`[cron] google pull failed for ${row.user_id}: ${e?.message || e}`);
      }
    }
    res.json({ success: true, data: { users, imported, updated, cancelled } });
  } catch (err: any) {
    logger.error(`[cron] sync-google-calendars crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/rescore-planogram-compliance
 *
 * Cheap, DETERMINISTIC backfill (NO vision / NO AI) that upgrades OLDER shelf
 * captures to the v2 compliance metrics. For captures whose compliance is stale
 * / pre-v2 (`occupancy_score IS NULL OR methodology = '{}'::jsonb`) but which
 * already HAVE a planogram_recognition row, it re-runs the pure `scoreShelf`
 * from the EXISTING stored detections + the planogram layout and updates the
 * compliance row in place — deriving occupancy, shelf-share, zone/category
 * rollups, pricing/promotions and the full methodology with zero model cost.
 *
 * (Per-capture re-analysis that RE-RUNS vision is the separate, org-scoped
 * POST /api/v1/planograms/captures/:id/reprocess — use that when the detections
 * themselves need refreshing; this job is the cheap bulk path.)
 *
 * Body: { limit?: number (default 50, cap 500), project?: string }. `project`
 * routes the sweep to a specific Supabase project (honoring the same multi-
 * project routing as the rest of the app via runWithProject); omitted it runs
 * against the fallback (default/Tata in production) like the other cron jobs.
 * Idempotent: a re-scored row is no longer stale, so re-running only picks up
 * rows not yet upgraded. Returns { processed, remaining }.
 */
router.post('/rescore-planogram-compliance', requireEdgeSecret, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { limit?: number; project?: string };
    const limit = Math.min(500, Math.max(1, Number(body.limit) || 50));
    const requested = typeof body.project === 'string' ? body.project.trim().toLowerCase() : '';
    const project = requested && isKnownProject(requested) ? requested : fallbackProjectKey();

    const result = await runWithProject(project, () =>
      PlanogramService.rescoreStaleCompliance({ limit }),
    );
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] rescore-planogram-compliance crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/auto-replenishment
 *
 * Auto-mode replenishment agent. For every org whose replenishment agent
 * autonomy is 'auto', drafts the next distributor order from 30-day sell-out
 * velocity (idempotent — refreshes the OPEN draft per distributor, never
 * duplicates). A no-op for any org still on 'suggest'/'approve', so production
 * behaviour is unchanged until an admin opts in.
 *
 * Also runs as a once-a-day in-process tick (see server.ts) so it works without
 * pg_cron; exposing it here lets pg_cron / a manual call drive it too.
 *
 * Body: { all_projects?: boolean, project?: string, org_id?: string }.
 *   - all_projects: fan out across every known tenant (what the daily tick does).
 *   - project: route to one Supabase project (defaults to the prod fallback).
 *   - org_id: restrict to a single org within that project.
 */
router.post('/auto-replenishment', requireEdgeSecret, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { all_projects?: boolean; project?: string; org_id?: string };
    if (body.all_projects) {
      const result = await runAutoReplenishmentAllProjects();
      return res.json({ success: true, data: result });
    }
    const requested = typeof body.project === 'string' ? body.project.trim().toLowerCase() : '';
    const project = requested && isKnownProject(requested) ? requested : fallbackProjectKey();
    const result = await runWithProject(project, () =>
      runAutoReplenishment({ org_id: typeof body.org_id === 'string' ? body.org_id : undefined }),
    );
    res.json({ success: true, data: { project, ...result } });
  } catch (err: any) {
    logger.error(`[cron] auto-replenishment crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/leave-carry-forward
 *
 * Year-end leave carry-forward. Rolls each active rep's leftover balance into
 * the next year, capped per leave type at `max_carry_forward`, as the opening
 * balance. Schedule this once at the year boundary (e.g. 00:30 on Jan 1).
 *
 * Body: { year?: number, all_projects?: boolean, project?: string }.
 *   - year: the target year to carry INTO (defaults to the current UTC year, so
 *     a Jan-1 run rolls last year's leftovers into this year).
 *   - all_projects: fan out across every known tenant project.
 *   - project: route to one Supabase project (defaults to the prod fallback).
 *
 * Idempotent — the (org,user,type,year) unique key means a re-run overwrites
 * the same opening rather than stacking. Types with max_carry_forward = 0 are
 * skipped, so their balances reset.
 */
router.post('/leave-carry-forward', requireEdgeSecret, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { year?: number; all_projects?: boolean; project?: string };
    const toYear = Number.isInteger(body.year) ? Number(body.year) : new Date().getUTCFullYear();

    if (body.all_projects) {
      const out: Record<string, unknown> = {};
      for (const key of knownProjectKeys()) {
        out[key] = await runWithProject(key, () => runCarryForward(toYear));
      }
      return res.json({ success: true, data: { year: toYear, projects: out } });
    }

    const requested = typeof body.project === 'string' ? body.project.trim().toLowerCase() : '';
    const project = requested && isKnownProject(requested) ? requested : fallbackProjectKey();
    const result = await runWithProject(project, () => runCarryForward(toYear));
    res.json({ success: true, data: { project, year: toYear, ...result } });
  } catch (err: any) {
    logger.error(`[cron] leave-carry-forward crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/v1/cron/route-deviation-scan
 *
 * Alerts supervisors about off-route visits (check-in beyond the outlet
 * geofence) for clients granted the route_deviation module. Idempotent —
 * deviation_alerted_at dedupes, so re-runs never double-notify. A no-op when no
 * client carries the module.
 *
 * Body: { lookback_hours?: number (default 24, cap 240), all_projects?: boolean,
 *         project?: string }. Schedule hourly / a few times a day.
 */
router.post('/route-deviation-scan', requireEdgeSecret, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { lookback_hours?: number; all_projects?: boolean; project?: string };
    const lookbackHours = Number.isFinite(body.lookback_hours) ? Number(body.lookback_hours) : 24;

    if (body.all_projects) {
      const out: Record<string, unknown> = {};
      for (const key of knownProjectKeys()) {
        out[key] = await runWithProject(key, () => runRouteDeviationScan({ lookbackHours }));
      }
      return res.json({ success: true, data: { projects: out } });
    }

    const requested = typeof body.project === 'string' ? body.project.trim().toLowerCase() : '';
    const project = requested && isKnownProject(requested) ? requested : fallbackProjectKey();
    const result = await runWithProject(project, () => runRouteDeviationScan({ lookbackHours }));
    res.json({ success: true, data: { project, ...result } });
  } catch (err: any) {
    logger.error(`[cron] route-deviation-scan crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
