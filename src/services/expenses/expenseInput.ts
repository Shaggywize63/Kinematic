/**
 * Request-body rules for expense claims, shared by the router and the tests.
 *
 * Why this file exists: the mobile apps (and people typing into them) send things the original
 * strict schemas turned into a bare "Invalid enum value" / "Number must be..." 400 — or, when
 * the value slipped past zod but not past Postgres (a date like 2026-02-31, a NUL byte in
 * pasted text), into a 500 that production hides behind "Internal server error". Here:
 *
 *   - numbers are read the way people write them ("1,250.50", "₹ 99", "99,50", "٣٠٠"),
 *   - dates are checked against the calendar (not just the YYYY-MM-DD shape),
 *   - text is cleaned of characters Postgres refuses,
 *   - every failure names the expense line and the field ("Expense 2: amount must be a number").
 */
import { z } from 'zod';

// ── numbers ─────────────────────────────────────────────────────────────────
const DIGIT_BLOCKS: Array<[number, number]> = [[0x0660, 0x0669], [0x06f0, 0x06f9], [0x0966, 0x096f]]; // Arabic-Indic, Persian, Devanagari

function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹०-९]/g, (ch) => {
    const cp = ch.codePointAt(0)!;
    for (const [lo] of DIGIT_BLOCKS) if (cp >= lo && cp < lo + 10) return String(cp - lo);
    return ch;
  });
}

/**
 * A number as a person writes it → a JS number. Numbers pass through; a blank string is null
 * ("not given"); a string is read after dropping currency marks and spaces, and the comma is
 * understood as either the decimal mark ("99,50") or a thousands separator ("1,250", "12,34,567").
 * Anything that still is not a number is returned untouched so the schema reports it.
 */
export function looseNumber(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  let s = asciiDigits(v).replace(/[\s  ]/g, '').replace(/₹|rs\.?|inr|\$|€|£/gi, '');
  if (s === '') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    s = s.replace(thousands, '');
    if (decimal === ',') s = s.replace(',', '.');
  } else if (lastComma >= 0) {
    const commas = (s.match(/,/g) || []).length;
    const after = s.length - lastComma - 1;
    s = commas === 1 && after >= 1 && after <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : v;
}

// ── dates ───────────────────────────────────────────────────────────────────
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** A real calendar day (2026-02-31 is not), in a year that can only be a typo or a calendar mix-up if outside 2000–2100. */
export function isRealYmd(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < MIN_YEAR || y > MAX_YEAR) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Reads a day the way an app or a person might send it: "2026-10-05", a full timestamp
 * ("2026-10-05T18:30:00Z" → its date part), or day-first "05/10/2026" / "5-10-2026" (the Indian order).
 * Blank → null. Anything else is returned as typed so validation can name it.
 */
export function normalizeYmd(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = asciiDigits(v).trim();
  if (s === '') return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

/** The scanner's date, or null when it is not a usable day. */
export function usableScanDate(v: unknown): string | null {
  const n = normalizeYmd(v);
  return isRealYmd(n) ? n : null;
}

// ── text ────────────────────────────────────────────────────────────────────
/** Drops NUL and other control characters (Postgres refuses \u0000 in text); keeps tabs and new lines. */
export function cleanText(v: unknown): unknown {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : v;
}

// ── schema pieces ───────────────────────────────────────────────────────────
export const EXPENSE_CATEGORIES = ['mileage', 'travel', 'food', 'lodging', 'fuel', 'toll', 'misc'] as const;
const uuid = z.string().uuid();

const amountField = (max: number) =>
  z.preprocess(looseNumber, z.number().min(0).max(max).nullable()).optional();
const textField = (max: number) =>
  z.preprocess(cleanText, z.string().max(max).nullable()).optional();
const dayField = () =>
  z.preprocess(normalizeYmd, z.string().refine(isRealYmd, 'date must be a real day written as YYYY-MM-DD').nullable()).optional();
// Only web links or our own storage objects — never javascript: or data: URIs. An empty string
// means "remove it" for clients (the Android app) that cannot send an explicit null.
export const photoField = (what: string) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().max(2048)
    .refine((u) => {
      if (u === '') return true;
      if (!/^https?:\/\//i.test(u)) return false;
      try { new URL(u); return true; } catch { return false; }
    }, `${what} must be a web link`).nullable()).optional();
/** '' is how a client that cannot send null asks for "none". */
const optionalId = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), uuid.nullable()).optional();

export const itemSchema = z.object({
  // A line the client has not saved yet may carry an empty id.
  id: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), uuid.optional()),
  category: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const c = v.trim().toLowerCase();
      return c === 'other' || c === 'others' ? 'misc' : c;
    },
    z.enum(EXPENSE_CATEGORIES, { errorMap: () => ({ message: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` }) }),
  ),
  item_date: dayField(),
  description: textField(500),
  amount: amountField(10_000_000),
  distance_km: amountField(100_000),
  from_location: textField(200),
  to_location: textField(200),
  merchant: textField(200),
  // Travel allowance by vehicle (policies with vehicle_rates): the vehicle and the odometer
  // readings before / after, each with a photo. Distance and amount are computed server-side.
  vehicle_type: textField(40),
  odometer_start: amountField(100_000_000),
  odometer_end: amountField(100_000_000),
  odometer_start_photo_url: photoField('The odometer photo'),
  odometer_end_photo_url: photoField('The odometer photo'),
  receipt_url: photoField('The receipt'),
  ai_extracted: z.any().optional(),
  // GST on the bill — feeds Finance's GST-on-expenses / input-tax-credit report.
  supplier_gstin: z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
    z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'supplier GSTIN is not valid').nullable().optional()),
  supplier_invoice_no: textField(60),
  gst_rate: amountField(40),
  gst_amount: amountField(10_000_000),
  itc_eligible: z.boolean().optional().nullable(),
});

export const createSchema = z.object({
  title: textField(200),
  // Connected-B2B flow (Spark & Ray): the mandatory purpose/justification, and
  // the CRM account + builder form this expense is linked to. Accepted for any
  // client but only stored/enforced for B2B clients (see expenses.service).
  clarification: textField(2000),
  account_id: optionalId,
  form_id: optionalId,
  // null or '' clears the link (a client that cannot send an explicit null sends '').
  form_submission_id: optionalId,
  items: z.array(itemSchema).max(100, 'A claim can have at most 100 expense lines').optional(),
});

export const checkSchema = z.object({ items: z.array(itemSchema).max(100).optional(), claim_id: uuid.optional() });

// ── error text ──────────────────────────────────────────────────────────────
const FIELD_NAME: Record<string, string> = {
  item_date: 'date', distance_km: 'distance', from_location: 'from location', to_location: 'to location',
  receipt_url: 'receipt', vehicle_type: 'vehicle', odometer_start: 'odometer reading before', odometer_end: 'odometer reading after',
  odometer_start_photo_url: 'odometer photo', odometer_end_photo_url: 'odometer photo', supplier_gstin: 'supplier GSTIN',
  supplier_invoice_no: 'invoice number', gst_rate: 'GST rate', gst_amount: 'GST amount', form_submission_id: 'linked form entry',
  account_id: 'linked account', form_id: 'linked form', claim_id: 'claim id', ai_extracted: 'scan data',
};
const nameOf = (k: string | number | undefined) => (k === undefined ? 'request' : (FIELD_NAME[String(k)] ?? String(k).replace(/_/g, ' ')));

/**
 * One sentence a person can act on: "Expense 2: amount must be a number". Messages written for a field
 * in this file already read as a sentence and are only given the line prefix; zod's stock messages are
 * rewritten around the field name.
 */
export function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path;
  const inLine = path[0] === 'items' && typeof path[1] === 'number';
  const prefix = inLine ? `Expense ${(path[1] as number) + 1}: ` : '';
  const field = nameOf(inLine ? path[2] : path[path.length - 1]);
  const anyIssue = issue as any;
  let msg: string;
  switch (issue.code) {
    case 'invalid_type':
      msg = anyIssue.received === 'undefined' || anyIssue.received === 'null'
        ? `${field} is required`
        : anyIssue.expected === 'number' ? `${field} must be a number`
          : anyIssue.expected === 'string' ? `${field} must be text`
            : anyIssue.expected === 'boolean' ? `${field} must be true or false`
              : anyIssue.expected === 'array' ? `${field} must be a list`
                : `${field} is not valid`;
      break;
    case 'too_big':
      msg = anyIssue.type === 'string' ? `${field} is too long (${anyIssue.maximum} characters at most)`
        : anyIssue.type === 'array' ? `${field} has too many entries (${anyIssue.maximum} at most)`
          : `${field} can be at most ${anyIssue.maximum}`;
      break;
    case 'too_small':
      msg = anyIssue.type === 'string' ? `${field} is too short`
        : anyIssue.type === 'array' ? `${field} needs at least ${anyIssue.minimum} entries`
          : Number(anyIssue.minimum) === 0 ? `${field} can't be negative` : `${field} must be at least ${anyIssue.minimum}`;
      break;
    case 'invalid_enum_value':
      msg = `${field} must be one of: ${(anyIssue.options || []).join(', ')}`;
      break;
    case 'invalid_string':
      msg = anyIssue.validation === 'uuid' ? `${field} is not a valid id` : `${field} is not valid`;
      break;
    default:
      return `${prefix}${issue.message}`;
  }
  return `${prefix}${msg}`;
}

/** The first problem of a failed parse, as one readable sentence. */
export function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? describeIssue(issue) : 'Invalid input';
}
