import { db, fetchAll, HrmsScope, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { balanceOut, holidayListOut, leaveTypeOut, rosterOut, shiftOut } from './mapping';

// Everything Time & Leave needs for the org in one call: shifts, the whole roster, leave types, holiday lists and leave balances.
// Attendance and the overtime rule are NOT here -- they come from the payroll bootstrap (phase 2).

export async function timeBootstrap(s: HrmsScope) {
  const list = (table: string, orders: string[]) =>
    fetchAll<Row>((from, to) => {
      let q = scoped(db().from(table).select('*'), s);
      for (const o of orders) q = q.order(o, { ascending: true });
      return q.range(from, to);
    });
  const [shifts, roster, leaveTypes, holidayLists, balances] = await Promise.all([
    list('hrms_shifts', ['name', 'id']),
    list('hrms_roster', ['week_start', 'employee_id', 'id']),
    list('hrms_leave_types', ['name', 'id']),
    list('hrms_holiday_lists', ['year', 'name', 'id']),
    list('hrms_leave_balances', ['employee_id', 'leave_type_id', 'id']),
  ]);
  return {
    shifts: shifts.map(shiftOut),
    roster: roster.map(rosterOut),
    leave_types: leaveTypes.map(leaveTypeOut),
    holiday_lists: holidayLists.map(holidayListOut),
    leave_balances: balances.map(balanceOut),
    server_time: new Date().toISOString(),
  };
}
