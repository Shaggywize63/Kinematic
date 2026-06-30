import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';
import * as automations from '../../services/crm/automations.service';

// ── Activities (call, email, meeting, task, note, sms, whatsapp) ──

// Fire an activity automation trigger, scoped to whichever parent entity the
// activity links to (lead/deal/contact/account). Client_id is resolved from
// the parent so tenant A's automations never run on tenant B's activity.
// Fire-and-forget — never blocks or breaks the activity write.
async function fireActivityTrigger(
  org_id: string,
  user_id: string | undefined,
  trigger: 'activity_created' | 'activity_completed',
  activity: Record<string, any>,
): Promise<void> {
  const linkEntity: 'lead' | 'deal' | 'contact' | 'account' | null =
    activity.lead_id ? 'lead'
    : activity.deal_id ? 'deal'
    : activity.contact_id ? 'contact'
    : activity.account_id ? 'account'
    : null;
  if (!linkEntity) return;
  const entity_id = activity[`${linkEntity}_id`] as string;
  let client_id: string | null = (activity.client_id as string | null) ?? null;
  if (!client_id && (linkEntity === 'lead' || linkEntity === 'deal')) {
    const tbl = linkEntity === 'lead' ? 'crm_leads' : 'crm_deals';
    const { data: parent } = await supabaseAdmin.from(tbl)
      .select('client_id').eq('org_id', org_id).eq('id', entity_id).maybeSingle();
    client_id = (parent as { client_id?: string | null } | null)?.client_id ?? null;
  }
  automations.fireForTrigger(trigger, {
    org_id, user_id, entity: linkEntity, entity_id,
    data: { activity, [linkEntity]: { id: entity_id }, client_id },
  }).catch(() => {});
}

export const listActivities = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { type, status, assigned_to, lead_id, deal_id, contact_id, account_id, limit = '100' } = req.query as Record<string, string>;
  let q = supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', org_id).is('deleted_at', null);
  if (type) q = q.eq('type', type);
  if (status) q = q.eq('status', status);
  if (assigned_to) q = q.eq('assigned_to', assigned_to);
  if (lead_id) q = q.eq('lead_id', lead_id);
  if (deal_id) q = q.eq('deal_id', deal_id);
  if (contact_id) q = q.eq('contact_id', contact_id);
  if (account_id) q = q.eq('account_id', account_id);
  q = q.order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createActivity = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const {
    type = 'note', subject, body, status = 'open', priority = 'medium',
    due_at, assigned_to, duration_seconds,
    linked_to_type, linked_to_id,
    lead_id, contact_id, deal_id, account_id,
  } = req.body;

  if (!subject?.trim()) return badRequest(res, 'subject is required');

  const payload: Record<string, unknown> = {
    org_id, type, subject: subject.trim(), body, status, priority,
    due_at: due_at || null, assigned_to: assigned_to || null,
    duration_seconds: duration_seconds || null,
    created_by: userId,
    linked_to_type: linked_to_type || null,
    linked_to_id: linked_to_id || null,
    lead_id: lead_id || null, contact_id: contact_id || null,
    deal_id: deal_id || null, account_id: account_id || null,
  };

  // If linked_to_type/id are provided, fill the specific FK too
  if (linked_to_type && linked_to_id) {
    if (linked_to_type === 'lead') payload.lead_id = linked_to_id;
    else if (linked_to_type === 'contact') payload.contact_id = linked_to_id;
    else if (linked_to_type === 'deal') payload.deal_id = linked_to_id;
    else if (linked_to_type === 'account') payload.account_id = linked_to_id;
  }

  const { data, error } = await supabaseAdmin.from('crm_activities').insert(payload).select().single();
  if (error) return badRequest(res, error.message);

  // Update last_activity_at on the parent entity
  if (payload.lead_id) {
    await supabaseAdmin.from('crm_leads').update({ last_activity_at: new Date().toISOString() })
      .eq('id', payload.lead_id).eq('org_id', org_id);
  }
  await fireActivityTrigger(org_id, userId, 'activity_created', data);
  return created(res, data, 'Activity logged');
});

export const getActivity = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_activities').select('*')
    .eq('id', req.params.id).eq('org_id', org_id).is('deleted_at', null).single();
  if (error || !data) return notFound(res, 'Activity not found');
  return ok(res, data);
});

export const updateActivity = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const updates = { ...req.body };
  delete updates.org_id; delete updates.id; delete updates.created_at;
  if (updates.status === 'done' && !updates.completed_at) {
    updates.completed_at = new Date().toISOString();
  }
  // Snapshot the prior completion so we can fire activity_completed exactly
  // once — on the null → set transition, not on every later patch.
  const { data: prev } = await supabaseAdmin.from('crm_activities')
    .select('completed_at').eq('id', req.params.id).eq('org_id', org_id).maybeSingle();
  const { data, error } = await supabaseAdmin.from('crm_activities')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id)
    .is('deleted_at', null).select().single();
  if (error) return badRequest(res, error.message);
  if (!(prev as { completed_at?: string | null } | null)?.completed_at && (data as { completed_at?: string | null }).completed_at) {
    await fireActivityTrigger(org_id, userId, 'activity_completed', data);
  }
  return ok(res, data);
});

export const deleteActivity = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_activities')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

export const getCalendar = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { from, to } = req.query as Record<string, string>;
  if (!from || !to) return badRequest(res, 'from and to query params are required');
  const { data, error } = await supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', org_id).is('deleted_at', null)
    .gte('due_at', from).lte('due_at', to).order('due_at');
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

// ── Tasks (alias for activities where type='task') ──

export const listTasks = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { status, assigned_to, limit = '200' } = req.query as Record<string, string>;
  let q = supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', org_id).eq('type', 'task').is('deleted_at', null);
  if (status) q = q.eq('status', status);
  if (assigned_to) q = q.eq('assigned_to', assigned_to);
  q = q.order('due_at', { ascending: true, nullsFirst: false }).limit(parseInt(limit) || 200);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createTask = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { subject, due_at, assigned_to, priority = 'medium', lead_id, deal_id, contact_id } = req.body;
  if (!subject?.trim()) return badRequest(res, 'subject is required');
  const { data, error } = await supabaseAdmin.from('crm_activities').insert({
    org_id, type: 'task', subject: subject.trim(), status: 'open', priority,
    due_at: due_at || null, assigned_to: assigned_to || null,
    lead_id: lead_id || null, deal_id: deal_id || null, contact_id: contact_id || null,
    created_by: userId,
  }).select().single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Task created');
});

export const getTask = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_activities').select('*')
    .eq('id', req.params.id).eq('org_id', org_id).eq('type', 'task').is('deleted_at', null).single();
  if (error || !data) return notFound(res, 'Task not found');
  return ok(res, data);
});

export const updateTask = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const updates = { ...req.body };
  delete updates.org_id; delete updates.id; delete updates.created_at;
  if (updates.status === 'done' && !updates.completed_at) updates.completed_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('crm_activities')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id).eq('type', 'task')
    .is('deleted_at', null).select().single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteTask = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_activities')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', org_id).eq('type', 'task');
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

// ── Notes ────────────────────────────────────────────────────

export const listNotes = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { lead_id, deal_id, contact_id, account_id } = req.query as Record<string, string>;
  let q = supabaseAdmin.from('crm_notes').select('*').eq('org_id', org_id);
  if (lead_id) q = q.eq('lead_id', lead_id);
  if (deal_id) q = q.eq('deal_id', deal_id);
  if (contact_id) q = q.eq('contact_id', contact_id);
  if (account_id) q = q.eq('account_id', account_id);
  q = q.order('created_at', { ascending: false }).limit(200);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createNote = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { content, linked_to_type, linked_to_id, lead_id, deal_id, contact_id, account_id } = req.body;
  if (!content?.trim()) return badRequest(res, 'content is required');
  const payload: Record<string, unknown> = {
    org_id, content: content.trim(), created_by: userId,
    linked_to_type: linked_to_type || null, linked_to_id: linked_to_id || null,
    lead_id: lead_id || null, deal_id: deal_id || null,
    contact_id: contact_id || null, account_id: account_id || null,
  };
  if (linked_to_type && linked_to_id) {
    if (linked_to_type === 'lead') payload.lead_id = linked_to_id;
    else if (linked_to_type === 'deal') payload.deal_id = linked_to_id;
    else if (linked_to_type === 'contact') payload.contact_id = linked_to_id;
    else if (linked_to_type === 'account') payload.account_id = linked_to_id;
  }
  const { data, error } = await supabaseAdmin.from('crm_notes').insert(payload).select().single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Note added');
});

export const getNote = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_notes').select('*')
    .eq('id', req.params.id).eq('org_id', org_id).single();
  if (error || !data) return notFound(res, 'Note not found');
  return ok(res, data);
});

export const updateNote = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_notes')
    .update({ content: req.body.content })
    .eq('id', req.params.id).eq('org_id', org_id).select().single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteNote = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_notes')
    .delete().eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});
