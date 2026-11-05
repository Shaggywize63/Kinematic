/**
 * Activity reminders — the missing generator that turns a *scheduled activity
 * coming due* (call / meeting / task with a due_at) into a per-user
 * notifications row. Everything downstream already exists: the dispatch-pushes
 * cron delivers the row over FCM/APNs and all three in-app bells (web, iOS,
 * Android) render it.
 *
 * Recipient = assigned_to ?? owner_id ?? created_by. Activities track the
 * person primarily via `assigned_to` (owner_id is often null — see backend
 * CLAUDE.md), so that wins; created_by is a last resort so an unassigned but
 * self-created reminder still reaches someone.
 *
 * Dedup is crm_activities.reminded_at: each activity fires exactly one
 * reminder, and we stamp it even when there is no valid recipient so a bad
 * row can't be re-scanned forever. Runs under runWithProject (per tenant) via
 * the /cron/dispatch-activity-reminders route.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { notifyUsers } from '../notify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActivityRow {
  id: string;
  org_id: string | null;
  subject: string | null;
  type: string | null;
  due_at: string;
  assigned_to: string | null;
  owner_id: string | null;
  created_by: string | null;
  lead_id: string | null;
  deal_id: string | null;
}

/**
 * The verb phrase that ends the reminder sentence — "is due in 25 min" / "is now due" /
 * "was due 2h ago". It carries its own verb so the sentence reads right in every case
 * (it used to be spliced after a fixed "is", giving "is was due 23h ago").
 */
export function dueClause(dueIso: string, now: number = Date.now()): string {
  const diffMin = Math.round((new Date(dueIso).getTime() - now) / 60_000);
  if (diffMin >= 1 && diffMin < 60) return `is due in ${diffMin} min`;
  if (Math.abs(diffMin) < 1) return 'is now due';
  if (diffMin <= -1) {
    const h = Math.round(-diffMin / 60);
    return h >= 1 ? `was due ${h}h ago` : `was due ${-diffMin} min ago`;
  }
  return 'is due soon';
}

/**
 * Insert reminder notifications for open activities that have just come due.
 *
 * Window: due within the next 30 minutes (a short heads-up) OR overdue within
 * the last 3 days (so a freshly-missed task still nudges) — bounded below so a
 * first run can't flood on ancient history. Only rows with reminded_at IS NULL
 * are picked, and every scanned row is stamped, so each activity reminds once.
 */
export async function dispatchActivityReminders(opts: { limit?: number } = {}): Promise<{ checked: number; created: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const now = Date.now();
  const upper = new Date(now + 30 * 60_000).toISOString();       // 30 min ahead
  const lower = new Date(now - 3 * 86_400_000).toISOString();    // 3 days back

  const { data, error } = await supabaseAdmin
    .from('crm_activities')
    .select('id, org_id, subject, type, due_at, assigned_to, owner_id, created_by, lead_id, deal_id')
    .is('completed_at', null)
    .is('reminded_at', null)
    .not('due_at', 'is', null)
    .not('status', 'in', '(done,cancelled)')
    .gte('due_at', lower)
    .lte('due_at', upper)
    .order('due_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.warn(`[activity-reminders] query failed: ${error.message}`);
    return { checked: 0, created: 0 };
  }

  const rows = (data ?? []) as ActivityRow[];
  const stampNow = new Date().toISOString();
  let created = 0;

  for (const a of rows) {
    const recipient = a.assigned_to || a.owner_id || a.created_by;
    // No valid recipient — stamp so it isn't rescanned, and move on.
    if (!recipient || !UUID_RE.test(recipient) || !a.org_id) {
      await supabaseAdmin.from('crm_activities').update({ reminded_at: stampNow }).eq('id', a.id);
      continue;
    }

    const label = (a.subject && a.subject.trim())
      || (a.type ? a.type.charAt(0).toUpperCase() + a.type.slice(1) : 'Activity');
    const kindWord = a.type === 'call' || a.type === 'meeting' || a.type === 'task' ? a.type : 'activity';

    try {
      // type = the persisted enum category; data.kind = the mobile bell's icon
      // key (reuses the existing task icon), and lead_id/deal_id let a tap
      // deep-link straight to the linked record (as the lead/deal reminders do).
      await supabaseAdmin.from('notifications').insert({
        org_id: a.org_id,
        user_id: recipient,
        title: `Reminder: ${label}`,
        body: `Your ${kindWord} “${label}” ${dueClause(a.due_at)}.`,
        type: 'crm_activity_due',
        data: {
          kind: 'crm_task_overdue',
          activity_id: a.id,
          ...(a.lead_id ? { lead_id: a.lead_id } : {}),
          ...(a.deal_id ? { deal_id: a.deal_id } : {}),
        },
      });
      created++;
    } catch (e: any) {
      logger.warn(`[activity-reminders] insert failed for activity ${a.id}: ${e?.message || e}`);
    }
    // Stamp regardless — a transient insert failure must not loop forever.
    await supabaseAdmin.from('crm_activities').update({ reminded_at: stampNow }).eq('id', a.id);
  }

  return { checked: rows.length, created };
}


// ─── Upcoming-activity reminders: 1 week / 3 days / 1 day before the due date ────────────────────────────────────
//
// Opt-in per client by DATA: crm_settings.config.activity_reminders = { enabled?, offsets_days?: [7,3,1], user_ids?: [] }.
// A client without it is never scanned, so every other tenant behaves exactly as before. Each offset fires once per
// activity (crm_activity_reminder_log). Recipients = the people the activity is assigned to (assigned_to, owner,
// everyone on the assignee list) plus the client's configured `user_ids` (e.g. the managers who follow every visit).

export const DEFAULT_REMINDER_OFFSETS = [7, 3, 1];
const DAY_MS = 86_400_000;

/** Normalised, de-duplicated, descending offsets (days). Falls back to 7 / 3 / 1. */
export function reminderOffsets(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : DEFAULT_REMINDER_OFFSETS;
  const out = Array.from(new Set(list.map((n) => Math.floor(Number(n))).filter((n) => Number.isFinite(n) && n >= 1 && n <= 60)));
  out.sort((a, b) => b - a);
  return out.length ? out : [...DEFAULT_REMINDER_OFFSETS];
}

/**
 * Which offsets to log and which (if any) to announce for one activity. An offset is "crossed" once the due date is
 * within that many days. The closest crossed offset is the one announced (only if it has not gone out yet), and every
 * crossed offset is logged — so an activity created two days ahead gets one "due in 2 days" reminder, not a burst of
 * 7-day and 3-day ones, and the 1-day reminder still follows.
 */
export function planReminder(dueMs: number, nowMs: number, offsets: number[], alreadySent: Set<number>): { send: number | null; log: number[] } {
  const remaining = dueMs - nowMs;
  if (remaining <= 0) return { send: null, log: [] };
  const crossed = offsets.filter((d) => d * DAY_MS >= remaining);
  if (!crossed.length) return { send: null, log: [] };
  const closest = Math.min(...crossed);
  return { send: alreadySent.has(closest) ? null : closest, log: crossed.filter((d) => !alreadySent.has(d)) };
}

/** "in 3 days" / "tomorrow" / "today", by whole calendar days in IST. */
export function dueInWords(dueIso: string, nowMs: number = Date.now()): string {
  const ist = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(ist(Date.parse(dueIso)) ) - Date.parse(ist(nowMs))) / DAY_MS);
  const when = new Date(dueIso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  if (days <= 0) return `today (${when})`;
  if (days === 1) return `tomorrow (${when})`;
  return `in ${days} days (${when})`;
}

export async function dispatchUpcomingActivityReminders(opts: { limit?: number } = {}): Promise<{ clients: number; checked: number; notified: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const nowMs = Date.now();
  const result = { clients: 0, checked: 0, notified: 0 };

  const { data: settingRows, error: sErr } = await supabaseAdmin.from('crm_settings').select('org_id, client_id, config').not('client_id', 'is', null);
  if (sErr) { logger.warn(`[activity-upcoming] settings query failed: ${sErr.message}`); return result; }

  for (const row of (settingRows ?? []) as Array<{ org_id: string; client_id: string; config: Record<string, any> | null }>) {
    const cfg = row.config?.activity_reminders as { enabled?: boolean; offsets_days?: unknown; user_ids?: unknown } | undefined;
    if (!cfg || cfg.enabled === false) continue;
    result.clients++;
    const offsets = reminderOffsets(cfg.offsets_days);
    const extra = (Array.isArray(cfg.user_ids) ? cfg.user_ids : []).filter((u): u is string => typeof u === 'string' && UUID_RE.test(u));
    const horizon = new Date(nowMs + Math.max(...offsets) * DAY_MS).toISOString();

    const { data: acts, error } = await supabaseAdmin.from('crm_activities')
      .select('id, org_id, subject, type, due_at, assigned_to, owner_id, lead_id, deal_id, account_id')
      .eq('org_id', row.org_id).eq('client_id', row.client_id).is('deleted_at', null)
      .is('completed_at', null).not('due_at', 'is', null)
      .not('status', 'in', '(done,cancelled,completed)')
      .gt('due_at', new Date(nowMs).toISOString()).lte('due_at', horizon)
      .order('due_at', { ascending: true }).limit(limit);
    if (error) { logger.warn(`[activity-upcoming] activities query failed: ${error.message}`); continue; }
    const list = (acts ?? []) as Array<ActivityRow & { account_id: string | null }>;
    if (!list.length) continue;
    result.checked += list.length;

    const ids = list.map((a) => a.id);
    const [{ data: logs }, { data: team }] = await Promise.all([
      supabaseAdmin.from('crm_activity_reminder_log').select('activity_id, offset_days').in('activity_id', ids),
      supabaseAdmin.from('crm_activity_assignees').select('activity_id, user_id').in('activity_id', ids),
    ]);
    const sent = new Map<string, Set<number>>();
    for (const l of (logs ?? []) as Array<{ activity_id: string; offset_days: number }>) {
      (sent.get(l.activity_id) ?? sent.set(l.activity_id, new Set()).get(l.activity_id)!).add(l.offset_days);
    }
    const crew = new Map<string, string[]>();
    for (const t of (team ?? []) as Array<{ activity_id: string; user_id: string }>) {
      (crew.get(t.activity_id) ?? crew.set(t.activity_id, []).get(t.activity_id)!).push(t.user_id);
    }

    for (const a of list) {
      const plan = planReminder(Date.parse(a.due_at), nowMs, offsets, sent.get(a.id) ?? new Set());
      if (!plan.log.length) continue;
      if (plan.send !== null) {
        const people = Array.from(new Set([a.assigned_to, a.owner_id, ...(crew.get(a.id) ?? []), ...extra]
          .filter((u): u is string => typeof u === 'string' && UUID_RE.test(u))));
        const label = (a.subject && a.subject.trim()) || (a.type ? a.type.charAt(0).toUpperCase() + a.type.slice(1) : 'Activity');
        try {
          await notifyUsers(people, {
            orgId: row.org_id,
            title: `Upcoming: ${label}`,
            body: `“${label}” is due ${dueInWords(a.due_at, nowMs)}.`,
            kind: 'activity_upcoming',
            data: {
              activity_id: a.id, offset_days: plan.send,
              ...(a.lead_id ? { lead_id: a.lead_id } : {}), ...(a.deal_id ? { deal_id: a.deal_id } : {}),
              ...(a.account_id ? { account_id: a.account_id } : {}),
            },
          });
          result.notified += people.length;
        } catch (e: any) {
          logger.warn(`[activity-upcoming] notify failed for activity ${a.id}: ${e?.message || e}`);
          continue; // not logged → retried on the next tick
        }
      }
      await supabaseAdmin.from('crm_activity_reminder_log')
        .upsert(plan.log.map((d) => ({ activity_id: a.id, offset_days: d })), { onConflict: 'activity_id,offset_days', ignoreDuplicates: true });
    }
  }
  return result;
}
