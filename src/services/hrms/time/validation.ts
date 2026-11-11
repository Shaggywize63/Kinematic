// Write-time validation for Time & Leave, reproducing EXACTLY the rules and the plain messages the dashboard shows today
// (kinematic-dashboard/src/components/hrms/time/timeLogic.ts: validateShift, validateLeave, validateHolidayList, validateHoliday).
// Only the blocking errors are enforced here (the dashboard's warnings never stop a save); the first failing check is the one
// returned, so the API answers with the dashboard's own words. Pure functions, no database access.

// ── shift time arithmetic (timeLogic.ts, verbatim) ───────────────────────────
export const toMinutes = (hhmm: string): number => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
/** A shift that ends before it starts runs past midnight. */
export const crossesMidnight = (start: string, end: string): boolean => {
  const s = toMinutes(start); const e = toMinutes(end);
  return !Number.isNaN(s) && !Number.isNaN(e) && e < s;
};
/** Minutes between start and end, rolling over midnight when the end is earlier. Zero for equal or invalid times. */
export function spanMinutes(start: string, end: string): number {
  const s = toMinutes(start); const e = toMinutes(end);
  if (Number.isNaN(s) || Number.isNaN(e) || s === e) return 0;
  return e > s ? e - s : e + 1440 - s;
}
export const paidMinutes = (s: { start: string; end: string; breakMinutes: number }): number =>
  Math.max(0, spanMinutes(s.start, s.end) - (s.breakMinutes || 0));
function durationText(min: number): string {
  const h = Math.floor(min / 60); const m = Math.round(min % 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}
const trimNum = (n: number): string => String(Math.round(n * 100) / 100);
const isInt = (n: number) => Number.isInteger(n);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

// ── shifts ───────────────────────────────────────────────────────────────────
export interface ShiftCheck { name: string; start: string; end: string; breakMinutes: number; graceMinutes: number; fullDayHours: number; halfDayHours: number }

/** The first problem validateShift would flag, or null. `others` are the org's OTHER shifts (the one being edited excluded). */
export function validateShift(f: ShiftCheck, others: { name: string }[]): string | null {
  const name = f.name.trim();
  if (!name) return 'Shift name is required';
  if (name.length > 40) return 'Shift name is too long (40 characters at most)';
  if (others.some((o) => o.name.trim().toLowerCase() === name.toLowerCase())) return `There is already a shift called ${name}`;
  if (Number.isNaN(toMinutes(f.start))) return 'Enter a start time';
  if (Number.isNaN(toMinutes(f.end))) return 'Enter an end time';
  const span = spanMinutes(f.start, f.end);
  if (span === 0) return 'Start and end cannot be the same time';
  const brk = num(f.breakMinutes); const grace = num(f.graceMinutes); const full = num(f.fullDayHours); const half = num(f.halfDayHours);
  if (Number.isNaN(brk) || !isInt(brk) || brk < 0 || brk > 240) return 'Break is 0 to 240 whole minutes';
  if (span > 0 && brk >= span) return 'The break is as long as the whole shift';
  if (Number.isNaN(grace) || !isInt(grace) || grace < 0 || grace > 120) return 'Grace is 0 to 120 whole minutes';
  if (Number.isNaN(full) || full < 1 || full > 16) return 'Full day is 1 to 16 hours';
  if (span > 0 && full * 60 > span) return `A full day of ${trimNum(full)} h is longer than the ${durationText(span)} on duty`;
  if (Number.isNaN(half) || half <= 0) return 'Half day must be more than 0 hours';
  if (half >= full) return 'Half day must be less than a full day';
  return null;
}

// ── leave types ──────────────────────────────────────────────────────────────
export interface LeaveCheck {
  name: string; code: string;
  accrual: { mode: 'none' | 'monthly' | 'yearly' | 'on_joining'; days: number; afterMonths: number };
  carryForward: { allowed: boolean; maxDays: number; expiryMonths: number };
  encashment: { allowed: boolean; maxDays: number; onExit: boolean };
  maxConsecutiveDays?: number | null;
  documentAfterDays?: number | null;
}

/** The first problem validateLeave would flag, or null. `others` are the org's OTHER leave types. */
export function validateLeave(f: LeaveCheck, others: { name: string; code: string }[]): string | null {
  const name = f.name.trim();
  const code = f.code.trim().toUpperCase();
  if (!name) return 'Leave type name is required';
  if (others.some((o) => o.name.trim().toLowerCase() === name.toLowerCase())) return `There is already a leave type called ${name}`;
  if (!code) return 'Code is required';
  if (!/^[A-Z0-9]{1,6}$/.test(code)) return 'Code is 1 to 6 letters or digits, like EL';
  if (others.some((o) => o.code.toUpperCase() === code)) return `${code} is already used by another leave type`;

  if (f.accrual.mode !== 'none') {
    const days = num(f.accrual.days);
    if (Number.isNaN(days) || days <= 0) return 'Enter how many days are credited';
    if (f.accrual.mode === 'monthly' && days > 31) return 'A month cannot earn more than 31 days';
    if (days > 366) return 'That is more than a year of days';
    const after = num(f.accrual.afterMonths);
    if (Number.isNaN(after) || !isInt(after) || after < 0 || after > 60) return 'Months of service is 0 to 60';
  }
  if (f.carryForward.allowed) {
    const m = num(f.carryForward.maxDays); const x = num(f.carryForward.expiryMonths);
    if (Number.isNaN(m) || m < 0) return 'Enter 0 or more days (0 means no limit)';
    if (Number.isNaN(x) || !isInt(x) || x < 0 || x > 120) return 'Expiry is 0 to 120 months (0 means never)';
  }
  if (f.encashment.allowed || f.encashment.onExit) {
    const m = num(f.encashment.maxDays);
    if (Number.isNaN(m) || m <= 0) return 'Enter the most days that can be encashed';
  }
  if (f.documentAfterDays !== undefined && f.documentAfterDays !== null) {
    const d = f.documentAfterDays;
    if (!isInt(d) || d < 1 || d > 365) return 'Whole days, 1 to 365';
  }
  if (f.maxConsecutiveDays !== undefined && f.maxConsecutiveDays !== null) {
    const d = f.maxConsecutiveDays;
    if (!isInt(d) || d < 1 || d > 365) return 'Whole days, 1 to 365';
  }
  return null;
}

// ── holiday lists ────────────────────────────────────────────────────────────
const isRealDate = (d: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** The first problem validateHolidayList would flag, or null. `lists` are the org's OTHER holiday lists. */
export function validateHolidayList(f: { name: string; state: string; year: number }, lists: { name: string; state: string; year: number }[]): string | null {
  const year = num(f.year);
  if (!f.state || !f.state.trim()) return 'Choose a state';
  if (!isInt(year) || year < 2000 || year > 2100) return 'Year is 2000 to 2100';
  if (!f.name.trim()) return 'List name is required';
  if (lists.some((l) => l.name.trim().toLowerCase() === f.name.trim().toLowerCase())) return 'A list with this name exists';
  if (lists.some((l) => l.state === f.state && l.year === year)) return `A ${f.state} list for ${year} already exists. Edit that one instead`;
  return null;
}

/** The first problem validateHoliday would flag for one holiday in a list of the given year, or null. */
export function validateHoliday(h: { date: string; name: string }, listYear: number): string | null {
  if (!h.date) return 'Pick a date';
  if (!isRealDate(h.date)) return 'Enter a valid date';
  if (Number(h.date.slice(0, 4)) !== listYear) return `This list is for ${listYear}. Pick a date in ${listYear}`;
  if (!h.name.trim()) return 'Holiday name is required';
  if (h.name.trim().length > 60) return 'Name is too long (60 characters at most)';
  return null;
}
