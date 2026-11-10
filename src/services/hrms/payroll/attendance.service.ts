import { db, fail, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from './common';
import { daysInMonth, fmtMonth } from './engine';
import { attendanceOut } from './mapping';
import { findEmployee, invalid, newId, notFound, now, refuse } from './common';

// Monthly attendance inputs. The rules are payrollActions.ts setAttendance, with its words:
//   - loss of pay is 0 to the days of the month, in steps of half a day; overtime is 0 to 200 hours a month;
//   - once a frozen or paid run covers the person's legal entity and month, its inputs are locked;
//   - a month whose attendance is locked can only be changed after it is unlocked.

const T = 'hrms_attendance';

/** The frozen or paid run that covers this entity and month, if any (the first by creation). */
export async function closedRun(s: HrmsScope, entityId: string, month: string): Promise<Row | null> {
  const rows = must(await scoped(db().from('hrms_pay_runs').select('id,month,status,entity_id'), s)
    .eq('entity_id', entityId).eq('month', month).in('status', ['frozen', 'paid']).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1)) as Row[] | null;
  return rows?.[0] ?? null;
}

export const monthLocked = (month: string, status: string) => refuse(409, `The ${fmtMonth(month)} run is ${status}. Its inputs are locked.`, 'MONTH_LOCKED');

const COUNT_FIELDS = ['present_days', 'paid_leave_days', 'weekly_offs', 'holidays'] as const;
const INPUT_FIELDS = ['lop_days', 'overtime_hours', ...COUNT_FIELDS] as const;

export async function setAttendance(s: HrmsScope, employeeId: string, month: string, patch: Row): Promise<Row> {
  const days = daysInMonth(month);
  const lop = patch.lop_days as number | undefined;
  const ot = patch.overtime_hours as number | undefined;
  if (lop != null && (!(lop >= 0) || lop > days || Math.round(lop * 2) !== lop * 2)) throw invalid(`Loss of pay is 0 to ${days} days, in steps of half a day.`);
  if (ot != null && (!(ot >= 0) || ot > 200)) throw invalid('Overtime is 0 to 200 hours a month.');
  for (const f of COUNT_FIELDS) {
    const v = patch[f] as number | undefined;
    if (v != null && (!(v >= 0) || v > days || Math.round(v * 2) !== v * 2)) throw invalid(`${f.replace(/_/g, ' ')} is 0 to ${days} days, in steps of half a day.`);
  }

  const emp = await findEmployee(s, employeeId);
  if (!emp) throw notFound('Employee not found');
  const closed = await closedRun(s, String(emp.entity_id), month);
  if (closed) throw monthLocked(month, String(closed.status));

  const current = must(await scoped(db().from(T).select('*'), s).eq('employee_id', employeeId).eq('month', month).maybeSingle()) as Row | null;
  const changesInputs = INPUT_FIELDS.some((f) => patch[f] != null);
  if (current?.locked && changesInputs) throw refuse(409, "This month's attendance is locked. Unlock it in Attendance first.", 'MONTH_LOCKED');

  const values: Row = {};
  for (const f of INPUT_FIELDS) if (patch[f] != null) values[f] = patch[f];
  if (patch.locked !== undefined) values.locked = patch.locked;

  if (current) {
    if (!Object.keys(values).length) return attendanceOut(current);
    const res = await scoped(db().from(T).update({ ...values, updated_at: now() }), s).eq('id', String(current.id)).select('*').single();
    if (res.error) throw fail(res.error);
    return attendanceOut(res.data as Row);
  }

  // No row yet: the dashboard's defaults (a full month present, nothing else) with the patch on top.
  const fresh = {
    id: newId(), ...scopeCols(s), employee_id: employeeId, month, days_in_month: days, present_days: days, paid_leave_days: 0, weekly_offs: 0, holidays: 0,
    lop_days: 0, overtime_hours: 0, locked: false, ...values,
  };
  const ins = await db().from(T).insert(fresh).select('*').single();
  if (ins.error) {
    if (isUniqueViolation(ins.error)) {
      // Someone created the row between our read and write: apply the patch to theirs.
      const theirs = must(await scoped(db().from(T).select('*'), s).eq('employee_id', employeeId).eq('month', month).maybeSingle()) as Row | null;
      if (theirs) {
        const res = await scoped(db().from(T).update({ ...values, updated_at: now() }), s).eq('id', String(theirs.id)).select('*').single();
        if (res.error) throw fail(res.error);
        return attendanceOut(res.data as Row);
      }
    }
    throw fail(ins.error);
  }
  return attendanceOut(ins.data as Row);
}
