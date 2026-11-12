import { z } from 'zod';

// Request validation for the Privacy/DPDP + Compliance API (phase 5). Top-level keys are snake_case. zod checks the TYPES and the enum
// shapes here; the plain-sentence rules (non-empty dataset/basis, keep_years >= 0) are applied in the services (via ./validation) so the
// reason is a plain, unprefixed sentence. compliance tasks store NO `status` -- it is derived client-side from due_on / filed_on / today.

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuid = z.string().uuid('Must be an id');
const text = (max: number) => z.string().max(max, `At most ${max} characters`);
const reqText = (max: number, label: string) => z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} is at most ${max} characters`);
const optText = (max: number) => z.preprocess(blank, text(max).nullable().optional());
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const optDate = z.preprocess(blank, dateStr.nullable().optional());
// A full ISO-8601 timestamp (the dashboard sends e.g. 2026-01-15T09:00:00.000Z). Permissive about milliseconds / offset, strict about shape.
const isoTs = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v)), 'Must be an ISO timestamp');
const optIsoTs = z.preprocess(blank, isoTs.nullable().optional());

export const COMPLIANCE_LAWS = ['PF', 'ESI', 'PT', 'LWF', 'TDS', 'Shops', 'CLRA', 'POSH', 'Gratuity', 'Bonus'] as const;
export const RETENTION_ACTIONS = ['delete', 'anonymise'] as const;

// ── compliance tasks ────────────────────────────────────────────────────────
// No `status`: it is derived client-side. filed_on + reference are the markFiled fields (filing recorded); clearing them is a reopen.
export const complianceCreate = z.object({
  id: uuid.optional(),
  name: reqText(200, 'Name'),
  law: z.enum(COMPLIANCE_LAWS),
  due_on: dateStr,
  entity_id: uuid,
  state: optText(100),
  filed_on: optDate,
  reference: optText(200),
});
export const complianceUpdate = complianceCreate.omit({ id: true }).partial();

// ── consent records ─────────────────────────────────────────────────────────
// granted_at / withdrawn_at are full ISO timestamps. Withdrawing is a PUT that sets withdrawn_at; clearing it (null) re-grants.
export const consentCreate = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  purpose: reqText(200, 'Purpose'),
  notice_version: reqText(100, 'Notice version'),
  granted_at: isoTs,
  withdrawn_at: optIsoTs,
});
// employee_id is fixed by the row (the URL names it); the rest may change.
export const consentUpdate = consentCreate.omit({ id: true, employee_id: true }).partial();

// ── retention rules ─────────────────────────────────────────────────────────
// keep_years is a plain number (sub-year periods allowed); the >= 0 and non-empty checks are applied in ./validation with plain words.
export const retentionCreate = z.object({
  id: uuid.optional(),
  dataset: text(200),
  keep_years: z.number({ invalid_type_error: 'keep_years must be a number', required_error: 'keep_years must be a number' }),
  basis: text(500),
  action: z.enum(RETENTION_ACTIONS),
});
export const retentionUpdate = retentionCreate.omit({ id: true }).partial();
