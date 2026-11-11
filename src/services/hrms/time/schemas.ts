import { z } from 'zod';

// Request validation for the Time & Leave API. Top-level keys are snake_case; the nested objects (accrual, carry_forward, encashment,
// each holiday) keep the dashboard's own camelCase shape and pass through. zod only checks the TYPES here; the rules whose words the
// dashboard already has ("Full day is 1 to 16 hours", "Code is 1 to 6 letters or digits, like EL", ...) are applied in the services
// (via ./validation) so the reason is the dashboard's, unprefixed.

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuid = z.string().uuid('Must be an id');
const asNumber = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
const num = z.preprocess(asNumber, z.number({ invalid_type_error: 'Must be a number' }).finite('Must be a number'));
const optNum = num.optional();
const bool = z.boolean();
const text = (max: number) => z.string().max(max, `At most ${max} characters`);
const optText = (max: number) => z.preprocess(blank, text(max).nullable().optional());
const optInt = z.preprocess((v) => (v === '' ? null : asNumber(v)), z.number({ invalid_type_error: 'Must be a whole number' }).int('Must be a whole number').nullable().optional());

export const AUDIENCES = ['all', 'female', 'male'] as const;
export const ACCRUAL_MODES = ['none', 'monthly', 'yearly', 'on_joining'] as const;

// ── shifts ────────────────────────────────────────────────────────────────────
export const shiftCreate = z.object({
  id: uuid.optional(),
  name: text(80),
  start: text(10),
  end: text(10),
  break_minutes: optNum,
  grace_minutes: optNum,
  full_day_hours: optNum,
  half_day_hours: optNum,
  is_night: bool.optional(), // derived from the times by the service; accepted but ignored
  color: optText(32),
});
export const shiftUpdate = shiftCreate.omit({ id: true }).partial();

// ── roster ──────────────────────────────────────────────────────────────────
export const rosterPut = z.object({
  days: z.array(z.string().max(80)).length(7, 'A roster week has 7 days, Monday to Sunday'),
});

// ── leave types ───────────────────────────────────────────────────────────────
const accrual = z.object({ mode: z.enum(ACCRUAL_MODES), days: num, afterMonths: num });
const carryForward = z.object({ allowed: bool, maxDays: num, expiryMonths: num });
const encashment = z.object({ allowed: bool, maxDays: num, onExit: bool });

export const leaveTypeCreate = z.object({
  id: uuid.optional(),
  name: text(100),
  code: text(16),
  paid: bool.optional(),
  audience: z.enum(AUDIENCES).optional(),
  accrual,
  carry_forward: carryForward,
  encashment,
  max_consecutive_days: optInt,
  document_after_days: optInt,
  probation_eligible: bool.optional(),
  include_weekly_offs: bool.optional(),
  description: optText(2000),
});
export const leaveTypeUpdate = leaveTypeCreate.omit({ id: true }).partial();

// ── holiday lists ─────────────────────────────────────────────────────────────
// date / name may arrive blank or missing; ./validation owns the plain "Pick a date" / "Holiday name is required" wording.
const holiday = z.object({
  date: z.preprocess((v) => (v == null ? '' : v), text(10)),
  name: z.preprocess((v) => (v == null ? '' : v), text(100)),
  optional: bool.optional(),
}).passthrough();

export const holidayListCreate = z.object({
  id: uuid.optional(),
  name: text(100),
  state: text(100),
  year: z.preprocess(asNumber, z.number({ invalid_type_error: 'Must be a whole number' }).int('Must be a whole number')),
  holidays: z.array(holiday).max(400, 'At most 400 holidays').optional(),
});
export const holidayListUpdate = holidayListCreate.omit({ id: true }).partial();

// ── leave balances ────────────────────────────────────────────────────────────
export const balancePut = z.object({
  opening: optNum,
  accrued: optNum,
  taken: optNum,
  encashed: optNum,
  lapsed: optNum,
});
