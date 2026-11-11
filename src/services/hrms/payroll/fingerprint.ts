import crypto from 'crypto';
import { employeesForRun, LAW_VERSION } from './engine';
import type { HrmsDb, Month } from './engine';

// The input fingerprint of a run: a stable hash of everything the compute reads. A computed run stores the fingerprint of the inputs it was
// computed from; a run whose CURRENT inputs hash differently is stale (its payslips no longer match what a compute would give), and a freeze
// is refused until it is computed again.
//
// "Everything the compute read" is, for the run's entity and month:
//   - the employees who are on the run (employeesForRun) with every field the engine reads, including whether a PAN / bank account is on
//     file (a warning depends on it), but not their name, contact details or any value that is encrypted;
//   - the structures and locations those employees point at;
//   - the month's attendance (loss of pay, overtime hours) and adjustments for those people;
//   - their loans, with how much is recovered so far (a freeze of another run moves it);
//   - the stored shifts those people point at (their full-day hours drive the overtime hourly rate) and the default used when a person
//     has no / an unknown shift; the overtime rule; and the law version (a change of statutory rules makes old payslips stale).
// Fields the compute does NOT read (attendance "locked", the present / holiday counts, a person's address) are left out on purpose, so
// freezing a run, which locks attendance, does not make anything look stale.
//
// VERSION 2 adds the referenced shifts (phase 3 put shifts on the server, so each employee's full-day hours are now a real input and an
// edit to a shift makes a computed run stale). Runs computed under version 1 (default shift hours of 8) read stale after this change,
// which is correct: a recompute with real shift hours may differ, so they ask to be computed again before a freeze.

export const FINGERPRINT_VERSION = 2;
export const SERVER_SHIFT_HOURS = 8;

/** JSON with object keys sorted at every level: the same data always gives the same text. */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The inputs a compute of (month, entity) reads, as plain data. Exported for tests. */
export function payrollInputs(db: HrmsDb, month: Month, entityId: string) {
  const emps = employeesForRun(db, month, entityId);
  const ids = new Set(emps.map((e) => e.id));
  const structureIds = new Set(emps.map((e) => e.structureId).filter(Boolean));
  const locationIds = new Set(emps.map((e) => e.locationId));
  const shiftIds = new Set(emps.map((e) => e.shiftId).filter(Boolean));
  return {
    version: FINGERPRINT_VERSION, law: LAW_VERSION, month, entityId, defaultShiftHours: SERVER_SHIFT_HOURS, overtimeRule: db.overtimeRules[0] ?? null,
    // the full-day hours of the shifts the people on this run point at: an edit to one (same id, new hours) changes the hash -> stale
    shifts: db.shifts.filter((sh) => shiftIds.has(sh.id)).map((sh) => ({ id: sh.id, fullDayHours: sh.fullDayHours })).sort(byId),
    employees: emps.map((e) => ({
      id: e.id, entityId: e.entityId, status: e.status, joinDate: e.joinDate, lastWorkingDate: e.lastWorkingDate, structureId: e.structureId, annualCtc: e.annualCtc,
      locationId: e.locationId, shiftId: e.shiftId, employmentType: e.employmentType, gender: e.gender, taxRegime: e.taxRegime, declaration: e.declaration,
      pfMember: e.pfMember, pfOnActualWage: e.pfOnActualWage, structureOverrides: e.structureOverrides, uan: e.uan, uanStatus: e.uanStatus, esicIp: e.esicIp,
      ptApplicable: e.ptApplicable, lwfApplicable: e.lwfApplicable, hasPan: !!e.pan, hasBank: !!e.bank, payMode: e.payMode,
    })).sort(byId),
    structures: db.structures.filter((s) => structureIds.has(s.id)).map((s) => ({ id: s.id, components: s.components })).sort(byId),
    locations: db.locations.filter((l) => locationIds.has(l.id)).map((l) => ({ id: l.id, state: l.state, city: l.city, metro: l.metro })).sort(byId),
    // a row with no loss of pay and no overtime reads exactly like no row at all (`attendance?.lopDays ?? 0`), so it is left out: creating one is not a change
    attendance: db.attendance.filter((a) => a.month === month && ids.has(a.employeeId) && (a.lopDays !== 0 || a.overtimeHours !== 0))
      .map((a) => ({ id: a.employeeId, lopDays: a.lopDays, overtimeHours: a.overtimeHours })).sort(byId),
    adjustments: db.adjustments.filter((a) => a.month === month && ids.has(a.employeeId))
      .map((a) => ({ id: a.id, employeeId: a.employeeId, kind: a.kind, amount: a.amount, taxable: a.taxable, note: a.note })).sort(byId),
    loans: db.loans.filter((l) => ids.has(l.employeeId))
      .map((l) => ({ id: l.id, employeeId: l.employeeId, kind: l.kind, principal: l.principal, emi: l.emi, startMonth: l.startMonth, recovered: l.recovered })).sort(byId),
  };
}

/** sha256 (hex) of the canonical inputs of a compute of (month, entity) over `db`. */
export function inputFingerprint(db: HrmsDb, month: Month, entityId: string): string {
  return crypto.createHash('sha256').update(canonical(payrollInputs(db, month, entityId))).digest('hex');
}
