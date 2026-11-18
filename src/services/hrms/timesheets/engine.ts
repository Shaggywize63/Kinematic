// Timesheet rules, reproduced from the dashboard's lib/hrms/people/timesheetEngine.ts + timesheetActions.ts with the same
// words, so a refusal from the server reads exactly like the one the page would have shown. Pure functions.

export interface SheetLine { projectId: string; hours: number[] }
export type SheetStatus = 'draft' | 'submitted' | 'approved' | 'returned';
export interface Policy { maxPerDay: number; weeklyCap: number; standardWeek: number }

export const DEFAULT_POLICY: Policy = { maxPerDay: 12, weeklyCap: 60, standardWeek: 40 };
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** "7 Nov 2026", the dashboard's fmtDate. */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}
export function addDays(iso: string, n: number): string {
  const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export const isMonday = (iso: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(`${iso}T00:00:00Z`).getUTCDay() === 1;
export const weekDates = (weekStart: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

/** Today in India (the module's timezone), so a day that has started in IST is never "in the future" before 05:30 UTC. */
export function todayIst(now = Date.now()): string {
  return new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export const lineTotal = (l: SheetLine): number => round2(l.hours.reduce((t, h) => t + (Number.isFinite(h) ? h : 0), 0));
export const sheetTotal = (s: { lines: SheetLine[] }): number => round2(s.lines.reduce((t, l) => t + lineTotal(l), 0));
export const dayTotals = (s: { lines: SheetLine[] }): number[] =>
  Array.from({ length: 7 }, (_, d) => round2(s.lines.reduce((t, l) => t + (Number.isFinite(l.hours[d]) ? l.hours[d]! : 0), 0)));

/** A week can be edited while it is a draft or has been returned. Submitted and approved weeks are locked. */
export const isEditable = (status: SheetStatus | undefined | null): boolean => !status || status === 'draft' || status === 'returned';

/** The blocking problems with a week (the dashboard's validateSheet errors; the weekly-cap warning never blocks). */
export function sheetErrors(sheet: { lines: SheetLine[]; weekStart: string }, policy: Policy, today: string): string[] {
  const out: string[] = [];
  const dates = weekDates(sheet.weekStart);
  sheet.lines.forEach((l) => l.hours.forEach((h, d) => {
    if (!Number.isFinite(h) || h < 0) out.push(`${DAY_LABELS[d]}: hours must be a number from 0.`);
    else if (h > 0 && Math.abs(h * 4 - Math.round(h * 4)) > 1e-9) out.push(`${DAY_LABELS[d]}: use steps of 0.25 hour.`);
    else if (h > 0 && dates[d]! > today) out.push(`${DAY_LABELS[d]}: ${fmtDate(dates[d]!)} has not happened yet.`);
  }));
  dayTotals(sheet).forEach((t, d) => { if (t > policy.maxPerDay) out.push(`${DAY_LABELS[d]}: ${t} hours is above the ${policy.maxPerDay} hour daily limit.`); });
  return out;
}

/** Why a week cannot be submitted (empty = it can). The dashboard's submitCheck, reasons de-duplicated in order. */
export function submitReasons(sheet: { lines: SheetLine[]; weekStart: string; status?: SheetStatus | null }, policy: Policy, today: string): string[] {
  const reasons: string[] = [];
  if (!isEditable(sheet.status)) reasons.push(sheet.status === 'approved' ? 'This week is approved and locked.' : 'This week is already with the approver.');
  if (sheetTotal(sheet) <= 0) reasons.push('Enter some hours before submitting.');
  reasons.push(...sheetErrors(sheet, policy, today));
  return [...new Set(reasons)];
}

/** The dashboard's setPolicy ranges, with its words. */
export function policyError(p: Policy): string | null {
  if (!(p.maxPerDay >= 8 && p.maxPerDay <= 24)) return 'The daily limit must be between 8 and 24 hours.';
  if (!(p.weeklyCap >= 20 && p.weeklyCap <= 90)) return 'The weekly cap must be between 20 and 90 hours.';
  if (!(p.standardWeek >= 20 && p.standardWeek <= p.weeklyCap)) return 'The standard week must be at least 20 hours and not above the weekly cap.';
  return null;
}

/** A line's hours as exactly seven finite numbers (missing days are 0). */
export const normaliseHours = (hours: unknown): number[] =>
  Array.from({ length: 7 }, (_, i) => { const n = Number(Array.isArray(hours) ? hours[i] : 0); return Number.isFinite(n) ? n : 0; });
