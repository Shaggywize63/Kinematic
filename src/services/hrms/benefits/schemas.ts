import { z } from 'zod';
import { isRealDate } from '../schemas';

// Request validation for the Benefits API (phase 7). Top-level keys are snake_case; the nested shapes (plan tiers,
// employer_share_pct, dependant rules, baskets, enrolment dependants / flex) keep the dashboard's own camelCase shape and
// pass through. zod only checks the TYPES/enums here; the plain-sentence rules whose words the dashboard already has
// (eligibility, the dependant-rule messages, "Choose a health cover amount, or choose to opt out.", the claim-amount and
// rejection messages, "The enrolment window is closed. HR can extend it.", "Extend by 1 to 30 days.", ...) are applied in
// the services so the reason is the dashboard's, unprefixed.

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuid = z.string().uuid('Must be an id');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').refine(isRealDate, 'Not a real calendar date');
const num = z.number({ invalid_type_error: 'Must be a number', required_error: 'Required' }).finite('Must be a number');
const text = (max: number) => z.string().max(max, `At most ${max} characters`);
const optText = (max: number) => z.preprocess(blank, z.string().max(max, `At most ${max} characters`).nullable().optional());

export const PLAN_KINDS = ['health', 'accident', 'meal', 'nps', 'flex'] as const;
export const CLAIM_STATUSES = ['submitted', 'in_review', 'query', 'approved', 'settled', 'rejected'] as const;
export const CLAIM_RELATIONS = ['self', 'spouse', 'child', 'parent'] as const;
export const CLAIM_KINDS = ['cashless', 'reimbursement'] as const;
export const ENROL_STATUSES = ['enrolled', 'waived'] as const;

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && isRealDate(s);
export const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

// ── plans ───────────────────────────────────────────────────────────────────
// The arithmetic shapes pass through in the dashboard's camelCase; zod checks the kind enum and the loose shapes. The
// premium maths is reproduced by the ported engine, not re-validated here.
const shareMap = z.record(z.number().finite()).refine((v) => Object.keys(v).length <= 8, 'Too many share keys');
const planTier = z.object({
  id: z.string().min(1).max(60),
  label: text(120),
  sumInsured: z.number().finite().nonnegative().optional(),
  annualPremium: z.record(z.number().finite()).optional(),
  monthlyAmount: z.number().finite().nonnegative().optional(),
  pctOfBasic: z.number().finite().nonnegative().optional(),
}).passthrough();
const dependantRules = z.object({
  maxSpouse: z.number().int().min(0).max(20),
  maxChildren: z.number().int().min(0).max(20),
  childMaxAge: z.number().int().min(0).max(120),
  maxParents: z.number().int().min(0).max(20),
  parentMaxAge: z.number().int().min(0).max(120),
}).passthrough();
const basket = z.object({ id: z.string().min(1).max(60), label: text(120) }).passthrough();

export const planBody = z.object({
  id: uuid.optional(),
  kind: z.enum(PLAN_KINDS),
  name: text(160),
  summary: optText(4000),
  provider: optText(200),
  auto: z.boolean().optional(),
  tiers: z.array(planTier).max(50, 'At most 50 tiers').optional(),
  employer_share_pct: shareMap.optional(),
  dependants: z.preprocess(blank, dependantRules.nullable().optional()),
  flex_monthly: z.preprocess(blank, z.number().finite().nonnegative().nullable().optional()),
  baskets: z.preprocess(blank, z.array(basket).max(50).nullable().optional()),
  tax_note: optText(4000),
  cover_start: dateStr,
  renews_on: dateStr,
});
export const planUpdate = planBody.omit({ id: true }).partial();

// ── enrolments (submitEnrolment) ──────────────────────────────────────────────
const dependantInput = z.object({
  id: z.string().min(1).max(80).optional(),
  name: text(120),
  relation: z.enum(['spouse', 'child', 'parent']),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
}).passthrough();

export const enrolmentBody = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  status: z.enum(ENROL_STATUSES),
  health_tier: optText(60),
  dependants: z.array(dependantInput).max(20, 'At most 20 dependants').optional(),
  meal_tier: optText(60),
  nps_tier: optText(60),
  flex: z.preprocess((v) => (v == null ? {} : v), z.record(z.number().finite()).refine((m) => Object.keys(m).length <= 50, 'Too many baskets')),
});

// ── claims ────────────────────────────────────────────────────────────────────
export const claimCreate = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  patient: text(120),
  relation: z.enum(CLAIM_RELATIONS),
  kind: z.enum(CLAIM_KINDS),
  hospital: text(200),
  claimed: num,
});

export const claimMove = z.object({
  to: z.enum(CLAIM_STATUSES),
  note: optText(2000),
  approved: z.preprocess(blank, z.number().finite().nullable().optional()),
  reason: optText(2000),
});

// ── window, reminders, send-to-payroll ────────────────────────────────────────
export const windowBody = z.object({ opens_on: dateStr, closes_on: dateStr });
export const windowExtendBody = z.object({ days: num, reason: z.preprocess((v) => (v == null ? '' : v), text(500)) });

/** { employee_ids: [...] } (the dashboard's logReminders ids); the camelCase employeeIds spelling is accepted too. */
export const remindersBody = z.preprocess((v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = { ...(v as Record<string, unknown>) };
    if ('employeeIds' in o && !('employee_ids' in o)) o.employee_ids = o.employeeIds;
    delete o.employeeIds;
    return o;
  }
  return v;
}, z.object({ employee_ids: z.array(uuid).max(5000, 'Too many people').optional() }));

export const sendToPayrollBody = z.object({ month: z.string().regex(MONTH_RE, 'Month must be YYYY-MM') });

export type PlanBodyIn = z.infer<typeof planBody>;
export type EnrolmentBodyIn = z.infer<typeof enrolmentBody>;
export type ClaimCreateIn = z.infer<typeof claimCreate>;
export type ClaimMoveIn = z.infer<typeof claimMove>;
