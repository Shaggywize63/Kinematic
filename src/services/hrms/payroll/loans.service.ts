import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from './common';
import { validateLoan } from './engine';
import type { Loan } from './engine';
import { emptyDb, loanOut } from './mapping';
import { findEmployee, insertIdempotent, invalid, newId, notFound, now, refuse } from './common';

// Loans and advances. The rules are logic.ts validateLoan and payrollActions.ts deleteLoan, with their words. `recovered` is never written
// here: it starts at 0 and only moves when a pay run is frozen (the amount recovered) or unfrozen (given back).

const T = 'hrms_loans';
const find = async (s: HrmsScope, id: string): Promise<Row | null> => must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

async function validate(s: HrmsScope, d: { employee_id: string; kind: Loan['kind']; principal: number; emi: number; start_month: string; note: string | null }): Promise<void> {
  const emp = await findEmployee(s, d.employee_id);
  const model = emptyDb();
  if (emp) model.employees = [{ id: String(emp.id) } as never];
  const err = validateLoan(model, {
    employeeId: d.employee_id, kind: d.kind, principal: String(d.principal), emi: String(d.emi), startMonth: d.start_month, note: d.note ?? '',
  });
  const first = err.employeeId ?? err.principal ?? err.emi ?? err.startMonth ?? err.note;
  if (first) throw invalid(first);
  // Whole rupees only. The payslip deducts the EMI rounded to the rupee (the engine's r0) while a freeze adds the EMI to
  // `recovered` as it is stored, so a fractional EMI or amount would drift the loan balance month by month.
  for (const [label, v] of [['principal', d.principal], ['emi', d.emi]] as const) {
    if (!Number.isInteger(v)) throw invalid(label === 'principal' ? 'Enter the amount lent in whole rupees.' : 'Enter the EMI in whole rupees.');
  }
}

export async function createLoan(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: loanOut(existing), created: false };
  }
  await validate(s, { employee_id: input.employee_id, kind: input.kind, principal: input.principal, emi: input.emi, start_month: input.start_month, note: input.note ?? null });
  const r = await insertIdempotent(s, T, {
    id, employee_id: input.employee_id, kind: input.kind, principal: input.principal, emi: input.emi, start_month: input.start_month, recovered: 0, note: input.note ?? null,
  }, !!input.id, () => find(s, id));
  return { row: loanOut(r.row), created: r.created };
}

export async function updateLoan(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Loan not found');
  const merged = {
    employee_id: (patch.employee_id ?? current.employee_id) as string, kind: (patch.kind ?? current.kind) as Loan['kind'],
    principal: (patch.principal ?? Number(current.principal)) as number, emi: (patch.emi ?? Number(current.emi)) as number,
    start_month: (patch.start_month ?? current.start_month) as string, note: (patch.note !== undefined ? patch.note : current.note) as string | null,
  };
  await validate(s, merged);
  const recovered = Number(current.recovered);
  if (merged.employee_id !== current.employee_id && recovered > 0) throw refuse(409, 'Part of this loan has been recovered through payroll, so it cannot move to another employee.', 'IN_USE');
  if (merged.principal < recovered) throw refuse(409, `The amount lent cannot be less than the ${recovered} already recovered through payroll.`, 'IN_USE');
  const res = await scoped(db().from(T).update({
    employee_id: merged.employee_id, kind: merged.kind, principal: merged.principal, emi: merged.emi, start_month: merged.start_month, note: merged.note ?? null, updated_at: now(),
  }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return loanOut(res.data as Row);
}

export async function deleteLoan(s: HrmsScope, id: string): Promise<{ id: string }> {
  const l = await find(s, id);
  if (!l) throw notFound('Loan not found');
  if (Number(l.recovered) > 0) throw refuse(409, 'Part of this loan has been recovered through payroll, so it cannot be deleted.', 'IN_USE');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
