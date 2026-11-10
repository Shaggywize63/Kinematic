import { z } from 'zod';
import { AppError } from '../../utils';

// Request validation for the HRMS API. Top-level keys are snake_case; nested objects (address, bank, declaration, ...)
// keep the dashboard's own camelCase shape and pass through. The enum values are the ones in the dashboard's
// src/lib/hrms/types.ts and the CHECK constraints in migration_hrms_core.sql.

export const EMPLOYMENT_TYPES = ['permanent', 'fixed_term', 'contract', 'intern', 'daily_wage'] as const;
export const EMPLOYEE_STATUSES = ['onboarding', 'active', 'on_notice', 'exited'] as const;
export const GENDERS = ['male', 'female', 'other'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'other'] as const;
export const UAN_STATUSES = ['none', 'generated', 'activated', 'aadhaar_seeded'] as const;
export const TAX_REGIMES = ['new', 'old'] as const;
export const PAY_MODES = ['bank', 'cash', 'cheque'] as const;
export const DOCUMENT_TYPES = ['offer_letter', 'appointment_letter', 'id_proof', 'address_proof', 'pan_card', 'aadhaar', 'education', 'experience', 'bank_proof', 'relieving_letter', 'other'] as const;
export const DOCUMENT_STATUSES = ['pending', 'uploaded', 'verified', 'rejected'] as const;
export const ACCOUNT_TYPES = ['savings', 'current'] as const;

/** Returns the zod-validated body. Typed `any` because the repo is not compiled with strictNullChecks (z.infer marks every field optional). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parse(schema: z.ZodTypeAny, body: unknown): any {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, issueText(r.error.issues), 'VALIDATION');
  return r.data;
}

export const issueText = (issues: z.ZodIssue[], max = 1): string =>
  issues.slice(0, max).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ') || 'Invalid input';

// ── building blocks ─────────────────────────────────────────────────────────
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const upper = (v: unknown) => (typeof v === 'string' ? (v.trim() === '' ? null : v.replace(/\s+/g, '').toUpperCase()) : v);

/** Optional text: blank becomes null. */
const text = (max: number) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());
const reqText = (max: number, label: string) => z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} is at most ${max} characters`);

export const isRealDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').refine(isRealDate, 'Not a real calendar date');
const optDate = z.preprocess(blank, dateStr.nullable().optional());
const uuid = z.string().uuid('Must be an id');
const optUuid = z.preprocess(blank, z.string().uuid('Must be an id').nullable().optional());

const bool = z.boolean();
/** A number, also accepted as a numeric string (CSV import rows). null and blank are NOT numbers: they fail instead of becoming 0. */
const asNumber = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
const num = (min: number, max: number) => z.preprocess(asNumber, z.number({ invalid_type_error: 'Must be a number' }).finite().min(min).max(max));
const intIn = (min: number, max: number) => z.preprocess(asNumber, z.number({ invalid_type_error: 'Must be a whole number' }).int('Must be a whole number').min(min).max(max));

const address = z.object({
  line1: text(200), line2: text(200), city: text(100), state: text(100), pincode: text(12),
}).passthrough().refine((v) => JSON.stringify(v).length <= 2000, 'Address is too large');

// Loose shapes: the strict validators live in the dashboard. These catch typos and obvious junk.
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^[0-9]{6,20}$/;
const UAN_RE = /^[0-9]{12}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const CIN_RE = /^[A-Z0-9]{21}$/;

// ── organisation ────────────────────────────────────────────────────────────
const registration = z.object({
  id: z.string().max(80).optional(),
  type: z.enum(['pf', 'esi', 'pt', 'lwf', 'shops', 'clra', 'tan', 'gst']),
  state: text(100), number: reqText(80, 'Registration number'), validFrom: optDate, validTo: optDate, notes: text(500),
}).passthrough();

export const entityBase = z.object({
  id: uuid.optional(),
  name: reqText(200, 'Name'),
  pan: z.preprocess(upper, z.string().regex(PAN_RE, 'Invalid PAN').nullable().optional()),
  tan: z.preprocess(upper, z.string().regex(TAN_RE, 'Invalid TAN').nullable().optional()),
  cin: z.preprocess(upper, z.string().regex(CIN_RE, 'Invalid CIN').nullable().optional()),
  gstin: z.preprocess(upper, z.string().regex(GSTIN_RE, 'Invalid GSTIN').nullable().optional()),
  address: address.optional(),
  registrations: z.array(registration).max(200).optional(),
  signatory: z.preprocess(blank, z.object({ name: text(100), designation: text(100) }).passthrough().nullable().optional()),
});
export const entityCreate = entityBase;
export const entityUpdate = entityBase.omit({ id: true }).partial();

export const locationBase = z.object({
  id: uuid.optional(),
  entity_id: uuid,
  name: reqText(120, 'Name'),
  state: reqText(100, 'State'),
  city: reqText(100, 'City'),
  address: text(300),
  metro: bool.optional(),
  holiday_list_id: text(80),
});
export const locationCreate = locationBase;
export const locationUpdate = locationBase.omit({ id: true }).partial();

export const departmentBase = z.object({ id: uuid.optional(), name: reqText(100, 'Name'), head_id: optUuid });
export const departmentCreate = departmentBase;
export const departmentUpdate = departmentBase.omit({ id: true }).partial();

export const designationBase = z.object({ id: uuid.optional(), name: reqText(100, 'Name'), grade: text(40) });
export const designationCreate = designationBase;
export const designationUpdate = designationBase.omit({ id: true }).partial();

// ── employees ───────────────────────────────────────────────────────────────
const mobile = z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'Enter a valid mobile number');
const email = z.string().trim().max(200).email('Enter a valid email address');

const declaration = z.object({
  sec80C: num(0, 1e9).optional(), sec80D: num(0, 1e9).optional(),
  nps80CCD1B: num(0, 1e9).optional(), homeLoanInterest: num(0, 1e9).optional(),
  rentPaidAnnual: num(0, 1e9).optional(), other: num(0, 1e9).optional(),
  landlordPan: z.preprocess(upper, z.string().regex(PAN_RE, 'Invalid landlord PAN').nullable().optional()),
  submittedOn: optDate,
  status: z.enum(['not_submitted', 'submitted', 'verified']).optional(),
}).passthrough().refine((v) => JSON.stringify(v).length <= 2000, 'Declaration is too large');

const emergencyContact = z.preprocess(blank, z.object({ name: text(100), relation: text(60), mobile: text(30) }).passthrough().nullable().optional());

/** Bank details as sent: accountNumber may be masked (ignored, see employees.service) or a new full number. */
export const bankInput = z.object({
  accountHolder: text(100), accountNumber: z.string().trim().max(40).optional().nullable(), ifsc: z.preprocess(upper, z.string().regex(IFSC_RE, 'Invalid IFSC').nullable().optional()),
  bankName: text(100), accountType: z.enum(ACCOUNT_TYPES).optional().nullable(),
});

/** The snake_case spellings of the nested bank keys are accepted too (the contract text uses account_number). */
const camelBank = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  const alias: Record<string, string> = { account_holder: 'accountHolder', account_number: 'accountNumber', bank_name: 'bankName', account_type: 'accountType' };
  for (const [snake, camel] of Object.entries(alias)) if (snake in o) { if (!(camel in o)) o[camel] = o[snake]; delete o[snake]; }
  return o;
};

/** PAN as sent: a new full PAN, or a masked echo (ignored by the service). Shape-checked in the service so masks pass here. */
const sensitivePan = z.preprocess(blank, z.string().trim().max(20).nullable().optional());

const documentFields = {
  type: z.enum(DOCUMENT_TYPES), name: reqText(200, 'Name'), uploaded_on: dateStr, status: z.enum(DOCUMENT_STATUSES),
  mandatory: bool, file_name: text(255),
};
const documentInline = z.object({ id: uuid.optional(), ...documentFields, uploaded_on: documentFields.uploaded_on.optional(), status: documentFields.status.optional(), mandatory: bool.optional() });

export const employeeBase = z.object({
  id: uuid.optional(),
  code: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(32).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Use letters, digits, dot, dash, slash or underscore').optional()),
  first_name: reqText(100, 'First name'),
  last_name: z.string().trim().max(100).optional(),
  email,
  mobile,
  gender: z.enum(GENDERS),
  dob: dateStr.refine((d) => d >= '1900-01-01' && d <= new Date().toISOString().slice(0, 10), 'Date of birth must be in the past'),
  father_name: text(100),
  marital_status: z.preprocess(blank, z.enum(MARITAL_STATUSES).nullable().optional()),
  blood_group: text(5),
  address: address.optional(),
  emergency_contact: emergencyContact,

  entity_id: uuid,
  location_id: uuid,
  department_id: uuid,
  designation_id: uuid,
  reporting_to_id: optUuid,
  employment_type: z.enum(EMPLOYMENT_TYPES),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  join_date: dateStr,
  confirmation_date: optDate,
  probation_months: intIn(0, 60).optional(),
  notice_days: intIn(0, 365).optional(),
  last_working_date: optDate,
  shift_id: text(64),
  cost_centre: text(64),
  contract_end_date: optDate,

  pan: sensitivePan,
  aadhaar_last4: z.preprocess(blank, z.string().regex(/^[0-9]{4}$/, 'Only the last four digits of Aadhaar are kept').nullable().optional()),
  aadhaar_verified: bool.optional(),
  uan: z.preprocess((v) => (typeof v === 'string' ? (v.replace(/\s+/g, '') === '' ? null : v.replace(/\s+/g, '')) : v), z.string().regex(UAN_RE, 'UAN is 12 digits').nullable().optional()),
  uan_status: z.enum(UAN_STATUSES).optional(),
  pf_member: bool.optional(),
  pf_on_actual_wage: bool.optional(),
  pf_join_date: optDate,
  esic_ip: z.preprocess((v) => (typeof v === 'string' ? (v.replace(/\s+/g, '') === '' ? null : v.replace(/\s+/g, '')) : v), z.string().regex(/^[0-9]{10,17}$/, 'ESIC number is 10 to 17 digits').nullable().optional()),
  pt_applicable: bool.optional(),
  lwf_applicable: bool.optional(),
  tax_regime: z.enum(TAX_REGIMES).optional(),
  declaration: declaration.optional(),
  bank: z.preprocess((v) => camelBank(blank(v)), bankInput.nullable().optional()),
  pay_mode: z.enum(PAY_MODES).optional(),
  structure_id: text(64),
  annual_ctc: z.preprocess((v) => asNumber(blank(v)), z.number({ invalid_type_error: 'Annual CTC must be a number' }).finite().min(0, 'Annual CTC cannot be negative').max(1e10).nullable().optional()),
  structure_overrides: z.preprocess(blank, z.record(num(0, 1e9)).refine((v) => Object.keys(v).length <= 100, 'Too many overrides').nullable().optional()),
});

export const employeeCreate = employeeBase.extend({ documents: z.array(documentInline).max(50).optional() });
/** Partial update: only the keys sent change. `id` is ignored (the URL names it); unknown keys (documents, history, ...) are stripped. */
export const employeeUpdate = employeeBase.omit({ id: true }).partial();

export const importBody = z.object({
  rows: z.array(z.unknown()).min(1, 'Add at least one row').max(500, 'Import at most 500 rows at a time'),
  dry_run: z.boolean().optional(),
});

// ── documents, reveal, settings ─────────────────────────────────────────────
export const documentCreate = z.preprocess(snakeDocument, documentInline);
export const documentUpdate = z.preprocess(snakeDocument, z.object(documentFields).partial());

/** Documents are also accepted in the dashboard's camelCase spelling (uploadedOn, fileName). */
function snakeDocument(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  if ('uploadedOn' in o && !('uploaded_on' in o)) o.uploaded_on = o.uploadedOn;
  if ('fileName' in o && !('file_name' in o)) o.file_name = o.fileName;
  delete o.uploadedOn; delete o.fileName;
  return o;
}

export const REVEAL_FIELDS = ['pan', 'bank', 'aadhaar'] as const;
export const revealBody = z.object({
  field: z.enum(REVEAL_FIELDS, { errorMap: () => ({ message: 'field must be pan, bank or aadhaar' }) }),
  reason: z.string({ required_error: 'A reason is required' }).trim().min(5, 'Give a reason of at least 5 characters').max(500, 'The reason is at most 500 characters'),
});

export const CODE_PREFIX_KEY = 'employee_code_prefix';
export const codePrefixBody = z.object({
  value: z.string({ required_error: 'value is required' }).trim().regex(/^[A-Za-z0-9-]{2,8}$/, 'Use 2 to 8 letters, digits or dashes'),
});

