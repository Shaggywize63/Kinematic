import { db, fail, fetchAll, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, invalid, newId, notFound, now, refuse } from '../payroll/common';
import { holidayListOut } from './mapping';
import { validateHoliday, validateHolidayList } from './validation';

// Holiday lists (per state and year). The rules are the dashboard's (components/hrms/time/HolidaysTab.tsx + timeLogic.ts
// validateHolidayList / validateHoliday), with its words. A list a location still uses cannot be deleted.

const T = 'hrms_holiday_lists';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

const allLists = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(T).select('id,name,state,year'), s).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to));

const normHolidays = (v: unknown): Row[] =>
  (Array.isArray(v) ? v : []).map((h) => ({ date: String((h as Row).date ?? ''), name: String((h as Row).name ?? ''), optional: !!(h as Row).optional }));

/** The effective list columns from a source object, and the list's year (for per-holiday checks). */
function listColumns(src: Row): { columns: Row; year: number; name: string; state: string } {
  const name = String(src.name ?? '').trim();
  const state = String(src.state ?? '').trim();
  const year = Number(src.year);
  const holidays = normHolidays(src.holidays);
  return { columns: { name, state, year, holidays }, year, name, state };
}

function checkAll(columns: { name: string; state: string; year: number; holidays: Row[] }, others: Row[]): void {
  const meta = validateHolidayList({ name: columns.name, state: columns.state, year: columns.year }, others.map((o) => ({ name: String(o.name ?? ''), state: String(o.state ?? ''), year: Number(o.year) })));
  if (meta) throw invalid(meta);
  for (const h of columns.holidays) {
    const problem = validateHoliday({ date: String(h.date ?? ''), name: String(h.name ?? '') }, columns.year);
    if (problem) throw invalid(problem);
  }
}

export async function createHolidayList(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: holidayListOut(existing), created: false };
  }
  const { columns } = listColumns(input);
  checkAll(columns as { name: string; state: string; year: number; holidays: Row[] }, await allLists(s));
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: holidayListOut(r.row), created: r.created };
}

export async function updateHolidayList(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Holiday list not found');
  const merged: Row = { ...current };
  for (const k of ['name', 'state', 'year', 'holidays'] as const) if (patch[k] !== undefined) merged[k] = patch[k];
  const { columns } = listColumns(merged);
  const others = (await allLists(s)).filter((o) => String(o.id) !== id);
  checkAll(columns as { name: string; state: string; year: number; holidays: Row[] }, others);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return holidayListOut(res.data as Row);
}

export async function deleteHolidayList(s: HrmsScope, id: string): Promise<{ id: string }> {
  const list = await find(s, id);
  if (!list) throw notFound('Holiday list not found');
  const name = String(list.name ?? '');
  const locs = await fetchAll<Row>((from, to) => scoped(db().from('hrms_locations').select('name'), s).eq('holiday_list_id', id).order('name', { ascending: true }).range(from, to));
  if (locs.length) {
    const names = locs.map((l) => String(l.name)).join(', ');
    throw refuse(409, `${name} is the holiday list of ${names}. Pick another list for ${locs.length === 1 ? 'that location' : 'those locations'} first.`, 'IN_USE');
  }
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}

export const listHolidayLists = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).order('year', { ascending: true }).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to));
