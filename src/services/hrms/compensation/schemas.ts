import { z } from 'zod';
import { isRealDate } from '../schemas';
import { PERF_BANDS, COMPA_ZONES } from './engine';

// Request validation for the Compensation API (phase 8). zod checks TYPES / enums / ranges; the plain-sentence rules whose
// words the dashboard already has (validateBand's "Enter all four amounts...", validateGuideline's "Use values from 0 to
// 50 percent.", the cycle-state refusals, "Enter at least one proposed increment.", ...) are applied in the services so
// the reason is the dashboard's, unprefixed.

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuid = z.string().uuid('Must be an id');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').refine(isRealDate, 'Not a real calendar date');
const num = z.number({ invalid_type_error: 'Must be a number', required_error: 'Required' }).finite('Must be a number');
const money = num.nonnegative('Must be zero or more');
const optText = (max: number) => z.preprocess(blank, z.string().max(max, `At most ${max} characters`).nullable().optional());

export const GRADE_MAX = 40;

// ── bands ─────────────────────────────────────────────────────────────────────
export const bandCreate = z.object({
  grade: z.string().min(1, 'Enter a grade').max(GRADE_MAX, `At most ${GRADE_MAX} characters`),
  min: money,
  mid: money,
  max: money,
  market: money,
  published: z.boolean().optional(),
});
export const bandSave = z.object({ min: money, mid: money, max: money, market: money });
export const bandPublish = z.object({ published: z.boolean() });

// ── performance ─────────────────────────────────────────────────────────────────
export const perfSet = z.object({ band: z.enum(PERF_BANDS as unknown as [string, ...string[]]) });
export const perfReply = z.object({ reply: z.preprocess((v) => (v == null ? '' : v), z.string().max(4000, 'At most 4000 characters')) });

// ── merit cycle ─────────────────────────────────────────────────────────────────
export const cycleUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  effective_on: dateStr.optional(),
  budget_pct: num.optional(),
}).refine((o) => o.name !== undefined || o.effective_on !== undefined || o.budget_pct !== undefined, 'Nothing to change');

export const guidelineSet = z.object({
  perf: z.enum(PERF_BANDS as unknown as [string, ...string[]]),
  zone: z.enum(COMPA_ZONES as unknown as [string, ...string[]]),
  min: num,
  max: num,
});

/** setProposal: pct is a 0..50 number, or null to clear the proposal. A blank reason is dropped. */
export const proposalSet = z.object({
  pct: z.preprocess(blank, z.number().finite('Must be a number').nullable()),
  reason: optText(2000),
});

export const cycleDecide = z.object({
  decision: z.enum(['approve', 'return']),
  note: optText(4000),
  over_budget: z.boolean().optional(),
});

export const appliedRecord = z.object({
  from: money,
  to: money,
  letter_id: uuid,
});

export type BandCreateIn = z.infer<typeof bandCreate>;
export type CycleUpdateIn = z.infer<typeof cycleUpdate>;
export type ProposalSetIn = z.infer<typeof proposalSet>;
export type CycleDecideIn = z.infer<typeof cycleDecide>;
export type AppliedRecordIn = z.infer<typeof appliedRecord>;
