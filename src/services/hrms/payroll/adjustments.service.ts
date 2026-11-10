import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from './common';
import { adjustmentInfo, fmtMonth, validateAdjustment } from './engine';
import type { AdjustmentKind } from './engine';
import { adjustmentOut, emptyDb, toEngineEmployee } from './mapping';
import { EMPLOYEE_COLUMNS } from './mapping';
import { insertIdempotent, invalid, newId, notFound, now, refuse } from './common';
import { closedRun } from './attendance.service';

// One-time pay and deductions in a month. The rules are payrollActions.ts saveAdjustment / deleteAdjustment and logic.ts validateAdjustment,
// with their words:
//   - the amount is above zero, at most one crore, and whole rupees; the note is at most 80 characters;
//   - the person must be on that month's payroll, or the adjustment would never be paid;
//   - once a frozen or paid run covers the person's legal entity and month, adjustments for it are closed (and so is editing or deleting one
//     that belongs to it).
// Only the kinds that earn can be taxable; the amount is rounded to whole rupees as saveAdjustment does.

const T = 'hrms_adjustments';
const find = async (s: HrmsScope, id: string): Promise<Row | null> => must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

async function employeeRow(s: HrmsScope, id: string): Promise<Row | null> {
  return must(await scoped(db().from('hrms_employees').select(EMPLOYEE_COLUMNS), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
}

/** Throws the first field problem the dashboard's validateAdjustment finds. The run lock is checked after, with saveAdjustment's wording. */
async function validate(s: HrmsScope, d: { employee_id: string; month: string; kind: AdjustmentKind; amount: number; note: string | null }): Promise<Row> {
  const emp = await employeeRow(s, d.employee_id);
  const db_ = emptyDb();
  if (emp) db_.employees = [toEngineEmployee(emp)];
  // payRuns stays empty: validateAdjustment's own lock message is the screen's wording; the server uses saveAdjustment's below
  const err = validateAdjustment(db_, { employeeId: d.employee_id, month: d.month, kind: d.kind, amount: String(d.amount), taxable: false, note: d.note ?? '' });
  const first = err.employeeId ?? err.month ?? err.amount ?? err.note;
  if (first) throw invalid(first);
  return emp as Row;
}

async function assertOpen(s: HrmsScope, entityId: string, month: string, orig?: Row | null, origEntityId?: string): Promise<void> {
  const target = await closedRun(s, entityId, month);
  if (target) throw refuse(409, `The ${fmtMonth(String(target.month))} run is ${target.status}. Adjustments for it are closed.`, 'MONTH_LOCKED');
  if (orig && origEntityId) {
    const origLock = await closedRun(s, origEntityId, String(orig.month));
    if (origLock) throw refuse(409, `This adjustment belongs to the ${fmtMonth(String(origLock.month))} run, which is ${origLock.status}.`, 'MONTH_LOCKED');
  }
}

export async function createAdjustment(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: adjustmentOut(existing), created: false };
  }
  const emp = await validate(s, { employee_id: input.employee_id, month: input.month, kind: input.kind, amount: input.amount, note: input.note ?? null });
  await assertOpen(s, String(emp.entity_id), String(input.month));
  const info = adjustmentInfo(input.kind as AdjustmentKind);
  const r = await insertIdempotent(s, T, {
    id, employee_id: input.employee_id, month: input.month, kind: input.kind, amount: Math.round(input.amount),
    taxable: info.effect === 'earning' ? !!input.taxable : false, note: input.note ?? null, source: input.source ?? null, created_by: s.actor,
  }, !!input.id, () => find(s, id));
  return { row: adjustmentOut(r.row), created: r.created };
}

export async function updateAdjustment(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Adjustment not found');
  const merged = {
    employee_id: (patch.employee_id ?? current.employee_id) as string, month: (patch.month ?? current.month) as string, kind: (patch.kind ?? current.kind) as AdjustmentKind,
    amount: (patch.amount ?? Number(current.amount)) as number, taxable: patch.taxable !== undefined ? !!patch.taxable : !!current.taxable,
    note: (patch.note !== undefined ? patch.note : current.note) as string | null,
  };
  const emp = await validate(s, merged);
  const origEmp = merged.employee_id === current.employee_id ? emp : await employeeRow(s, String(current.employee_id));
  await assertOpen(s, String(emp.entity_id), merged.month, current, String(origEmp?.entity_id ?? emp.entity_id));
  const info = adjustmentInfo(merged.kind);
  const res = await scoped(db().from(T).update({
    employee_id: merged.employee_id, month: merged.month, kind: merged.kind, amount: Math.round(merged.amount),
    taxable: info.effect === 'earning' ? merged.taxable : false, note: merged.note ?? null, updated_at: now(),
  }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return adjustmentOut(res.data as Row);
}

export async function deleteAdjustment(s: HrmsScope, id: string): Promise<{ id: string }> {
  const orig = await find(s, id);
  if (!orig) throw notFound('Adjustment not found');
  const emp = await employeeRow(s, String(orig.employee_id));
  const lock = emp ? await closedRun(s, String(emp.entity_id), String(orig.month)) : null;
  if (lock) throw refuse(409, `The ${fmtMonth(String(lock.month))} run is ${lock.status}. This adjustment cannot be deleted.`, 'MONTH_LOCKED');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
