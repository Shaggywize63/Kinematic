import { db, fail, fetchAll, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, invalid, newId, notFound, now, refuse } from '../payroll/common';
import { leaveTypeOut } from './mapping';
import { validateLeave, type LeaveCheck } from './validation';

// Leave types (policies). The rules are the dashboard's (components/hrms/time/LeaveTab.tsx + timeLogic.ts validateLeave), with its
// words. code is uppercased and unique per org; a type that still has balances cannot be deleted.

const T = 'hrms_leave_types';

const blank = (v: unknown): boolean => v === undefined || v === null || v === '';
const optInt = (v: unknown): number | null => (blank(v) ? null : Number(v));

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

const allTypes = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(T).select('id,name,code'), s).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to));

/** The effective leave-type columns from a source object (create: the request; update: current merged with the patch). */
function leaveColumns(src: Row): { check: LeaveCheck; columns: Row } {
  const a = (src.accrual && typeof src.accrual === 'object' ? src.accrual : {}) as Row;
  const cf = (src.carry_forward && typeof src.carry_forward === 'object' ? src.carry_forward : {}) as Row;
  const en = (src.encashment && typeof src.encashment === 'object' ? src.encashment : {}) as Row;
  const name = String(src.name ?? '').trim();
  const code = String(src.code ?? '').trim().toUpperCase();
  const accrual = { mode: (a.mode ?? 'none') as LeaveCheck['accrual']['mode'], days: Number(a.days ?? 0), afterMonths: Number(a.afterMonths ?? 0) };
  const carryForward = { allowed: !!cf.allowed, maxDays: Number(cf.maxDays ?? 0), expiryMonths: Number(cf.expiryMonths ?? 0) };
  const encashment = { allowed: !!en.allowed, maxDays: Number(en.maxDays ?? 0), onExit: !!en.onExit };
  const maxConsecutiveDays = optInt(src.max_consecutive_days);
  const documentAfterDays = optInt(src.document_after_days);
  const check: LeaveCheck = { name, code, accrual, carryForward, encashment, maxConsecutiveDays, documentAfterDays };
  const columns: Row = {
    name, code, paid: src.paid === undefined ? true : !!src.paid, audience: src.audience ?? 'all',
    accrual, carry_forward: carryForward, encashment, max_consecutive_days: maxConsecutiveDays, document_after_days: documentAfterDays,
    probation_eligible: src.probation_eligible === undefined ? true : !!src.probation_eligible,
    include_weekly_offs: src.include_weekly_offs === undefined ? false : !!src.include_weekly_offs,
    description: blank(src.description) ? null : String(src.description),
  };
  return { check, columns };
}

export async function createLeaveType(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: leaveTypeOut(existing), created: false };
  }
  const { check, columns } = leaveColumns(input);
  const others = (await allTypes(s)).map((o) => ({ name: String(o.name ?? ''), code: String(o.code ?? '') }));
  const problem = validateLeave(check, others);
  if (problem) throw invalid(problem);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id),
    (e) => (e.code === '23505' && /org_code/.test(e.message ?? '') ? invalid(`${columns.code} is already used by another leave type`) : undefined));
  return { row: leaveTypeOut(r.row), created: r.created };
}

export async function updateLeaveType(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Leave type not found');
  const merged: Row = { ...current };
  for (const k of ['name', 'code', 'paid', 'audience', 'accrual', 'carry_forward', 'encashment', 'max_consecutive_days', 'document_after_days', 'probation_eligible', 'include_weekly_offs', 'description'] as const) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const { check, columns } = leaveColumns(merged);
  const others = (await allTypes(s)).filter((o) => String(o.id) !== id).map((o) => ({ name: String(o.name ?? ''), code: String(o.code ?? '') }));
  const problem = validateLeave(check, others);
  if (problem) throw invalid(problem);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) {
    if (res.error.code === '23505' && /org_code/.test(res.error.message ?? '')) throw invalid(`${columns.code} is already used by another leave type`);
    throw fail(res.error);
  }
  return leaveTypeOut(res.data as Row);
}

export async function deleteLeaveType(s: HrmsScope, id: string): Promise<{ id: string }> {
  const type = await find(s, id);
  if (!type) throw notFound('Leave type not found');
  const name = String(type.name ?? '');
  const rows = await fetchAll<Row>((from, to) => scoped(db().from('hrms_leave_balances').select('employee_id'), s).eq('leave_type_id', id).order('employee_id', { ascending: true }).range(from, to));
  const n = new Set(rows.map((r) => String(r.employee_id))).size;
  if (n > 0) {
    throw refuse(409, `${n} employee${n === 1 ? ' holds a balance' : 's hold balances'} in ${name}. Deleting the type would orphan ${n === 1 ? 'it' : 'them'}. Change the policy instead, for example stop accrual.`, 'IN_USE');
  }
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}

export const listLeaveTypes = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to));
