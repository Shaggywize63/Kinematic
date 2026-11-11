import { db, fetchAll, HrmsScope, isNotReady, scoped } from '../scope';
import type { Row } from './common';
import type { HrmsDb } from './engine';
import {
  EMPLOYEE_COLUMNS, emptyDb, toEngineAdjustment, toEngineAttendance, toEngineEmployee, toEngineLoan, toEngineLocation, toEngineShift, toEngineStructure,
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

/**
 * Shifts come from the phase-3 time migration, which deploys independently of payroll: a payroll-only database has no hrms_shifts table
 * yet. So this one read tolerates "not ready" and yields no shifts (the engine then falls back to 8 hour days), rather than making every
 * payroll call 503. Any other error still surfaces.
 */
async function loadShifts(s: HrmsScope): Promise<Row[]> {
  try {
    return await all('hrms_shifts', 'id,name,start,end,break_minutes,grace_minutes,full_day_hours,half_day_hours,is_night,color', s, ['name', 'id']);
  } catch (e) {
    if (isNotReady(e as { code?: string; message?: string }) || (e as { code?: string })?.code === 'HRMS_NOT_READY') return [];
    throw e;
  }
}

export async function loadPayrollDb(s: HrmsScope, opts: LoadOptions = {}): Promise<HrmsDb> {
  const months = opts.months && opts.months.length ? [...new Set(opts.months)] : null;
  const byMonth = months ? (q: any) => q.in('month', months) : undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [employees, structures, shifts, locations, entities, attendance, adjustments, loans, runs, rule] = await Promise.all([
    all('hrms_employees', EMPLOYEE_COLUMNS, s, ['code', 'id'], (q) => q.is('deleted_at', null)),
    all('hrms_structures', '*', s, ['created_at', 'id']),
    // shifts give each employee their real full-day hours (engine: db.shifts.find(s => s.id === e.shiftId)?.fullDayHours ?? 8)
    loadShifts(s),
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
  d.shifts = shifts.map(toEngineShift);
  d.locations = locations.map(toEngineLocation);
  d.entities = entities.map((e) => ({ id: String(e.id), name: String(e.name), registrations: Array.isArray(e.registrations) ? e.registrations : [] })) as unknown as HrmsDb['entities'];
  d.attendance = attendance.map(toEngineAttendance);
  d.adjustments = adjustments.map(toEngineAdjustment);
  d.loans = loans.map(toEngineLoan);
  d.payRuns = runs.map((r) => ({ id: String(r.id), entityId: String(r.entity_id), month: String(r.month), type: r.type, status: r.status, payslips: [], audit: [] })) as unknown as HrmsDb['payRuns'];
  d.overtimeRules = [rule];
  return d;
}
