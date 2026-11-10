import { db, fetchAll, HrmsScope, scoped } from '../scope';
import type { Row } from './common';
import type { HrmsDb } from './engine';
import {
  EMPLOYEE_COLUMNS, emptyDb, toEngineAdjustment, toEngineAttendance, toEngineEmployee, toEngineLoan, toEngineLocation, toEngineStructure,
} from './mapping';
import { getOvertimeRule } from './settings.service';

// Loads what the engine reads, for the caller's org, into the engine's own model (an HrmsDb with only those collections filled).
// Nothing is decrypted: payroll needs to know whether a PAN / bank account is on file, never its value.

export interface LoadOptions {
  /** Only these months of attendance and adjustments (YYYY-MM). Omit for every month. */
  months?: string[];
  /** Also load the runs' status (for the "earlier run not closed" check): no payslips, just id / entity / month / type / status. */
  withRuns?: boolean;
}

const all = (table: string, cols: string, s: HrmsScope, order: string[] = ['id'], refine?: (q: any) => any) => // eslint-disable-line @typescript-eslint/no-explicit-any
  fetchAll<Row>((from, to) => {
    let q = scoped(db().from(table).select(cols), s);
    if (refine) q = refine(q);
    for (const o of order) q = q.order(o, { ascending: true });
    return q.range(from, to);
  });

export async function loadPayrollDb(s: HrmsScope, opts: LoadOptions = {}): Promise<HrmsDb> {
  const months = opts.months && opts.months.length ? [...new Set(opts.months)] : null;
  const byMonth = months ? (q: any) => q.in('month', months) : undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [employees, structures, locations, entities, attendance, adjustments, loans, runs, rule] = await Promise.all([
    all('hrms_employees', EMPLOYEE_COLUMNS, s, ['code', 'id'], (q) => q.is('deleted_at', null)),
    all('hrms_structures', '*', s, ['created_at', 'id']),
    all('hrms_locations', 'id,entity_id,name,state,city,metro', s),
    all('hrms_entities', 'id,name,registrations', s),
    all('hrms_attendance', '*', s, ['month', 'employee_id'], byMonth),
    all('hrms_adjustments', '*', s, ['created_at', 'id'], byMonth),
    all('hrms_loans', '*', s, ['created_at', 'id']),
    opts.withRuns ? all('hrms_pay_runs', 'id,entity_id,month,type,status', s, ['month', 'id']) : Promise.resolve([] as Row[]),
    getOvertimeRule(s),
  ]);
  const d = emptyDb();
  d.employees = employees.map(toEngineEmployee);
  d.structures = structures.map(toEngineStructure);
  d.locations = locations.map(toEngineLocation);
  d.entities = entities.map((e) => ({ id: String(e.id), name: String(e.name), registrations: Array.isArray(e.registrations) ? e.registrations : [] })) as unknown as HrmsDb['entities'];
  d.attendance = attendance.map(toEngineAttendance);
  d.adjustments = adjustments.map(toEngineAdjustment);
  d.loans = loans.map(toEngineLoan);
  d.payRuns = runs.map((r) => ({ id: String(r.id), entityId: String(r.entity_id), month: String(r.month), type: r.type, status: r.status, payslips: [], audit: [] })) as unknown as HrmsDb['payRuns'];
  d.overtimeRules = [rule];
  return d;
}
