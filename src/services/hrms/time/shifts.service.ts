import { db, fail, fetchAll, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, invalid, newId, notFound, now, refuse } from '../payroll/common';
import { shiftOut } from './mapping';
import { crossesMidnight, validateShift, type ShiftCheck } from './validation';

// Shifts. The rules are the dashboard's (components/hrms/time/ShiftsTab.tsx + timeLogic.ts validateShift), with its words: the server
// is the authority and the UI shows the reason it gives. is_night is derived from the times (a shift that ends before it starts runs
// past midnight), never trusted from the request.

const T = 'hrms_shifts';

const DEFAULTS = { break_minutes: 0, grace_minutes: 0, full_day_hours: 8, half_day_hours: 4, color: '#3E9EFF' };
const defNum = (v: unknown, d: number): number => (v === undefined || v === null || v === '' ? d : Number(v));

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

/** Every shift of the org (id + name), to check the name is not already taken. */
const allShifts = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(T).select('id,name'), s).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to));

/** The effective shift columns from a request (create: the whole thing; update: current merged with the patch). */
function shiftColumns(src: Row): { check: ShiftCheck; columns: Row } {
  const name = String(src.name ?? '').trim();
  const start = String(src.start ?? '');
  const end = String(src.end ?? '');
  const breakMinutes = defNum(src.break_minutes, DEFAULTS.break_minutes);
  const graceMinutes = defNum(src.grace_minutes, DEFAULTS.grace_minutes);
  const fullDayHours = defNum(src.full_day_hours, DEFAULTS.full_day_hours);
  const halfDayHours = defNum(src.half_day_hours, DEFAULTS.half_day_hours);
  const color = src.color === undefined || src.color === null || src.color === '' ? DEFAULTS.color : String(src.color);
  const check: ShiftCheck = { name, start, end, breakMinutes, graceMinutes, fullDayHours, halfDayHours };
  const columns: Row = {
    name, start, end, break_minutes: breakMinutes, grace_minutes: graceMinutes, full_day_hours: fullDayHours,
    half_day_hours: halfDayHours, is_night: crossesMidnight(start, end), color,
  };
  return { check, columns };
}

export async function createShift(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: shiftOut(existing), created: false };
  }
  const { check, columns } = shiftColumns(input);
  const others = (await allShifts(s)).map((o) => ({ name: String(o.name ?? '') }));
  const problem = validateShift(check, others);
  if (problem) throw invalid(problem);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: shiftOut(r.row), created: r.created };
}

export async function updateShift(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Shift not found');
  const merged: Row = { ...current };
  for (const k of ['name', 'start', 'end', 'break_minutes', 'grace_minutes', 'full_day_hours', 'half_day_hours', 'color'] as const) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const { check, columns } = shiftColumns(merged);
  const others = (await allShifts(s)).filter((o) => String(o.id) !== id).map((o) => ({ name: String(o.name ?? '') }));
  const problem = validateShift(check, others);
  if (problem) throw invalid(problem);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return shiftOut(res.data as Row);
}

/** How many roster day cells across the org still name this shift (an exact count, like the dashboard's usage()). */
async function rosterDaysUsing(s: HrmsScope, id: string): Promise<number> {
  const rows = await fetchAll<Row>((from, to) => scoped(db().from('hrms_roster').select('days'), s).order('id', { ascending: true }).range(from, to));
  return rows.reduce((t, r) => t + (Array.isArray(r.days) ? r.days.filter((d: unknown) => d === id).length : 0), 0);
}

export async function deleteShift(s: HrmsScope, id: string): Promise<{ id: string }> {
  const shift = await find(s, id);
  if (!shift) throw notFound('Shift not found');
  const name = String(shift.name ?? '');
  const { count, error } = await scoped(db().from('hrms_employees').select('id', { count: 'exact', head: true }), s)
    .eq('shift_id', id).is('deleted_at', null).neq('status', 'exited');
  if (error) throw fail(error);
  const employees = count ?? 0;
  const rosterDays = await rosterDaysUsing(s, id);
  if (employees || rosterDays) {
    const parts = [
      employees ? `${employees} employee${employees === 1 ? '' : 's'} as their shift` : '',
      rosterDays ? `${rosterDays} roster day${rosterDays === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    throw refuse(409, `${name} is still used by ${parts.join(' and ')}. Move them to another shift first, then delete it.`, 'IN_USE');
  }
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}

export const listShifts = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to));
