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

export default router;
