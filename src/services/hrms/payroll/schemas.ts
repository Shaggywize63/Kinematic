import { z } from 'zod';
import { isRealDate } from '../schemas';

// Request validation for the payroll API. Top-level keys are snake_case; nested objects (structure components, the overtime rule)
// keep the dashboard's own camelCase shape. zod only checks the TYPES here; the rules whose words the dashboard already has
// ("Whole rupees only", "Loss of pay is 0 to 31 days...") are applied in the services so the reason is the dashboard's, unprefixed.

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const COMPONENT_KINDS = ['earning', 'deduction', 'employer', 'reimbursement'] as const;
export const CALC_TYPES = ['fixed', 'pct_basic', 'pct_ctc', 'balance', 'pf_employer', 'esi_employer', 'gratuity_provision'] as const;
export const ADJUSTMENT_KIND_VALUES = ['arrear', 'bonus', 'incentive', 'reimbursement', 'one_time_deduction', 'loan_emi', 'advance_recovery'] as const;
export const LOAN_KINDS = ['loan', 'advance'] as const;
export const RUN_TYPES = ['regular', 'offcycle'] as const;
export const RUN_STATUSES = ['draft', 'computed', 'frozen', 'paid'] as const;
export const EMPLOYMENT_TYPE_VALUES = ['permanent', 'fixed_term', 'contract', 'intern', 'daily_wage'] as const;

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuid = z.string().uuid('Must be an id');
const num = z.number({ invalid_type_error: 'Must be a number', required_error: 'Required' }).finite('Must be a number');
const text = (max: number) => z.string().max(max, `At most ${max} characters`);
const optText = (max: number) => z.preprocess(blank, text(max).nullable().optional());

// ── salary structures ───────────────────────────────────────────────────────
const component = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  code: text(40),
  name: text(120),
  kind: z.enum(COMPONENT_KINDS),
  calc: z.object({ type: z.enum(CALC_TYPES), value: num.optional() }),
  isWage: z.boolean().optional(),
  taxable: z.boolean().optional(),
  pfApplicable: z.boolean().optional(),
  esiApplicable: z.boolean().optional(),
  prorate: z.boolean().optional(),
  showInPayslip: z.boolean().optional(),
});
export type ComponentIn = z.infer<typeof component>;

export const structureCreate = z.object({
  id: uuid.optional(),
  name: text(100),
  description: optText(500),
  effective_from: z.string(),
  components: z.array(component).max(60, 'At most 60 components'),
});
export const structureUpdate = structureCreate.omit({ id: true }).partial();

// ── attendance ──────────────────────────────────────────────────────────────
export const attendancePatch = z.object({
  lop_days: num.optional(),
  overtime_hours: num.optional(),
  present_days: num.optional(),
  paid_leave_days: num.optional(),
  weekly_offs: num.optional(),
  holidays: num.optional(),
  locked: z.boolean().optional(),
});

// ── adjustments ─────────────────────────────────────────────────────────────
export const adjustmentCreate = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  month: z.string(),
  kind: z.enum(ADJUSTMENT_KIND_VALUES),
  amount: num,
  taxable: z.boolean().optional(),
  note: optText(1000),
  source: optText(60),
});
export const adjustmentUpdate = adjustmentCreate.omit({ id: true, source: true }).partial();

// ── loans ───────────────────────────────────────────────────────────────────
export const loanCreate = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  kind: z.enum(LOAN_KINDS),
  principal: num,
  emi: num,
  start_month: z.string(),
  note: optText(1000),
});
export const loanUpdate = loanCreate.omit({ id: true }).partial();

// ── runs ────────────────────────────────────────────────────────────────────
export const runCreate = z.object({
  id: uuid.optional(),
  entity_id: uuid,
  month: z.string().regex(MONTH_RE, 'Month must be YYYY-MM'),
  type: z.enum(RUN_TYPES).optional(),
});
export const unfreezeBody = z.object({ reason: z.string({ required_error: 'A reason is required' }).max(500, 'The reason is at most 500 characters') });
export const runQuery = z.object({
  entity_id: uuid.optional(),
  month: z.string().regex(MONTH_RE, 'Month must be YYYY-MM').optional(),
  status: z.enum(RUN_STATUSES).optional(),
  type: z.enum(RUN_TYPES).optional(),
});

// ── full and final ──────────────────────────────────────────────────────────
export const fnfCreate = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  last_working_date: z.string(),
  resignation_date: z.preprocess(blank, z.string().nullable().optional()),
  notice_days_served: num,
  leave_encash_days: num,
  other_recoveries: num.optional(),
  other_payments: num.optional(),
});
export const fnfUpdate = fnfCreate.omit({ id: true, employee_id: true }).partial();

// ── settings ────────────────────────────────────────────────────────────────
export const overtimeRuleSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string({ required_error: 'Rule name is required' }),
  rateMultiplier: num,
  quarterlyCapHours: num,
  requiresConsent: z.boolean(),
  minMinutes: num,
  rateDivisor: z.union([z.literal(26), z.literal(30), z.literal('calendar')], { errorMap: () => ({ message: 'rateDivisor must be 26, 30 or "calendar"' }) }),
  womenNightConsent: z.boolean(),
  appliesTo: z.array(z.enum(EMPLOYMENT_TYPE_VALUES)).max(5),
});

/** The body of PUT settings/payroll, however the caller wraps the rule: { overtime_rule }, { value: { overtime_rule } } or { payroll: { overtime_rule } }. */
export const payrollSettingsBody = z.preprocess((raw) => {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rule = o.overtime_rule ?? o.value?.overtime_rule ?? o.payroll?.overtime_rule ?? (o.value && typeof o.value === 'object' && 'rateMultiplier' in o.value ? o.value : undefined);
  return { overtime_rule: rule };
}, z.object({ overtime_rule: overtimeRuleSchema }));

export const monthsQuery = z.coerce.number().int().min(1, 'months must be 1 to 60').max(60, 'months must be 1 to 60');

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && isRealDate(s);
