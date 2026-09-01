/**
 * Leave management + approval flow.
 *
 * - Admin configures leave_types + holidays.
 * - A rep applies for leave; day-count excludes Sundays + org holidays and
 *   supports half-days on either boundary. Paid types are balance-checked.
 * - The request routes to the rep's supervisor (users.supervisor_id) for
 *   approve/reject; both sides get a push (notifications row -> FCM/APNs).
 * - Balances are computed live from leave_requests so approving/cancelling
 *   never desyncs a stored counter: available = (annual_quota + opening +
 *   adjustment) - approved - pending.
 */
import { supabaseAdmin } from '../lib/supabase';
import { AppError } from '../utils';
import { logger } from '../lib/logger';

const WEEKEND_DOWS = [0]; // Sunday off (6-day field-sales week). Holidays add to this.

export interface Actor { id: string; org_id: string; role?: string | null; client_id?: string | null; }

// ── small helpers ─────────────────────────────────────────────────────────
function parseDate(d: string): Date { return new Date(d.slice(0, 10) + 'T00:00:00Z'); }
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

async function supervisorOf(user_id: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('users').select('supervisor_id').eq('id', user_id).maybeSingle();
  return (data as any)?.supervisor_id ?? null;
}

async function notify(org_id: string, user_id: string | null, title: string, body: string, data: Record<string, string>) {
  if (!user_id) return;
  try {
    await supabaseAdmin.from('notifications').insert({ org_id, user_id, title, body, type: 'leave', data });
  } catch (e: any) { logger.warn(`[leave] notify failed: ${e?.message || e}`); }
}

/** Attach requester + leave-type display fields so clients never show raw UUIDs. */
export async function stampNames(rows: any[], opts: { users?: boolean; types?: boolean }): Promise<any[]> {
  if (!rows.length) return rows;
  if (opts.users) {
    const ids = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
    const { data } = await supabaseAdmin.from('users').select('id, name, employee_id').in('id', ids);
    const m = new Map((data ?? []).map((u: any) => [u.id, u]));
    for (const r of rows) { const u = m.get(r.user_id); r.user_name = u?.name ?? null; r.employee_id = u?.employee_id ?? null; }
  }
  if (opts.types) {
    const ids = Array.from(new Set(rows.map((r) => r.leave_type_id).filter(Boolean)));
    const { data } = await supabaseAdmin.from('leave_types').select('id, name, code, color').in('id', ids);
    const m = new Map((data ?? []).map((t: any) => [t.id, t]));
    for (const r of rows) { const t = m.get(r.leave_type_id); r.leave_type_name = t?.name ?? null; r.leave_type_code = t?.code ?? null; r.leave_type_color = t?.color ?? null; }
  }
  return rows;
}

async function holidaySet(org_id: string, from: string, to: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('holidays').select('holiday_date')
    .eq('org_id', org_id).eq('is_optional', false)
    .gte('holiday_date', from).lte('holiday_date', to);
  return new Set((data ?? []).map((h: any) => String(h.holiday_date).slice(0, 10)));
}

/** Working days in [from,to] inclusive, minus weekends + holidays, minus 0.5 per half-day boundary. */
export function countLeaveDays(from: string, to: string, halfStart: boolean, halfEnd: boolean, holidays: Set<string>): number {
  const a = parseDate(from), b = parseDate(to);
  if (b < a) return 0;
  const counted: string[] = [];
  for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = ymd(d);
    if (WEEKEND_DOWS.includes(d.getUTCDay())) continue;
    if (holidays.has(key)) continue;
    counted.push(key);
  }
  if (counted.length === 0) return 0;
  if (from === to) return halfStart || halfEnd ? 0.5 : 1;
  let n = counted.length;
  if (halfStart && counted.includes(from)) n -= 0.5;
  if (halfEnd && counted.includes(to)) n -= 0.5;
  return Math.max(0, n);
}

/** Working days (Mon–Sat minus org holidays) in [from,to] inclusive, as YYYY-MM-DD. */
async function workingDays(org_id: string, from: string, to: string): Promise<string[]> {
  const hol = await holidaySet(org_id, from, to);
  const a = parseDate(from), b = parseDate(to);
  const out: string[] = [];
  for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    if (WEEKEND_DOWS.includes(d.getUTCDay())) continue;
    const key = ymd(d);
    if (hol.has(key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * Reflect an APPROVED leave onto the attendance sheet so those days read
 * "on leave" instead of "absent". Placeholder rows carry `leave_request_id`
 * and are only ever written for days the rep has NOT already checked in — a
 * real check-in always wins and is never overwritten. Half-day boundaries are
 * marked `half_day` (the rep still works the other half). Best-effort: a
 * failure here never blocks the approval itself.
 */
async function markAttendanceOnLeave(req: any): Promise<void> {
  try {
    const days = await workingDays(req.org_id, req.from_date, req.to_date);
    if (!days.length) return;
    const { data: existing } = await supabaseAdmin
      .from('attendance').select('date, checkin_at')
      .eq('user_id', req.user_id).in('date', days);
    const hasCheckin = new Set(
      (existing ?? []).filter((r: any) => r.checkin_at).map((r: any) => String(r.date).slice(0, 10))
    );
    const halfDays = new Set<string>();
    if (req.half_day_start) halfDays.add(String(req.from_date).slice(0, 10));
    if (req.half_day_end) halfDays.add(String(req.to_date).slice(0, 10));

    const rows = days
      .filter((d) => !hasCheckin.has(d))
      .map((d) => ({
        org_id: req.org_id, client_id: req.client_id ?? null, user_id: req.user_id,
        date: d,
        status: halfDays.has(d) ? 'half_day' : 'on_leave',
        leave_request_id: req.id,
        notes: 'Auto: approved leave',
        updated_at: new Date().toISOString(),
      }));
    if (!rows.length) return;
    const { error } = await supabaseAdmin
      .from('attendance').upsert(rows, { onConflict: 'user_id,date', ignoreDuplicates: false });
    if (error) logger.warn(`[leave] attendance auto-mark failed for request ${req.id}: ${error.message}`);
  } catch (e: any) {
    logger.warn(`[leave] attendance auto-mark threw for request ${req?.id}: ${e?.message || e}`);
  }
}

/**
 * Reverse the auto-mark when an approved leave is cancelled: delete ONLY the
 * placeholder rows we created (tagged with this request) that never became a
 * real check-in. A day where the rep actually checked in keeps its real row.
 */
async function clearAttendanceForLeave(request_id: string): Promise<void> {
  try {
    await supabaseAdmin.from('attendance')
      .delete()
      .eq('leave_request_id', request_id)
      .is('checkin_at', null);
  } catch (e: any) {
    logger.warn(`[leave] attendance auto-clear threw for request ${request_id}: ${e?.message || e}`);
  }
}

// ── leave types (admin) ───────────────────────────────────────────────────
export async function listTypes(org_id: string, client_id: string | null) {
  const { data, error } = await supabaseAdmin
    .from('leave_types').select('*').eq('org_id', org_id).order('position', { ascending: true });
  if (error) throw new AppError(500, error.message, 'DB');
  return (data ?? []).filter((t: any) => t.client_id == null || t.client_id === client_id);
}
export async function upsertType(actor: Actor, id: string | null, body: any) {
  const row = {
    org_id: actor.org_id, client_id: actor.client_id ?? null,
    name: String(body.name).trim(), code: body.code ?? null,
    is_paid: body.is_paid ?? true, annual_quota: body.annual_quota ?? 0,
    allow_half_day: body.allow_half_day ?? true, max_carry_forward: body.max_carry_forward ?? 0,
    requires_attachment: body.requires_attachment ?? false, color: body.color ?? null,
    is_active: body.is_active ?? true, position: body.position ?? 0, updated_at: new Date().toISOString(),
  };
  const q = id
    ? supabaseAdmin.from('leave_types').update(row).eq('org_id', actor.org_id).eq('id', id).select('*').single()
    : supabaseAdmin.from('leave_types').insert(row).select('*').single();
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return data;
}
export async function removeType(org_id: string, id: string) {
  await supabaseAdmin.from('leave_types').update({ is_active: false, updated_at: new Date().toISOString() }).eq('org_id', org_id).eq('id', id);
}

// ── holidays (admin) ──────────────────────────────────────────────────────
export async function listHolidays(org_id: string, year?: number) {
  let q = supabaseAdmin.from('holidays').select('*').eq('org_id', org_id).order('holiday_date');
  if (year) q = q.gte('holiday_date', `${year}-01-01`).lte('holiday_date', `${year}-12-31`);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return data ?? [];
}
export async function addHoliday(actor: Actor, body: any) {
  const { data, error } = await supabaseAdmin.from('holidays').insert({
    org_id: actor.org_id, client_id: actor.client_id ?? null,
    holiday_date: body.holiday_date, name: String(body.name).trim(), is_optional: body.is_optional ?? false,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB');
  return data;
}
export async function removeHoliday(org_id: string, id: string) {
  await supabaseAdmin.from('holidays').delete().eq('org_id', org_id).eq('id', id);
}

// ── balances (computed live) ──────────────────────────────────────────────
export async function balances(org_id: string, user_id: string, client_id: string | null, year: number) {
  const types = await listTypes(org_id, client_id);
  const { data: reqs } = await supabaseAdmin
    .from('leave_requests')
    .select('leave_type_id, days, status, from_date')
    .eq('org_id', org_id).eq('user_id', user_id)
    .in('status', ['approved', 'pending'])
    .gte('from_date', `${year}-01-01`).lte('from_date', `${year}-12-31`);
  const { data: bals } = await supabaseAdmin
    .from('leave_balances').select('leave_type_id, opening, adjustment')
    .eq('org_id', org_id).eq('user_id', user_id).eq('year', year);
  const balByType = new Map((bals ?? []).map((b: any) => [b.leave_type_id, b]));

  return types.map((t: any) => {
    const rows = (reqs ?? []).filter((r: any) => r.leave_type_id === t.id);
    const used = rows.filter((r: any) => r.status === 'approved').reduce((s: number, r: any) => s + Number(r.days), 0);
    const pending = rows.filter((r: any) => r.status === 'pending').reduce((s: number, r: any) => s + Number(r.days), 0);
    const b = balByType.get(t.id) as any;
    const entitled = Number(t.annual_quota) + Number(b?.opening ?? 0) + Number(b?.adjustment ?? 0);
    return {
      leave_type_id: t.id, name: t.name, code: t.code, color: t.color, is_paid: t.is_paid,
      unlimited: Number(t.annual_quota) === 0 && !b,
      entitled, used, pending, available: Math.max(0, entitled - used - pending),
    };
  });
}

// ── requests ──────────────────────────────────────────────────────────────
export async function applyLeave(actor: Actor, body: any) {
  const { data: type } = await supabaseAdmin.from('leave_types').select('*').eq('org_id', actor.org_id).eq('id', body.leave_type_id).maybeSingle();
  if (!type || !(type as any).is_active) throw new AppError(400, 'Invalid or inactive leave type', 'BAD_TYPE');

  const hol = await holidaySet(actor.org_id, body.from_date, body.to_date);
  const days = countLeaveDays(body.from_date, body.to_date, !!body.half_day_start, !!body.half_day_end, hol);
  if (days <= 0) throw new AppError(400, 'Selected range has no working days (all weekends/holidays)', 'NO_DAYS');
  if ((type as any).requires_attachment && !body.attachment_url) throw new AppError(400, 'This leave type requires an attachment', 'ATTACH_REQUIRED');

  // Overlap guard — no other pending/approved request touching this range.
  const { data: overlap } = await supabaseAdmin
    .from('leave_requests').select('id')
    .eq('org_id', actor.org_id).eq('user_id', actor.id)
    .in('status', ['pending', 'approved'])
    .lte('from_date', body.to_date).gte('to_date', body.from_date).limit(1);
  if (overlap && overlap.length) throw new AppError(409, 'You already have a leave request overlapping these dates', 'OVERLAP');

  // Balance check for paid, quota-bounded types.
  const year = parseDate(body.from_date).getUTCFullYear();
  if ((type as any).is_paid && Number((type as any).annual_quota) > 0) {
    const bal = (await balances(actor.org_id, actor.id, actor.client_id ?? null, year)).find((b) => b.leave_type_id === type!.id);
    if (bal && days > bal.available) throw new AppError(400, `Insufficient balance: ${bal.available} day(s) available, ${days} requested`, 'NO_BALANCE');
  }

  const approver_id = await supervisorOf(actor.id);
  const { data, error } = await supabaseAdmin.from('leave_requests').insert({
    org_id: actor.org_id, client_id: actor.client_id ?? null, user_id: actor.id,
    leave_type_id: body.leave_type_id, from_date: body.from_date, to_date: body.to_date,
    half_day_start: !!body.half_day_start, half_day_end: !!body.half_day_end, days,
    reason: body.reason ?? null, contact_number: body.contact_number ?? null,
    attachment_url: body.attachment_url ?? null, status: 'pending', approver_id,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB');

  const { data: me } = await supabaseAdmin.from('users').select('name').eq('id', actor.id).maybeSingle();
  await notify(actor.org_id, approver_id, 'New leave request',
    `${(me as any)?.name || 'A team member'} requested ${days} day(s) ${(type as any).name} (${body.from_date}${body.from_date !== body.to_date ? '–' + body.to_date : ''})`,
    { type: 'leave_request', request_id: (data as any).id });
  return data;
}

export async function myRequests(org_id: string, user_id: string, limit = 100) {
  const { data, error } = await supabaseAdmin
    .from('leave_requests').select('*').eq('org_id', org_id).eq('user_id', user_id)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(data ?? [], { types: true });
}

export async function cancelLeave(actor: Actor, id: string) {
  const { data: req } = await supabaseAdmin.from('leave_requests').select('*').eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!req) throw new AppError(404, 'Request not found', 'NOT_FOUND');
  if ((req as any).user_id !== actor.id) throw new AppError(403, 'Not your request', 'FORBIDDEN');
  if (!['pending', 'approved'].includes((req as any).status)) throw new AppError(400, 'Only pending/approved leave can be cancelled', 'BAD_STATE');
  // Return the updated row (not `{ok:true}`) so typed clients — notably iOS,
  // which decodes the response as a LeaveRequest — don't fail to decode and
  // report a false failure (the leave WAS cancelled server-side).
  const { data: updated } = await supabaseAdmin
    .from('leave_requests')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  // Remove any attendance placeholders we created for an approved leave.
  if ((req as any).status === 'approved') await clearAttendanceForLeave(id);
  await notify(actor.org_id, (req as any).approver_id, 'Leave cancelled', `A leave request was cancelled by the applicant.`, { type: 'leave_cancelled', request_id: id });
  return updated ?? { ...(req as any), status: 'cancelled' };
}

const ADMIN_ROLES = ['admin', 'super_admin', 'main_admin', 'org_admin', 'sub_admin', 'client'];
function isAdmin(role?: string | null) { return ADMIN_ROLES.includes((role ?? '').toLowerCase()); }

/** Requests awaiting the caller's decision (their reports) + any if admin. */
export async function pendingForApprover(actor: Actor, limit = 200) {
  let q = supabaseAdmin.from('leave_requests').select('*').eq('org_id', actor.org_id).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(limit);
  if (!isAdmin(actor.role)) q = q.eq('approver_id', actor.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(data ?? [], { users: true, types: true });
}

export async function decide(actor: Actor, id: string, decision: 'approved' | 'rejected', note?: string) {
  const { data: req } = await supabaseAdmin.from('leave_requests').select('*').eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!req) throw new AppError(404, 'Request not found', 'NOT_FOUND');
  if ((req as any).status !== 'pending') throw new AppError(400, 'Already decided', 'BAD_STATE');
  if (!isAdmin(actor.role) && (req as any).approver_id !== actor.id) throw new AppError(403, 'You are not the approver for this request', 'FORBIDDEN');

  const { error } = await supabaseAdmin.from('leave_requests').update({
    status: decision, decided_by: actor.id, decided_at: new Date().toISOString(), decision_note: note ?? null, updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB');

  // Stitch into attendance: an approved leave marks those days "on leave" so
  // the attendance sheet stops reading them as absent.
  if (decision === 'approved') await markAttendanceOnLeave(req);

  await notify(actor.org_id, (req as any).user_id, `Leave ${decision}`,
    `Your leave request (${(req as any).from_date}) was ${decision}${note ? ': ' + note : '.'}`,
    { type: 'leave_decision', request_id: id, decision });
  return { ok: true, status: decision };
}

/** Team leaves overlapping [from,to] — for the manager calendar. */
export async function teamCalendar(actor: Actor, from: string, to: string) {
  let q = supabaseAdmin.from('leave_requests')
    .select('id, user_id, leave_type_id, from_date, to_date, half_day_start, half_day_end, days, status')
    .eq('org_id', actor.org_id).in('status', ['approved', 'pending'])
    .lte('from_date', to).gte('to_date', from);
  if (!isAdmin(actor.role)) q = q.eq('approver_id', actor.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(data ?? [], { users: true, types: true });
}

// ── year-end carry-forward (cron) ─────────────────────────────────────────
/**
 * Roll leftover balances into the next year. For the transition INTO `toYear`
 * (from toYear-1): for every active user in every org that has leave types,
 * compute the prior-year leftover per type, cap it at the type's
 * `max_carry_forward`, and write it as `leave_balances.opening` for `toYear`.
 *
 * Idempotent — the unique key (org_id,user_id,leave_type_id,year) means a
 * re-run overwrites the same opening rather than duplicating it. Types with
 * `max_carry_forward = 0` (e.g. sick leave that shouldn't accumulate) are
 * skipped entirely, so their opening stays 0 and the balance resets.
 */
export async function runCarryForward(toYear: number): Promise<{ orgs: number; users: number; rows: number }> {
  const fromYear = toYear - 1;
  const { data: typeOrgs } = await supabaseAdmin
    .from('leave_types').select('org_id').eq('is_active', true);
  const orgIds = Array.from(new Set((typeOrgs ?? []).map((t: any) => t.org_id)));

  let users = 0, rows = 0;
  for (const org_id of orgIds) {
    const carryTypes = (await listTypes(org_id, null)).filter((t: any) => Number(t.max_carry_forward) > 0);
    if (!carryTypes.length) continue;

    const { data: us } = await supabaseAdmin
      .from('users').select('id, client_id').eq('org_id', org_id).eq('is_active', true);
    for (const u of us ?? []) {
      users++;
      const prev = await balances(org_id, (u as any).id, (u as any).client_id ?? null, fromYear);
      const upserts = carryTypes.map((t: any) => {
        const b = prev.find((x) => x.leave_type_id === t.id);
        const leftover = b ? Math.max(0, b.available) : 0;
        return {
          org_id, user_id: (u as any).id, leave_type_id: t.id, year: toYear,
          opening: Math.min(leftover, Number(t.max_carry_forward)),
          updated_at: new Date().toISOString(),
        };
      }).filter((r) => r.opening > 0);
      if (!upserts.length) continue;
      const { error } = await supabaseAdmin
        .from('leave_balances')
        .upsert(upserts, { onConflict: 'org_id,user_id,leave_type_id,year', ignoreDuplicates: false });
      if (error) logger.warn(`[leave] carry-forward upsert failed org=${org_id} user=${(u as any).id}: ${error.message}`);
      else rows += upserts.length;
    }
  }
  logger.info(`[leave] carry-forward → ${toYear}: ${orgIds.length} org(s), ${users} user(s), ${rows} balance row(s)`);
  return { orgs: orgIds.length, users, rows };
}
