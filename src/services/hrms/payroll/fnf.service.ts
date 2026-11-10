import { db, fail, HrmsScope, isUniqueViolation, must, scoped } from '../scope';
import type { Row } from './common';
import { addWorkingDays, computeFnf, LABOUR_CODES, validateFnf } from './engine';
import type { FnfResult } from './engine';
import { emptyDb, fnfOut, EMPLOYEE_COLUMNS, toEngineEmployee, toEngineFnf, toEngineLoan, toEngineLocation, toEngineStructure } from './mapping';
import { insertIdempotent, invalid, newId, notFound, now, refuse } from './common';
import { isDate } from './schemas';

// Full and final settlements. The rules are logic.ts validateFnf and payrollActions.ts approveFnf / markFnfPaid / deleteFnf, with their words.
// due_by is not the caller's to set: it is the last working day plus the Code on Wages' two working days. The earned-leave balance check of
// validateFnf is skipped (leave balances are not on the server yet). One OPEN settlement per employee, as the dashboard's candidate list
// ("without a case already") implies; a paid one does not block a later case.

const T = 'hrms_fnf_cases';
const find = async (s: HrmsScope, id: string): Promise<Row | null> => must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;
const stateError = (message: string) => refuse(409, message, 'FNF_STATE');

type Fields = { employee_id: string; last_working_date: string; resignation_date: string | null; notice_days_served: number; leave_encash_days: number; other_recoveries: number; other_payments: number };

async function validate(s: HrmsScope, f: Fields): Promise<void> {
  const emp = must(await scoped(db().from('hrms_employees').select('id,join_date'), s).eq('id', f.employee_id).is('deleted_at', null).maybeSingle()) as Row | null;
  const model = emptyDb();
  if (emp) model.employees = [{ id: String(emp.id), joinDate: String(emp.join_date) } as never];
  const err = validateFnf(model, {
    employeeId: f.employee_id, lastWorkingDate: f.last_working_date, resignationDate: f.resignation_date ?? '', noticeDaysServed: String(f.notice_days_served),
    leaveEncashDays: String(f.leave_encash_days), otherRecoveries: String(f.other_recoveries), otherPayments: String(f.other_payments),
  });
  const first = err.employeeId ?? err.lastWorkingDate ?? err.resignationDate ?? err.noticeDaysServed ?? err.leaveEncashDays ?? err.otherRecoveries ?? err.otherPayments;
  if (first) throw invalid(first);
  // the regexes above accept 2026-02-31; the database does not
  if (!isDate(f.last_working_date)) throw invalid('Enter the last working day');
  if (f.resignation_date && !isDate(f.resignation_date)) throw invalid('Enter a valid date');
}

export async function createFnf(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: fnfOut(existing), created: false };
  }
  const f: Fields = {
    employee_id: input.employee_id, last_working_date: input.last_working_date, resignation_date: input.resignation_date ?? null,
    notice_days_served: input.notice_days_served, leave_encash_days: input.leave_encash_days, other_recoveries: input.other_recoveries ?? 0, other_payments: input.other_payments ?? 0,
  };
  await validate(s, f);
  const open = must(await scoped(db().from(T).select('id'), s).eq('employee_id', f.employee_id).neq('status', 'paid').limit(1)) as Row[] | null;
  if (open?.length) throw stateError('A settlement is already open for this employee.');
  const r = await insertIdempotent(s, T, { id, ...f, status: 'draft', due_by: addWorkingDays(f.last_working_date, LABOUR_CODES.settlementWorkingDays) }, !!input.id, () => find(s, id),
    (e) => (isUniqueViolation(e, 'hrms_fnf_cases_open_uq') ? stateError('A settlement is already open for this employee.') : undefined));
  return { row: fnfOut(r.row), created: r.created };
}

export async function updateFnf(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Case not found');
  if (current.status !== 'draft') throw stateError('Only a draft settlement can be edited.');
  const f: Fields = {
    employee_id: String(current.employee_id), last_working_date: (patch.last_working_date ?? String(current.last_working_date)) as string,
    resignation_date: (patch.resignation_date !== undefined ? patch.resignation_date : current.resignation_date) as string | null,
    notice_days_served: (patch.notice_days_served ?? Number(current.notice_days_served)) as number, leave_encash_days: (patch.leave_encash_days ?? Number(current.leave_encash_days)) as number,
    other_recoveries: (patch.other_recoveries ?? Number(current.other_recoveries)) as number, other_payments: (patch.other_payments ?? Number(current.other_payments)) as number,
  };
  await validate(s, f);
  const res = await scoped(db().from(T).update({ ...f, due_by: addWorkingDays(f.last_working_date, LABOUR_CODES.settlementWorkingDays), updated_at: now() }), s)
    .eq('id', id).eq('status', 'draft').select('*');
  if (res.error) throw fail(res.error);
  const row = (res.data as Row[] | null)?.[0];
  if (!row) throw stateError('Only a draft settlement can be edited.'); // approved between our read and write
  return fnfOut(row);
}

/** draft -> approved (approveFnf) */
export async function approveFnf(s: HrmsScope, id: string): Promise<Row> {
  const c = await find(s, id);
  if (!c) throw notFound('Case not found');
  if (c.status !== 'draft') throw stateError('Only a draft settlement can be approved.');
  return moveTo(s, id, 'draft', 'approved', 'Only a draft settlement can be approved.');
}

/** approved -> paid (markFnfPaid) */
export async function markFnfPaid(s: HrmsScope, id: string): Promise<Row> {
  const c = await find(s, id);
  if (!c) throw notFound('Case not found');
  if (c.status !== 'approved') throw stateError('Approve the settlement before marking it paid.');
  return moveTo(s, id, 'approved', 'paid', 'Approve the settlement before marking it paid.');
}

async function moveTo(s: HrmsScope, id: string, from: string, to: string, reason: string): Promise<Row> {
  const res = await scoped(db().from(T).update({ status: to, updated_at: now() }), s).eq('id', id).eq('status', from).select('*');
  if (res.error) throw fail(res.error);
  const row = (res.data as Row[] | null)?.[0];
  if (!row) throw stateError(reason); // another call moved it first
  return fnfOut(row);
}

export async function deleteFnf(s: HrmsScope, id: string): Promise<{ id: string }> {
  const c = await find(s, id);
  if (!c) throw notFound('Case not found');
  if (c.status !== 'draft') throw stateError('Only a draft settlement can be deleted.');
  const del = await scoped(db().from(T).delete(), s).eq('id', id).eq('status', 'draft').select('id');
  if (del.error) throw fail(del.error);
  if (!(del.data as Row[] | null)?.length) throw stateError('Only a draft settlement can be deleted.');
  return { id };
}

/** The engine's settlement for a case, as it is today (computeFnf's result as is; null when the person has no structure, CTC or location). */
export async function computeFnfFor(s: HrmsScope, id: string): Promise<FnfResult | null> {
  const c = await find(s, id);
  if (!c) throw notFound('Case not found');
  const emp = must(await scoped(db().from('hrms_employees').select(EMPLOYEE_COLUMNS), s).eq('id', String(c.employee_id)).is('deleted_at', null).maybeSingle()) as Row | null;
  const model = emptyDb();
  if (emp) {
    model.employees = [toEngineEmployee(emp)];
    const [structure, location, loans] = await Promise.all([
      emp.structure_id ? must(await scoped(db().from('hrms_structures').select('*'), s).eq('id', String(emp.structure_id)).maybeSingle()) as Row | null : Promise.resolve(null),
      must(await scoped(db().from('hrms_locations').select('id,entity_id,name,state,city,metro'), s).eq('id', String(emp.location_id)).maybeSingle()) as Row | null,
      must(await scoped(db().from('hrms_loans').select('*'), s).eq('employee_id', String(emp.id)).order('created_at', { ascending: true }).order('id', { ascending: true })) as Row[] | null,
    ]);
    if (structure) model.structures = [toEngineStructure(structure)];
    if (location) model.locations = [toEngineLocation(location)];
    model.loans = (loans ?? []).map(toEngineLoan);
  }
  return computeFnf(model, toEngineFnf(c));
}

