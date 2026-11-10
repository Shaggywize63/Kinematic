import { db, fetchAll, HrmsScope, scoped } from '../scope';
import type { Row } from './common';
import { addMonths } from './engine';
import { adjustmentOut, attendanceOut, fnfOut, loanOut, structureOut } from './mapping';
import { getPayrollSettings } from './settings.service';
import { runsWithPayslips } from './runs.service';

/** The month `months` months back, counting the current month as the first: months=12 in 2026-11 starts at 2025-12. */
export function windowStart(months: number, today = new Date()): string {
  const current = today.toISOString().slice(0, 7);
  return addMonths(current, -(months - 1));
}

/**
 * Everything payroll needs for the org in one call: the structures, loans and settlements (all of them), and the attendance, adjustments
 * and pay runs (with payslips) of the recent months. `stale` on each run is computed here, so the screen never has to compute a payslip.
 */
export async function payrollBootstrap(s: HrmsScope, months = 12) {
  const from = windowStart(months);
  const list = (table: string, orders: string[], refine?: (q: any) => any) => // eslint-disable-line @typescript-eslint/no-explicit-any
    fetchAll<Row>((a, b) => {
      let q = scoped(db().from(table).select('*'), s);
      if (refine) q = refine(q);
      for (const o of orders) q = q.order(o, { ascending: true });
      return q.range(a, b);
    });
  const [structures, attendance, adjustments, loans, runs, fnf, settings] = await Promise.all([
    list('hrms_structures', ['created_at', 'id']),
    list('hrms_attendance', ['month', 'employee_id'], (q) => q.gte('month', from)),
    list('hrms_adjustments', ['month', 'created_at', 'id'], (q) => q.gte('month', from)),
    list('hrms_loans', ['created_at', 'id']),
    runsWithPayslips(s, from),
    list('hrms_fnf_cases', ['created_at', 'id']),
    getPayrollSettings(s),
  ]);
  return {
    structures: structures.map(structureOut),
    attendance: attendance.map(attendanceOut),
    adjustments: adjustments.map(adjustmentOut),
    loans: loans.map(loanOut),
    runs,
    fnf_cases: fnf.map(fnfOut),
    settings,
    server_time: new Date().toISOString(),
  };
}
