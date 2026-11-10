import { AppError } from '../../utils';
import {
  decryptField, encryptField, looksMaskedAccount, looksMaskedPan, maskAccountNumber, maskPan, PAN_UNREADABLE,
} from '../../lib/hrmsCrypto';
import { ACCOUNT_RE, IFSC_RE, PAN_RE } from './schemas';

// Pure helpers shared by the employee, import and privacy services: change-log labels, sensitive-field handling
// (normalise / encrypt / mask), the API shape of an employee, and the change diff. No database access in here.

export type Row = Record<string, unknown>;

/**
 * Change-log labels, keyed by the API (snake_case) field. The first block is FIELD_LABELS in the dashboard's
 * src/lib/hrms/actions.ts; the second is the extra labels its employeeActions.ts writes for fields that map skips
 * (date of birth, address, declaration, ...); the third two are server-only (see the comments). A field without a
 * label is changed but not logged, exactly as in the dashboard.
 */
export const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name', last_name: 'Last name', email: 'Email', mobile: 'Mobile', department_id: 'Department', designation_id: 'Designation',
  location_id: 'Location', entity_id: 'Legal entity', reporting_to_id: 'Reports to', employment_type: 'Employment type', status: 'Status',
  annual_ctc: 'Annual CTC', structure_id: 'Salary structure', pan: 'PAN', uan: 'UAN', uan_status: 'UAN status', esic_ip: 'ESIC number',
  tax_regime: 'Tax regime', shift_id: 'Shift', last_working_date: 'Last working date', confirmation_date: 'Confirmation date',
  pf_member: 'PF member', pay_mode: 'Pay mode', bank: 'Bank account', aadhaar_last4: 'Aadhaar',
  // employeeActions.ts EXTRA_LABELS
  dob: 'Date of birth', gender: 'Gender', father_name: "Father's name", marital_status: 'Marital status', blood_group: 'Blood group',
  address: 'Address', emergency_contact: 'Emergency contact', join_date: 'Join date', probation_months: 'Probation (months)',
  notice_days: 'Notice period (days)', cost_centre: 'Cost centre', contract_end_date: 'Contract end date', pf_on_actual_wage: 'PF on actual wage',
  pt_applicable: 'Professional tax applies', lwf_applicable: 'Labour welfare fund applies', declaration: 'Tax declaration (Form 124)',
  // server-only: per-component pay overrides carry component ids the server cannot name, so one summary row
  structure_overrides: 'Salary overrides',
};

/** Fields whose value is never written to the change log. */
const NEVER_SHOW = new Set(['pan', 'bank', 'aadhaar_last4']);

/** Non-sensitive columns a create / update may write, besides the sensitive pair handled separately (pan, bank). */
export const PLAIN_COLUMNS = [
  'first_name', 'last_name', 'email', 'mobile', 'gender', 'dob', 'father_name', 'marital_status', 'blood_group', 'address', 'emergency_contact',
  'entity_id', 'location_id', 'department_id', 'designation_id', 'reporting_to_id', 'employment_type', 'status', 'join_date', 'confirmation_date',
  'probation_months', 'notice_days', 'last_working_date', 'shift_id', 'cost_centre', 'contract_end_date',
  'aadhaar_last4', 'aadhaar_verified', 'uan', 'uan_status', 'pf_member', 'pf_on_actual_wage', 'pf_join_date', 'esic_ip',
  'pt_applicable', 'lwf_applicable', 'tax_regime', 'declaration', 'pay_mode', 'structure_id', 'annual_ctc', 'structure_overrides',
] as const;

/**
 * The database defaults for the NOT NULL columns that have one. Insert rows carry EVERY column explicitly (these, or null),
 * so all rows of a bulk insert have the same keys: supabase-js fills a key that is missing from some rows of a bulk insert
 * with NULL rather than the column default, which would break NOT NULL columns such as status.
 */
export const INSERT_DEFAULTS: Record<string, unknown> = {
  last_name: '', status: 'onboarding', probation_months: 0, notice_days: 0, aadhaar_verified: false, uan_status: 'none', pf_member: false,
  pf_on_actual_wage: false, pt_applicable: false, lwf_applicable: false, tax_regime: 'new', pay_mode: 'bank', address: {},
  declaration: { sec80C: 0, sec80D: 0, nps80CCD1B: 0, homeLoanInterest: 0, rentPaidAnnual: 0, other: 0, status: 'not_submitted' },
};

/** Foreign-key fields: the change log names the thing (a department, a person) instead of printing its id. */
export const REF_FIELDS = {
  entity_id: 'hrms_entities', location_id: 'hrms_locations', department_id: 'hrms_departments',
  designation_id: 'hrms_designations', reporting_to_id: 'hrms_employees',
} as const;

// ── sensitive fields ────────────────────────────────────────────────────────
export interface Bank { accountHolder: string; accountNumber: string; ifsc: string; bankName: string; accountType: 'savings' | 'current' }

export const panContext = (employeeId: string) => `${employeeId}:pan`;
export const bankContext = (employeeId: string) => `${employeeId}:bank`;

export const readPan = (row: Row): string | null => decryptField(row.pan_enc as string | null, panContext(String(row.id)));

export function readBank(row: Row): Bank | null {
  const json = decryptField(row.bank_enc as string | null, bankContext(String(row.id)));
  if (!json) return null;
  try { return normaliseBankShape(JSON.parse(json)); } catch { return null; }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The stored bank shape, with the keys in a fixed order so two equal banks compare equal as JSON. */
function normaliseBankShape(o: Record<string, unknown>): Bank {
  return {
    accountHolder: str(o.accountHolder), accountNumber: str(o.accountNumber).replace(/\s+/g, ''), ifsc: str(o.ifsc).toUpperCase(),
    bankName: str(o.bankName), accountType: o.accountType === 'current' ? 'current' : 'savings',
  };
}

/**
 * Turn a PAN sent by a client into what to store.
 *   - undefined (key absent)      -> { skip: true }   nothing changes
 *   - null / blank                -> { clear: true }
 *   - a masked echo (X..., •, *)  -> { skip: true }   never stored
 *   - a full PAN of the right shape -> { value }
 * A malformed PAN is a 400.
 */
export function interpretPan(input: unknown): { skip: true } | { clear: true } | { value: string } {
  if (input === undefined) return { skip: true };
  if (input === null) return { clear: true };
  const v = String(input).replace(/\s+/g, '').toUpperCase();
  if (v === '') return { clear: true };
  if (looksMaskedPan(v)) return { skip: true };
  if (!PAN_RE.test(v)) throw new AppError(400, 'pan: Invalid PAN (it looks like ABCDE1234F)', 'VALIDATION');
  return { value: v };
}

/**
 * Turn bank details sent by a client into what to store. `existing` is the decrypted bank already on file, if any.
 *   - undefined                    -> skip
 *   - null, or every field blank   -> clear
 *   - account number masked        -> keep the number on file and take the other fields from the request (so an IFSC
 *                                     edit works without re-typing the number); with nothing on file the request is ignored
 *   - a full account number        -> store the new details
 */
export function interpretBank(input: unknown, existing: Bank | null): { skip: true } | { clear: true } | { value: Bank } {
  if (input === undefined) return { skip: true };
  if (input === null) return { clear: true };
  const o = input as Record<string, unknown>;
  const next = normaliseBankShape(o);
  const rawNumber = str(o.accountNumber);
  const blankAll = !next.accountHolder && !next.accountNumber && !next.ifsc && !next.bankName;
  if (blankAll) return { clear: true };

  if (rawNumber && looksMaskedAccount(rawNumber)) {
    if (!existing) return { skip: true };
    return { value: { ...next, accountNumber: existing.accountNumber } };
  }
  if (!next.accountNumber) {
    if (!existing) throw new AppError(400, 'bank.accountNumber: Account number is required', 'VALIDATION');
    return { value: { ...next, accountNumber: existing.accountNumber } };
  }
  if (!ACCOUNT_RE.test(next.accountNumber)) throw new AppError(400, 'bank.accountNumber: Account number is 6 to 20 digits', 'VALIDATION');
  if (next.ifsc && !IFSC_RE.test(next.ifsc)) throw new AppError(400, 'bank.ifsc: Invalid IFSC (it looks like HDFC0001234)', 'VALIDATION');
  return { value: next };
}

export const sealPan = (employeeId: string, pan: string) => encryptField(pan, panContext(employeeId));
export const sealBank = (employeeId: string, bank: Bank) => encryptField(JSON.stringify(bank), bankContext(employeeId));

export const maskedBank = (b: Bank): Bank => ({ ...b, accountNumber: maskAccountNumber(b.accountNumber) });

// ── API shape ───────────────────────────────────────────────────────────────
const STRIP = new Set(['org_id', 'client_id', 'deleted_at', 'pan_enc', 'bank_enc']);

/** An org-structure row as the API returns it: no tenant columns. */
export function publicRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (k !== 'org_id' && k !== 'client_id') out[k] = v;
  return out;
}

export interface ApiEmployee extends Row { documents: Row[]; history: Row[] }

/** An employee as the API returns it: ciphertext replaced by masked values, tenant columns dropped, documents + history attached. */
export function toApiEmployee(row: Row, documents: Row[] = [], history: Row[] = []): ApiEmployee {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (!STRIP.has(k)) out[k] = v;
  const pan = row.pan_enc ? readPan(row) : null;
  out.pan = row.pan_enc ? (pan ? maskPan(pan) : PAN_UNREADABLE) : null;
  const bank = row.bank_enc ? readBank(row) : null;
  out.bank = row.bank_enc ? (bank ? maskedBank(bank) : { accountHolder: '', accountNumber: PAN_UNREADABLE, ifsc: '', bankName: '', accountType: 'savings' }) : null;
  out.documents = documents.map(publicRow);
  out.history = history.map(publicRow);
  return out as ApiEmployee;
}

// ── change log ──────────────────────────────────────────────────────────────
export interface Change { field: string; key: string; from: unknown; to: unknown }

/** Stable JSON: object keys sorted, so {a,b} equals {b,a}. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Row).sort(([a], [b]) => (a < b ? -1 : 1))) : val);

/** null, undefined and '' are the same "empty"; numbers compare as numbers (numeric columns come back as numbers or strings). */
export function sameValue(a: unknown, b: unknown): boolean {
  const e = (v: unknown) => (v === undefined || v === '' ? null : v);
  const x = e(a); const y = e(b);
  if (x === null || y === null) return x === y;
  if (typeof x === 'object' || typeof y === 'object') return stable(x) === stable(y);
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y);
  return x === y;
}

/** What goes in a change-log cell for a field. Sensitive and object-valued fields never print their content. */
export function showValue(key: string, v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (NEVER_SHOW.has(key)) return 'Updated';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return 'Updated';
  return String(v);
}

/**
 * The change-log rows for an update: one per labelled field whose value really changed. `before` / `after` are keyed by
 * the API field names, with PAN and bank as plaintext (the caller decrypts); they are compared here and then shown as
 * "On file" / "Updated" / "Removed", never as the value. Order follows FIELD_LABELS so the result is deterministic.
 */
export function diffEmployee(before: Row, after: Row): Change[] {
  const out: Change[] = [];
  for (const key of Object.keys(FIELD_LABELS)) {
    if (!(key in after)) continue;
    if (sameValue(before[key], after[key])) continue;
    out.push({ field: FIELD_LABELS[key]!, key, from: before[key] ?? null, to: after[key] ?? null });
  }
  return out;
}

/** The text for one side of a change, given a resolver for foreign-key names. */
export function changeText(c: Change, side: 'from' | 'to', names: Map<string, string>): string | null {
  const v = side === 'from' ? c.from : c.to;
  if (c.key === 'pan' || c.key === 'bank') {
    if (v === null || v === undefined || v === '') return side === 'to' ? 'Removed' : null;
    return side === 'from' ? 'On file' : 'Updated';
  }
  if (c.key === 'aadhaar_last4') {
    if (v === null || v === undefined || v === '') return side === 'to' ? 'Removed' : null;
    return side === 'from' ? 'On file' : 'Updated (last four digits only)';
  }
  if (v !== null && v !== undefined && v !== '' && c.key in REF_FIELDS) return names.get(String(v)) ?? String(v);
  return showValue(c.key, v);
}

export interface HistoryInput { employee_id: string; field: string; from_value: string | null; to_value: string | null }

export function historyRow(s: { org_id: string; user_id: string | null; actor: string }, h: HistoryInput, at: string): Row {
  return {
    org_id: s.org_id, client_id: null, employee_id: h.employee_id, at,
    by_user_id: s.user_id, by_name: s.actor, field: h.field, from_value: h.from_value, to_value: h.to_value,
  };
}

// ── reporting line ──────────────────────────────────────────────────────────
/**
 * True when making `managerId` the manager of `employeeId` would create a loop: walking up from the manager reaches the
 * employee. `parentOf` maps each employee id to the id they report to. Guards against an existing loop in the data.
 */
export function wouldCreateCycle(employeeId: string, managerId: string, parentOf: Map<string, string | null>): boolean {
  const seen = new Set<string>();
  let cur: string | null | undefined = managerId;
  while (cur) {
    if (cur === employeeId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}
