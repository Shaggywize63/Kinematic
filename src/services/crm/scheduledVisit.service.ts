/**
 * "Schedule Visit" on the lead form.
 *
 * The lead form can carry a date + time for the next visit. The server turns it
 * into a planned activity assigned to the rep, in the same request that creates
 * the lead — so it works for a lead created offline on a phone (the queued
 * request carries it) and the app never has to chain a second call on a lead id
 * it may not have yet.
 *
 * The reminder needs nothing new: activityReminders.service already notifies the
 * assignee ~30 minutes before any open activity that has a due_at.
 */
import * as crud from './crud.service';

export interface ScheduleVisitInput {
  due_at: string;
  subject?: string | null;
  type?: string;
}

export interface ScheduledVisit {
  id: string;
  due_at: string;
}

const personName = (lead: Record<string, unknown>): string => {
  const parts = [lead.first_name, lead.last_name].map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return parts.join(' ') || (typeof lead.company === 'string' ? lead.company.trim() : '') || 'lead';
};

/** The subject the rep sees in Activities and in the reminder: "Dealer Visit — Shop Name". */
export function visitSubject(input: ScheduleVisitInput, lead: Record<string, unknown>): string {
  const given = (input.subject ?? '').trim();
  return given || `Visit — ${personName(lead)}`;
}

export async function createScheduledVisit(args: {
  org_id: string;
  user_id?: string;
  lead: Record<string, unknown>;
  visit: ScheduleVisitInput;
}): Promise<ScheduledVisit> {
  const { org_id, user_id, lead, visit } = args;
  const due = new Date(visit.due_at);
  if (Number.isNaN(due.getTime())) throw new Error('Invalid visit date and time');
  // The person doing the visit: the lead's owner, else whoever captured it.
  const assignee = (lead.owner_id as string | null | undefined) ?? user_id ?? null;
  const row = await crud.create('crm_activities', org_id, {
    type: visit.type || 'meeting',
    subject: visitSubject(visit, lead),
    lead_id: lead.id,
    client_id: (lead.client_id as string | null | undefined) ?? null,
    // 'planned' is what keeps it open for the reminder; the activity schema defaults to
    // 'completed', which would never remind.
    status: 'planned',
    owner_id: assignee,
    assigned_to: assignee,
    due_at: due.toISOString(),
  }, user_id) as { id: string; due_at?: string };
  return { id: row.id, due_at: row.due_at ?? due.toISOString() };
}
