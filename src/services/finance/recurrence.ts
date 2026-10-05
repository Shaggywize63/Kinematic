/**
 * Recurring-invoice date math.
 *
 * A recurring invoice stores a START date ("from date") + a DURATION; the next
 * invoice date is always DERIVED from those two (never typed in). Durations are
 * fixed cadences (weekly / monthly / quarterly / half-yearly / yearly) or a
 * custom "every N days/months". All dates are date-only (YYYY-MM-DD) and handled
 * in UTC so there is no timezone drift.
 */
import { AppError } from '../../utils';

export type RecurrenceInterval = 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'custom';

export interface RecurrenceSpec {
  interval: RecurrenceInterval;
  customEvery?: number | null;
  customUnit?: 'day' | 'month' | null;
}

/** Columns persisted on finance_documents for a recurrence schedule. */
export interface RecurrenceColumns {
  recurrence_enabled: boolean;
  recurrence_interval: RecurrenceInterval | null;
  recurrence_custom_every: number | null;
  recurrence_custom_unit: 'day' | 'month' | null;
  recurrence_start: string | null;
  next_invoice_date: string | null;
  recurrence_reminder_email: boolean;
}

const INTERVALS: RecurrenceInterval[] = ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom'];
const MONTHS_FOR: Record<'monthly' | 'quarterly' | 'half_yearly' | 'yearly', number> = {
  monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12,
};
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const parts = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return { y, m0: m - 1, d }; };
const fmt = (y: number, m0: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Add whole months, clamping the day to the target month's length (Jan 31 + 1m → Feb 28/29). */
export function addMonths(iso: string, months: number): string {
  const { y, m0, d } = parts(iso);
  const total = m0 + months;
  const ty = y + Math.floor(total / 12);
  const tm0 = ((total % 12) + 12) % 12;
  return fmt(ty, tm0, Math.min(d, daysInMonth(ty, tm0)));
}

/** The date one duration after `iso`. */
export function addInterval(iso: string, spec: RecurrenceSpec): string {
  switch (spec.interval) {
    case 'weekly': return addDays(iso, 7);
    case 'custom': {
      const n = Math.max(1, Math.floor(Number(spec.customEvery) || 1));
      return spec.customUnit === 'day' ? addDays(iso, n) : addMonths(iso, n);
    }
    default: return addMonths(iso, MONTHS_FOR[spec.interval as keyof typeof MONTHS_FOR]);
  }
}

/**
 * The first occurrence strictly AFTER today, anchored to `anchorIso`'s cadence.
 * Used both to compute the initial next-invoice date (anchor = start) and to roll
 * it forward after a reminder fires (anchor = the current next-invoice date). The
 * 600-step cap can't loop forever even for a daily cadence left dormant for years.
 */
export function firstFutureFrom(anchorIso: string, spec: RecurrenceSpec, todayIso: string): string {
  let next = addInterval(anchorIso, spec);
  for (let i = 0; i < 600 && next <= todayIso; i++) next = addInterval(next, spec);
  return next;
}

/** Build a spec from stored row columns (for the reminder cron). Null when not recurring. */
export function specFromRow(row: {
  recurrence_interval?: string | null; recurrence_custom_every?: number | null; recurrence_custom_unit?: string | null;
}): RecurrenceSpec | null {
  const interval = row.recurrence_interval as RecurrenceInterval | null | undefined;
  if (!interval || !INTERVALS.includes(interval)) return null;
  return {
    interval,
    customEvery: row.recurrence_custom_every ?? null,
    customUnit: (row.recurrence_custom_unit as 'day' | 'month' | null) ?? null,
  };
}

export interface RecurrenceInput {
  recurrence_enabled?: boolean;
  recurrence_interval?: string | null;
  recurrence_custom_every?: number | null;
  recurrence_custom_unit?: string | null;
  recurrence_start?: string | null;
  recurrence_reminder_email?: boolean;
}

/**
 * Validate + normalise recurrence fields from an API payload into the columns to
 * persist. Quotes (and disabled invoices) store the "off" shape. Throws a 400 on
 * a bad combination. `issueDate`/`today` default the start and compute next_invoice_date.
 */
export function normalizeRecurrence(
  input: RecurrenceInput, docType: 'invoice' | 'quote', issueDate: string, todayIso: string,
): RecurrenceColumns {
  const off: RecurrenceColumns = {
    recurrence_enabled: false, recurrence_interval: null, recurrence_custom_every: null,
    recurrence_custom_unit: null, recurrence_start: null, next_invoice_date: null, recurrence_reminder_email: true,
  };
  if (docType !== 'invoice' || !input.recurrence_enabled) return off;

  const interval = input.recurrence_interval as RecurrenceInterval | undefined;
  if (!interval || !INTERVALS.includes(interval)) {
    throw new AppError(400, 'Choose how often this invoice repeats', 'RECURRENCE');
  }
  let customEvery: number | null = null;
  let customUnit: 'day' | 'month' | null = null;
  if (interval === 'custom') {
    customEvery = Math.floor(Number(input.recurrence_custom_every));
    customUnit = input.recurrence_custom_unit === 'day' ? 'day' : input.recurrence_custom_unit === 'month' ? 'month' : null;
    if (!Number.isFinite(customEvery) || customEvery < 1 || customEvery > 366) {
      throw new AppError(400, 'Enter how many days/months between invoices (1–366)', 'RECURRENCE');
    }
    if (!customUnit) throw new AppError(400, 'Choose days or months for the custom interval', 'RECURRENCE');
  }
  const start = input.recurrence_start && ISO_RE.test(input.recurrence_start) ? input.recurrence_start : issueDate;
  const spec: RecurrenceSpec = { interval, customEvery, customUnit };
  return {
    recurrence_enabled: true,
    recurrence_interval: interval,
    recurrence_custom_every: customEvery,
    recurrence_custom_unit: customUnit,
    recurrence_start: start,
    next_invoice_date: firstFutureFrom(start, spec, todayIso),
    recurrence_reminder_email: input.recurrence_reminder_email !== false,
  };
}
