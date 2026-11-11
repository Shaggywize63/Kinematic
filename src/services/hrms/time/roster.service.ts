import { db, fail, fetchAll, HrmsScope, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { isRealDate } from '../schemas';
import { rosterOut } from './mapping';

// The weekly roster. PUT /time/roster/:employeeId/:weekStart upserts one week-row: week_start must be a Monday, and each of the 7
// cells is 'off' or one of the org's shift ids. The bulk operations (add a set of employees, copy the previous week) are composed
// from per-row PUTs on the client, so there is no bulk endpoint here.

const T = 'hrms_roster';

/** Monday = 1 in getUTCDay()'s Sunday-is-0 numbering. */
const isMonday = (d: string): boolean => new Date(`${d}T00:00:00Z`).getUTCDay() === 1;

const liveEmployee = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;

const shiftIds = async (s: HrmsScope): Promise<Set<string>> => {
  const rows = await fetchAll<Row>((from, to) => scoped(db().from('hrms_shifts').select('id'), s).order('id', { ascending: true }).range(from, to));
  return new Set(rows.map((r) => String(r.id)));
};

export async function putRoster(s: HrmsScope, employeeId: string, weekStart: string, days: string[]): Promise<Row> {
  if (!isRealDate(weekStart)) throw invalid('week_start: Date must be YYYY-MM-DD');
  if (!isMonday(weekStart)) throw invalid('The week must start on a Monday.');
  if (!(await liveEmployee(s, employeeId))) throw notFound('Employee not found');
  if (days.length !== 7) throw invalid('A roster week has 7 days, Monday to Sunday');
  const known = await shiftIds(s);
  for (const cell of days) {
    if (cell !== 'off' && !known.has(cell)) throw invalid('Each day must be one of your shifts or a weekly off.');
  }
  const res = await db().from(T).upsert(
    { ...scopeCols(s), employee_id: employeeId, week_start: weekStart, days, updated_at: now() },
    { onConflict: 'org_id,employee_id,week_start' },
  ).select('*').single();
  if (res.error) throw fail(res.error);
  return rosterOut(res.data as Row);
}
