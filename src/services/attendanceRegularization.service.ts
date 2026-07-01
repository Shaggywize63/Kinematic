/**
 * Attendance regularization — a rep requests a fix for a missed/wrong punch
 * (missing check-in/out, wrong time, on-duty, WFH). It routes to the supervisor;
 * on approval the correction is written straight onto the attendance row using
 * its existing is_regularised / override_reason / override_by columns (creating
 * the row if the day had none). Both sides get a push.
 */
import { supabaseAdmin } from '../lib/supabase';
import { AppError } from '../utils';
import { logger } from '../lib/logger';
import type { Actor } from './leave.service';

const ADMIN_ROLES = ['admin', 'super_admin', 'main_admin', 'org_admin', 'sub_admin', 'client'];
const isAdmin = (r?: string | null) => ADMIN_ROLES.includes((r ?? '').toLowerCase());

async function supervisorOf(user_id: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('users').select('supervisor_id').eq('id', user_id).maybeSingle();
  return (data as any)?.supervisor_id ?? null;
}
async function notify(org_id: string, user_id: string | null, title: string, body: string, data: Record<string, string>) {
  if (!user_id) return;
  try { await supabaseAdmin.from('notifications').insert({ org_id, user_id, title, body, type: 'attendance', data }); }
  catch (e: any) { logger.warn(`[att-reg] notify failed: ${e?.message || e}`); }
}

export async function create(actor: Actor, body: any) {
  const approver_id = await supervisorOf(actor.id);
  const { data, error } = await supabaseAdmin.from('attendance_regularizations').insert({
    org_id: actor.org_id, client_id: actor.client_id ?? null, user_id: actor.id,
    att_date: body.att_date, type: body.type,
    requested_checkin_at: body.requested_checkin_at ?? null,
    requested_checkout_at: body.requested_checkout_at ?? null,
    reason: body.reason ?? null, status: 'pending', approver_id,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB');

  const { data: me } = await supabaseAdmin.from('users').select('name').eq('id', actor.id).maybeSingle();
  await notify(actor.org_id, approver_id, 'Attendance regularization',
    `${(me as any)?.name || 'A team member'} requested a ${String(body.type).replace('_', ' ')} correction for ${body.att_date}`,
    { type: 'att_reg_request', request_id: (data as any).id });
  return data;
}

export async function myRequests(org_id: string, user_id: string, limit = 100) {
  const { data, error } = await supabaseAdmin
    .from('attendance_regularizations').select('*').eq('org_id', org_id).eq('user_id', user_id)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new AppError(500, error.message, 'DB');
  return data ?? [];
}

export async function pendingForApprover(actor: Actor, limit = 200) {
  let q = supabaseAdmin.from('attendance_regularizations').select('*').eq('org_id', actor.org_id).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(limit);
  if (!isAdmin(actor.role)) q = q.eq('approver_id', actor.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return data ?? [];
}

export async function decide(actor: Actor, id: string, decision: 'approved' | 'rejected', note?: string) {
  const { data: req } = await supabaseAdmin.from('attendance_regularizations').select('*').eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!req) throw new AppError(404, 'Request not found', 'NOT_FOUND');
  const r = req as any;
  if (r.status !== 'pending') throw new AppError(400, 'Already decided', 'BAD_STATE');
  if (!isAdmin(actor.role) && r.approver_id !== actor.id) throw new AppError(403, 'You are not the approver for this request', 'FORBIDDEN');

  let attendance_id: string | null = r.attendance_id ?? null;

  if (decision === 'approved') {
    // Find (or create) the attendance row for that user + date and apply the fix.
    const { data: att } = await supabaseAdmin.from('attendance')
      .select('id, checkin_at, checkout_at').eq('user_id', r.user_id).eq('date', r.att_date).maybeSingle();

    const checkin = r.requested_checkin_at ?? (att as any)?.checkin_at ?? null;
    const checkout = r.requested_checkout_at ?? (att as any)?.checkout_at ?? null;
    let total_hours: number | null = null;
    if (checkin && checkout) total_hours = Math.max(0, (new Date(checkout).getTime() - new Date(checkin).getTime()) / 3_600_000);

    const patch: Record<string, unknown> = {
      status: 'present', is_regularised: true,
      override_reason: r.reason || note || `Regularized (${r.type})`, override_by: actor.id,
      updated_at: new Date().toISOString(),
    };
    if (r.requested_checkin_at) patch.checkin_at = r.requested_checkin_at;
    if (r.requested_checkout_at) patch.checkout_at = r.requested_checkout_at;
    if (total_hours != null) { patch.total_hours = total_hours; patch.working_minutes = Math.round(total_hours * 60); }

    if (att) {
      await supabaseAdmin.from('attendance').update(patch).eq('id', (att as any).id);
      attendance_id = (att as any).id;
    } else {
      const { data: ins } = await supabaseAdmin.from('attendance').insert({
        org_id: r.org_id, client_id: r.client_id, user_id: r.user_id, date: r.att_date, ...patch,
      }).select('id').single();
      attendance_id = (ins as any)?.id ?? null;
    }
  }

  await supabaseAdmin.from('attendance_regularizations').update({
    status: decision, decided_by: actor.id, decided_at: new Date().toISOString(),
    decision_note: note ?? null, attendance_id, updated_at: new Date().toISOString(),
  }).eq('id', id);

  await notify(actor.org_id, r.user_id, `Regularization ${decision}`,
    `Your attendance correction for ${r.att_date} was ${decision}${note ? ': ' + note : '.'}`,
    { type: 'att_reg_decision', request_id: id, decision });
  return { ok: true, status: decision };
}
