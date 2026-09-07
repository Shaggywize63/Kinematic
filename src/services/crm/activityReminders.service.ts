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

/** "now due" / "due in 25 min" / "was due 2h ago" — a human due-time phrase. */
function duePhrase(dueIso: string): string {
  const diffMin = Math.round((new Date(dueIso).getTime() - Date.now()) / 60_000);
  if (diffMin >= 1 && diffMin < 60) return `due in ${diffMin} min`;
  if (Math.abs(diffMin) < 1) return 'now due';
  if (diffMin <= -1) {
    const h = Math.round(-diffMin / 60);
    return h >= 1 ? `was due ${h}h ago` : `was due ${-diffMin} min ago`;
  }
  return 'due soon';
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
        body: `Your ${kindWord} “${label}” is ${duePhrase(a.due_at)}.`,
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
