import { z } from 'zod';

// Request validation for the Lifecycle + Letters API (phase 4). Top-level keys are snake_case; the nested arrays (tasks, clearance,
// assets) keep the dashboard's own camelCase shape and pass through. zod only checks the TYPES here; the plain-sentence rules whose words
// the dashboard already has ("Give the template a name", "The letter body is too short", the close-exit blockers) are applied in the
// services (via ./validation) so the reason is the dashboard's, unprefixed.

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuid = z.string().uuid('Must be an id');
const optUuid = z.preprocess(blank, z.string().uuid('Must be an id').nullable().optional());
const bool = z.boolean();
const text = (max: number) => z.string().max(max, `At most ${max} characters`);
const reqText = (max: number, label: string) => z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} is at most ${max} characters`);
const optText = (max: number) => z.preprocess(blank, text(max).nullable().optional());
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const ONBOARDING_STAGES = ['offer', 'documents', 'registration', 'assets', 'induction', 'done'] as const;
export const EXIT_STAGES = ['notice', 'clearance', 'settlement', 'closed'] as const;
export const EXIT_REASONS = ['resignation', 'termination', 'end_of_contract', 'retirement', 'absconding'] as const;
export const LETTER_TYPES = ['offer', 'appointment', 'confirmation', 'increment', 'relieving', 'experience', 'warning'] as const;

// ── onboarding cases ──────────────────────────────────────────────────────────
// A checklist task passes through in the dashboard's camelCase shape { id, label, owner, done, dueOn? }.
const checklistTask = z.object({
  id: z.string().max(80).optional(),
  label: reqText(200, 'Task'),
  owner: z.preprocess((v) => (v == null ? '' : v), text(60)),
  done: bool.optional(),
  dueOn: z.preprocess(blank, dateStr.nullable().optional()),
}).passthrough();

export const onboardingCreate = z.object({
  id: uuid.optional(),
  employee_id: optUuid,
  name: reqText(100, 'Name'),
  role: reqText(100, 'Role'),
  join_date: dateStr,
  stage: z.enum(ONBOARDING_STAGES).optional(),
  tasks: z.array(checklistTask).max(100, 'At most 100 tasks').optional(),
});
export const onboardingUpdate = onboardingCreate.omit({ id: true }).partial();

// ── exit cases ────────────────────────────────────────────────────────────────
// Nested arrays pass through: clearance { id, department, owner, done, remarks? }, assets { id, name, returned }.
const clearanceItem = z.object({
  id: z.string().max(80).optional(),
  department: reqText(100, 'Department'),
  owner: z.preprocess((v) => (v == null ? '' : v), text(100)),
  done: bool.optional(),
  remarks: optText(500),
}).passthrough();
const assetItem = z.object({
  id: z.string().max(80).optional(),
  name: reqText(200, 'Asset'),
  returned: bool.optional(),
}).passthrough();

export const exitCreate = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  reason: z.enum(EXIT_REASONS),
  resignation_date: dateStr,
  last_working_date: dateStr,
  notice_waived: bool.optional(),
  stage: z.enum(EXIT_STAGES).optional(),
  clearance: z.array(clearanceItem).max(100, 'At most 100 clearance items').optional(),
  assets: z.array(assetItem).max(100, 'At most 100 assets').optional(),
  interview_done: bool.optional(),
});
export const exitUpdate = exitCreate.omit({ id: true, employee_id: true }).partial();

// ── letter templates ──────────────────────────────────────────────────────────
// name / body length is checked with the dashboard's words in ./validation; here only the type enum and a generous cap.
export const letterTemplateCreate = z.object({
  id: uuid.optional(),
  type: z.enum(LETTER_TYPES),
  name: text(2000),
  body: text(20000),
});
export const letterTemplateUpdate = letterTemplateCreate.omit({ id: true }).partial();

// ── issued letters ────────────────────────────────────────────────────────────
export const letterCreate = z.object({
  id: uuid.optional(),
  employee_id: uuid,
  template_id: optUuid,
  type: z.enum(LETTER_TYPES),
  issued_on: dateStr,
  body: text(20000),
  signed: bool.optional(),
});
// PUT mainly sets signed, but body / type / issued_on may change; employee_id is fixed (the URL names the row).
export const letterUpdate = letterCreate.omit({ id: true, employee_id: true }).partial();
