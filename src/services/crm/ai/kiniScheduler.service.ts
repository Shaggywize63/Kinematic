/**
 * KINI Wave 4a — scheduled reminders + proactive nudges.
 *
 * Two cron-driven workers, both reusing the daily-briefing PUSH-DELIVERY
 * mechanism: they insert a row into public.notifications (sent_at = NULL) and
 * the existing dispatcher (POST /api/v1/cron/dispatch-pushes →
 * notifications.service.dispatchPendingPushes) fans it out over FCM (Android) /
 * APNs (iOS). No new delivery path is introduced.
 *
 *   1. runScheduledTasks()   drains kini_scheduled_tasks whose run_at has
 *                            passed — delivered by kini_schedule_reminder from
 *                            chat. `once` tasks complete; daily/weekly advance.
 *   2. runProactiveNudges()  scans, per org, for a few high-signal conditions
 *                            (cold deals, reps with no check-in today) and
 *                            pushes a concise nudge. Gated behind the existing
 *                            KINI agentic-v2 org flag; bounded + best-effort.
 *
 * Both are idempotent, safe on empty, and never throw the whole cron on one
 * row's / one org's failure.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { isAgenticV2Enabled } from './kiniFlags.service';

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// notifications.type is an enum WITHOUT a KINI-specific value on either the
// Kinematic or Tata project (verified: broadcast,target_reminder,check_in_alert,
// performance,stock_ready,learning,sos,general). We use the neutral catch-all
// 'general' so the insert always succeeds; the KINI-ness is carried in `data`.
const NOTIF_TYPE = 'general';

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(Math.round(n), lo), hi);
}

function truncate(s: string, n = 60): string {
  const t = (s || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Queue a push by inserting a pending notifications row — identical mechanism
 * to dailyBriefing.runDailyBriefings. Throws on DB error so the caller can log
 * and move on.
 */
async function pushNotification(row: {
  org_id: string;
  user_id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('notifications').insert({
    org_id: row.org_id,
    user_id: row.user_id,
    title: (row.title || 'KINI').slice(0, 200),
    body: row.body,
    type: NOTIF_TYPE,
    data: row.data ?? {},
  });
  if (error) throw new Error(error.message);
}

// ── 1) Scheduled reminders ───────────────────────────────────────────────────

/** Next run_at for a recurring task — advance by the interval past `now`. */
function nextRunAt(current: string, recurrence: 'daily' | 'weekly', now = Date.now()): string {
  const step = recurrence === 'weekly' ? 7 * DAY_MS : DAY_MS;
  let t = Date.parse(current);
  if (!Number.isFinite(t)) t = now;
  // Advance at least one interval, and past now so a backlog (cron was down)
  // doesn't re-fire the same task every minute until it catches up. Bounded to
  // avoid a runaway loop on absurd inputs.
  for (let i = 0; i < 100_000 && t <= now; i++) t += step;
  return new Date(t).toISOString();
}

export interface ScheduledRunResult {
  due: number;
  delivered: number;
  completed: number;
  rescheduled: number;
}

/**
 * Cron entry — deliver every active task whose run_at has passed, then complete
 * (`once`) or advance (daily/weekly). Capped per run; safe on empty.
 */
export async function runScheduledTasks(limit = 100): Promise<ScheduledRunResult> {
  const cap = clamp(limit, 1, 500);
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from('kini_scheduled_tasks')
    .select('id, org_id, client_id, user_id, run_at, recurrence, message, title, status')
    .eq('status', 'active')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(cap);

  if (error) {
    logger.error(`[kini-scheduled] query failed: ${error.message}`);
    return { due: 0, delivered: 0, completed: 0, rescheduled: 0 };
  }
  const tasks = (rows ?? []) as Array<{
    id: string; org_id: string; client_id: string | null; user_id: string;
    run_at: string; recurrence: 'once' | 'daily' | 'weekly'; message: string; title: string | null;
  }>;
  if (!tasks.length) return { due: 0, delivered: 0, completed: 0, rescheduled: 0 };

  let delivered = 0, completed = 0, rescheduled = 0;
  const now = Date.now();

  for (const t of tasks) {
    try {
      await pushNotification({
        org_id: t.org_id,
        user_id: t.user_id,
        title: (t.title && t.title.trim()) || 'Reminder',
        body: t.message,
        data: { nudge_kind: 'reminder', task_id: t.id },
      });
      delivered++;
    } catch (e: any) {
      // A push-queue failure must not wedge the task (it would re-fire every
      // tick). Log and still advance — matches the dispatcher's "never
      // busy-retry" stance.
      logger.warn(`[kini-scheduled] deliver failed for task ${t.id}: ${e?.message || e}`);
    }

    // Advance / complete AFTER delivery so a crash mid-loop at worst re-delivers
    // one reminder rather than dropping it.
    if (t.recurrence === 'once') {
      const { error: upErr } = await supabaseAdmin.from('kini_scheduled_tasks')
        .update({ status: 'done', last_run_at: nowIso }).eq('id', t.id);
      if (!upErr) completed++;
    } else {
      const next = nextRunAt(t.run_at, t.recurrence, now);
      const { error: upErr } = await supabaseAdmin.from('kini_scheduled_tasks')
        .update({ run_at: next, last_run_at: nowIso }).eq('id', t.id);
      if (!upErr) rescheduled++;
    }
  }

  logger.info(`[kini-scheduled] due=${tasks.length} delivered=${delivered} completed=${completed} rescheduled=${rescheduled}`);
  return { due: tasks.length, delivered, completed, rescheduled };
}

// ── 2) Proactive nudges ──────────────────────────────────────────────────────

/**
 * Same-day dedup guard using the notifications table itself (no extra ledger
 * table): true when this user already got a nudge of `kind` today. Fail-open
 * (returns false on error) so a query quirk never suppresses a nudge.
 */
async function alreadyNudgedToday(user_id: string, kind: string): Promise<boolean> {
  try {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const { data } = await supabaseAdmin
      .from('notifications')
      .select('id')
      .eq('user_id', user_id)
      .gte('created_at', start.toISOString())
      .eq('data->>nudge_kind', kind)
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Cold deals: open, owned deals with NO activity (created or completed) in the
 * last `coldDays` days. Grouped by owner → one nudge per owner. Returns the
 * number of owners nudged.
 */
async function nudgeColdDeals(org_id: string, coldDays: number, cap: number): Promise<number> {
  const cutoff = new Date(Date.now() - coldDays * DAY_MS).toISOString();

  const { data: dealRows } = await supabaseAdmin
    .from('crm_deals')
    .select('id, name, owner_id, created_at')
    .eq('org_id', org_id)
    .eq('status', 'open')
    .is('deleted_at', null)
    .not('owner_id', 'is', null)
    .limit(2000);
  const openDeals = (dealRows ?? []) as Array<{ id: string; name: string | null; owner_id: string; created_at: string }>;
  if (!openDeals.length) return 0;

  // Deals with a recent activity are "warm"; the rest are cold. cutoff is an ISO
  // string we control, so it is safe to interpolate into the .or() filter.
  const warm = new Set<string>();
  for (const ids of chunk(openDeals.map((d) => d.id), 200)) {
    const { data: acts } = await supabaseAdmin
      .from('crm_activities')
      .select('deal_id')
      .eq('org_id', org_id)
      .in('deal_id', ids)
      .or(`created_at.gte.${cutoff},completed_at.gte.${cutoff}`)
      .limit(5000);
    for (const a of (acts ?? []) as Array<{ deal_id: string | null }>) {
      if (a.deal_id) warm.add(a.deal_id);
    }
  }

  const byOwner = new Map<string, Array<{ name: string | null; created_at: string }>>();
  for (const d of openDeals) {
    if (warm.has(d.id)) continue;
    if (!UUID_RE.test(d.owner_id)) continue;
    const list = byOwner.get(d.owner_id) ?? [];
    list.push({ name: d.name, created_at: d.created_at });
    byOwner.set(d.owner_id, list);
  }
  if (!byOwner.size) return 0;

  let sent = 0;
  for (const [owner, list] of byOwner) {
    if (sent >= cap) break;
    if (await alreadyNudgedToday(owner, 'cold_deals')) continue;
    const oldest = list
      .slice()
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    const example = (oldest?.name || '').trim();
    const n = list.length;
    const body =
      `${n} open deal${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} had no activity in ${coldDays}+ days` +
      (example ? ` — e.g. "${truncate(example)}"` : '') +
      `. Log a call or next step to keep ${n === 1 ? 'it' : 'them'} moving.`;
    try {
      await pushNotification({ org_id, user_id: owner, title: 'Deals going cold', body, data: { nudge_kind: 'cold_deals', count: n } });
      sent++;
    } catch (e: any) {
      logger.warn(`[kini-proactive] cold-deal nudge failed for ${owner}: ${e?.message || e}`);
    }
  }
  return sent;
}

/**
 * Reps with no check-in today: users who marked attendance in the last 14 days
 * (active field reps) but have no attendance row for today. Nudges the rep.
 * Returns the number nudged. Best-effort — attendance schema differences degrade
 * to zero rather than throwing.
 */
async function nudgeMissingCheckins(org_id: string, cap: number): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const recentCutoff = new Date(Date.now() - 14 * DAY_MS).toISOString().slice(0, 10);

  const { data: recentRows, error: recentErr } = await supabaseAdmin
    .from('attendance')
    .select('user_id')
    .eq('org_id', org_id)
    .gte('date', recentCutoff)
    .limit(5000);
  if (recentErr) return 0;
  const active = new Set<string>();
  for (const r of (recentRows ?? []) as Array<{ user_id: string | null }>) {
    if (r.user_id && UUID_RE.test(r.user_id)) active.add(r.user_id);
  }
  if (!active.size) return 0;

  const { data: todayRows } = await supabaseAdmin
    .from('attendance')
    .select('user_id')
    .eq('org_id', org_id)
    .eq('date', today)
    .limit(5000);
  const checkedIn = new Set<string>();
  for (const r of (todayRows ?? []) as Array<{ user_id: string | null }>) {
    if (r.user_id) checkedIn.add(r.user_id);
  }

  const missing = Array.from(active).filter((u) => !checkedIn.has(u));
  if (!missing.length) return 0;

  let sent = 0;
  for (const u of missing) {
    if (sent >= cap) break;
    if (await alreadyNudgedToday(u, 'no_checkin')) continue;
    try {
      await pushNotification({
        org_id,
        user_id: u,
        title: 'Mark your attendance',
        body: "You haven't checked in yet today. Open Kinematic to mark attendance and start your visits.",
        data: { nudge_kind: 'no_checkin' },
      });
      sent++;
    } catch (e: any) {
      logger.warn(`[kini-proactive] check-in nudge failed for ${u}: ${e?.message || e}`);
    }
  }
  return sent;
}

/** Candidate orgs to scan — those with open deals or recent attendance. */
async function candidateOrgs(max: number): Promise<string[]> {
  const set = new Set<string>();
  const { data: deals } = await supabaseAdmin
    .from('crm_deals')
    .select('org_id')
    .eq('status', 'open')
    .is('deleted_at', null)
    .limit(5000);
  for (const r of (deals ?? []) as Array<{ org_id: string | null }>) {
    if (r.org_id) set.add(r.org_id);
  }
  const recentCutoff = new Date(Date.now() - 14 * DAY_MS).toISOString().slice(0, 10);
  const { data: att } = await supabaseAdmin
    .from('attendance')
    .select('org_id')
    .gte('date', recentCutoff)
    .limit(5000);
  for (const r of (att ?? []) as Array<{ org_id: string | null }>) {
    if (r.org_id) set.add(r.org_id);
  }
  return Array.from(set).filter((id) => UUID_RE.test(id)).slice(0, max);
}

export interface ProactiveRunResult {
  orgs_scanned: number;
  orgs_skipped_flag_off: number;
  nudges: number;
  cold_deal_nudges: number;
  checkin_nudges: number;
}

/**
 * Cron entry (intended daily) — proactive KINI nudges across orgs. For each org:
 * gate behind the KINI agentic-v2 flag, then run the bounded signal scans. One
 * org's failure never aborts the run.
 *
 * Options:
 *   - org_id             restrict to a single org (skips the flag-driven fan-out
 *                        discovery but still honours the flag).
 *   - cold_deal_days     idle window for the cold-deal signal (default 14).
 *   - max_orgs           cap orgs scanned per run (default 100).
 *   - max_nudges_per_org cap nudges per signal per org (default 100).
 */
export async function runProactiveNudges(opts?: {
  org_id?: string;
  cold_deal_days?: number;
  max_orgs?: number;
  max_nudges_per_org?: number;
}): Promise<ProactiveRunResult> {
  const coldDays = clamp(opts?.cold_deal_days ?? 14, 1, 120);
  const maxOrgs = clamp(opts?.max_orgs ?? 100, 1, 500);
  const maxPerOrg = clamp(opts?.max_nudges_per_org ?? 100, 1, 500);

  const orgIds = opts?.org_id && UUID_RE.test(opts.org_id)
    ? [opts.org_id]
    : await candidateOrgs(maxOrgs);

  let orgsScanned = 0, orgsSkipped = 0, coldNudges = 0, checkinNudges = 0;
  for (const org_id of orgIds) {
    try {
      const enabled = await isAgenticV2Enabled(org_id, null);
      if (!enabled) { orgsSkipped++; continue; }
      orgsScanned++;
      coldNudges += await nudgeColdDeals(org_id, coldDays, maxPerOrg);
      checkinNudges += await nudgeMissingCheckins(org_id, maxPerOrg);
    } catch (e: any) {
      logger.warn(`[kini-proactive] org ${org_id} scan failed: ${e?.message || e}`);
    }
  }

  const nudges = coldNudges + checkinNudges;
  logger.info(`[kini-proactive] orgs=${orgsScanned} skipped=${orgsSkipped} nudges=${nudges} (cold=${coldNudges} checkin=${checkinNudges})`);
  return {
    orgs_scanned: orgsScanned,
    orgs_skipped_flag_off: orgsSkipped,
    nudges,
    cold_deal_nudges: coldNudges,
    checkin_nudges: checkinNudges,
  };
}
