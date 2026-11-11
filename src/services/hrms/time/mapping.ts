import type { Row } from '../payroll/common';

// Rows -> the wire. Pure functions, no database access. Top-level keys snake_case, null for "nothing"; the nested objects
// (accrual, carry_forward, encashment, each holiday) are rebuilt in the dashboard's documented key order so jsonb's key-length
// sorting never scrambles them, exactly as the payroll mapping does for payslip lines and wages.

export const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => !!v;

// ── shifts ─────────────────────────────────────────────────────────────────
export const shiftOut = (r: Row): Row => ({
  id: r.id, name: r.name, start: r.start, end: r.end, break_minutes: num(r.break_minutes), grace_minutes: num(r.grace_minutes),
  full_day_hours: num(r.full_day_hours), half_day_hours: num(r.half_day_hours), is_night: bool(r.is_night), color: r.color ?? null,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── roster ─────────────────────────────────────────────────────────────────
export const rosterOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, week_start: iso(r.week_start),
  days: Array.isArray(r.days) ? r.days.map(String) : [],
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── leave types ──────────────────────────────────────────────────────────────
const accrualOut = (v: unknown): Row => {
  const a = (v && typeof v === 'object' ? v : {}) as Row;
  return { mode: a.mode ?? 'none', days: num(a.days), afterMonths: num(a.afterMonths) };
};
const carryForwardOut = (v: unknown): Row => {
  const c = (v && typeof v === 'object' ? v : {}) as Row;
  return { allowed: bool(c.allowed), maxDays: num(c.maxDays), expiryMonths: num(c.expiryMonths) };
};
const encashmentOut = (v: unknown): Row => {
  const e = (v && typeof v === 'object' ? v : {}) as Row;
  return { allowed: bool(e.allowed), maxDays: num(e.maxDays), onExit: bool(e.onExit) };
};
const optInt = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export const leaveTypeOut = (r: Row): Row => ({
  id: r.id, name: r.name, code: r.code, paid: bool(r.paid), audience: r.audience ?? 'all',
  accrual: accrualOut(r.accrual), carry_forward: carryForwardOut(r.carry_forward), encashment: encashmentOut(r.encashment),
  max_consecutive_days: optInt(r.max_consecutive_days), document_after_days: optInt(r.document_after_days),
  probation_eligible: bool(r.probation_eligible), include_weekly_offs: bool(r.include_weekly_offs), description: r.description ?? null,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── holiday lists ──────────────────────────────────────────────────────────
const holidayOut = (h: Row): Row => ({ date: String(h.date), name: String(h.name), optional: bool(h.optional) });
export const holidayListOut = (r: Row): Row => ({
  id: r.id, name: r.name, state: r.state, year: num(r.year),
  holidays: Array.isArray(r.holidays) ? r.holidays.map(holidayOut) : [],
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── leave balances ───────────────────────────────────────────────────────────
export const balanceOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, leave_type_id: r.leave_type_id,
  opening: num(r.opening), accrued: num(r.accrued), taken: num(r.taken), encashed: num(r.encashed), lapsed: num(r.lapsed),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});
