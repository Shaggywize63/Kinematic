/**
 * "Follow-up date" on the lead form (BMW Ventures and any tenant that captures a
 * `next_follow_up_date` custom field on the lead).
 *
 * The rep picks a DATE (no time) on lead-create — "come back and visit this lead
 * on this day". The server turns it into a planned activity, due at 09:00 in the
 * tenant's local day, assigned to the lead's owner. The existing
 * activityReminders.service then notifies the owner on the morning of that day
 * (~30 min before the due time) — exactly the "remind me that day to visit this
 * lead" the follow-up date is for. No new reminder plumbing is needed.
 *
 * This mirrors scheduledVisit.service, but the follow-up date rides inside the
 * lead's `custom_fields` (the admin-defined `next_follow_up_date` field) rather
 * than a dedicated request param, so it works for every client that renders the
 * custom field — web and Android — with no client change beyond showing the
 * field, and for offline-queued creates (the date is on the lead row already).
 */
import * as crud from './crud.service';

export interface FollowUpReminder {
  id: string;
  due_at: string;
}

// The custom-field key the lead form writes the follow-up date into. Kept as a
// constant so the parser and any future admin-config lookup agree on one name.
export const FOLLOW_UP_FIELD_KEY = 'next_follow_up_date';

// 09:00 India Standard Time (UTC+05:30) is 03:30 UTC. The follow-up is a
// date-only value, so we anchor the reminder to the start of the business day in
// IST. Exposed as an env override for a future non-India deployment.
const FOLLOW_UP_HOUR_UTC = Number(process.env.CRM_FOLLOWUP_HOUR_UTC ?? 3);
const FOLLOW_UP_MIN_UTC = Number(process.env.CRM_FOLLOWUP_MIN_UTC ?? 30);

const personName = (lead: Record<string, unknown>): string => {
  const parts = [lead.first_name, lead.last_name].map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return parts.join(' ') || (typeof lead.company === 'string' ? lead.company.trim() : '') || 'lead';
};

/**
 * Read the follow-up date out of a lead's custom_fields and resolve it to a
 * due timestamp (09:00 IST on that day). Returns null when there is no usable
 * date, so callers can simply skip the reminder. Accepts a plain `YYYY-MM-DD`
 * (what the date custom field stores) or any Date-parseable string.
 */
export function resolveFollowUpDueAt(lead: Record<string, unknown>): string | null {
  const cf = lead.custom_fields;
  const raw = (cf && typeof cf === 'object')
    ? (cf as Record<string, unknown>)[FOLLOW_UP_FIELD_KEY]
    : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  // Date-only (YYYY-MM-DD): anchor to 09:00 IST so the day-of reminder fires in
  // the morning. A full timestamp is honoured verbatim.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const due = dateOnly
    ? new Date(Date.UTC(
        Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)),
        FOLLOW_UP_HOUR_UTC, FOLLOW_UP_MIN_UTC, 0,
      ))
    : new Date(s);
  if (Number.isNaN(due.getTime())) return null;
  return due.toISOString();
}

/**
 * Create the planned follow-up activity for a freshly-created lead that carries
 * a `next_follow_up_date`. Best-effort by contract: the lead already exists, so
 * the caller wraps this and never fails the create on a reminder error. Returns
 * null when the lead has no follow-up date.
 */
export async function createFollowUpReminder(args: {
  org_id: string;
  user_id?: string;
  lead: Record<string, unknown>;
}): Promise<FollowUpReminder | null> {
  const { org_id, user_id, lead } = args;
  const dueIso = resolveFollowUpDueAt(lead);
  if (!dueIso || !lead.id) return null;
  // Whoever owns the lead does the visit, else whoever captured it.
  const assignee = (lead.owner_id as string | null | undefined) ?? user_id ?? null;
  const row = await crud.create('crm_activities', org_id, {
    type: 'meeting',
    subject: `Follow-up — ${personName(lead)}`,
    lead_id: lead.id,
    client_id: (lead.client_id as string | null | undefined) ?? null,
    // 'planned' keeps it open for activityReminders; the schema defaults to
    // 'completed', which would never remind.
    status: 'planned',
    owner_id: assignee,
    assigned_to: assignee,
    due_at: dueIso,
  }, user_id) as { id: string; due_at?: string };
  return { id: row.id, due_at: row.due_at ?? dueIso };
}
