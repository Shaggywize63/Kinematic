/**
 * Small pure helpers shared by the "plus" CRM analytics services
 * (analytics-leads-plus.service.ts). Nothing here touches the database, so
 * every function is unit-testable and the arithmetic of the reports can be
 * asserted exactly.
 */
import { AppError } from '../../utils';

export const DAY_MS = 86_400_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses that end a lead's life (same set the neighbouring analytics treat as "closed"). */
export const CLOSED_LEAD_STATUSES = ['converted', 'lost', 'unqualified'] as const;
/** Statuses a lead can be reopened from / counted as "moved to lost" in the recycling report. */
export const NEGATIVE_LEAD_STATUSES = ['lost', 'unqualified'] as const;

export const isOpenLeadStatus = (status: string | null | undefined): boolean =>
  !(CLOSED_LEAD_STATUSES as readonly string[]).includes(String(status ?? '').toLowerCase());

/** Reject anything that is not a UUID before it is ever used in a PostgREST filter. */
export function assertUuid(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(400, `${name} must be a valid id`, 'VALIDATION');
  return v;
}

/** Whole-number query parameter with bounds; anything else is a 400, never a silent clamp. */
export function intParam(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(400, `${name} must be a whole number between ${min} and ${max}`, 'VALIDATION');
  }
  return n;
}

/** One of a fixed list of values; anything else is a 400. */
export function enumParam<T extends string>(v: unknown, name: string, allowed: readonly T[], def: T): T {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new AppError(400, `${name} must be one of: ${allowed.join(', ')}`, 'VALIDATION');
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function startIso(v?: string): string | null {
  if (!v) return null;
  const s = DATE_ONLY.test(v) ? `${v}T00:00:00.000Z` : v;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
function endIso(v?: string): string | null {
  if (!v) return null;
  // A date-only upper bound means "through the end of that day" — comparing a
  // timestamp column with a bare date would silently drop the whole last day.
  const s = DATE_ONLY.test(v) ? `${v}T23:59:59.999Z` : v;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface PlusWindow { fromIso: string; toIso: string; fromMs: number; toMs: number; days: number }

/**
 * Resolve an optional {from,to} into a concrete inclusive window. Date-only
 * bounds are expanded to whole UTC days; a missing `from` defaults to
 * `defaultDays` before `to`; a missing `to` is "now". from > to is a 400.
 */
export function resolveWindow(range: { from?: string; to?: string } | undefined, defaultDays = 30, nowMs = Date.now()): PlusWindow {
  const to = endIso(range?.to);
  const toMs = to ? Date.parse(to) : nowMs;
  const from = startIso(range?.from);
  const fromMs = from ? Date.parse(from) : toMs - defaultDays * DAY_MS;
  if (fromMs > toMs) throw new AppError(400, 'from must not be after to', 'VALIDATION');
  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    days: Math.max(1, Math.round((toMs - fromMs) / DAY_MS)),
  };
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** a / b as a percentage with one decimal; null when there is nothing to divide by. */
export function pct(a: number, b: number): number | null {
  return b > 0 ? round1((a / b) * 100) : null;
}

export function avg(nums: number[]): number | null {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

/** Proper median (mean of the two middle values for an even count); null for an empty list. */
export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..100); null for an empty list. */
export function percentile(nums: number[], p: number): number | null {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const rank = Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length)));
  return s[rank - 1];
}

export const monthKey = (iso: string): string => iso.slice(0, 7);

/** The Monday (UTC) of the week containing `ms`, as YYYY-MM-DD. */
export function mondayOf(ms: number): string {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay() || 7; // Sunday -> 7
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

/** Collapse the many activity `type` spellings onto the categories the reports show. */
export type ActivityBucket = 'call' | 'email' | 'meeting' | 'site_visit' | 'task' | 'note' | 'message' | 'other';
export function activityBucket(type: string | null | undefined): ActivityBucket {
  const t = String(type ?? '').toLowerCase().trim();
  if (t === 'call') return 'call';
  if (t === 'email') return 'email';
  if (t === 'meeting') return 'meeting';
  if (t === 'site_visit' || t === 'visit' || t === 'site visit') return 'site_visit';
  if (t === 'task') return 'task';
  if (t === 'note') return 'note';
  if (t === 'sms' || t === 'whatsapp') return 'message';
  return 'other';
}

/**
 * A call counts as "connected" when its recorded outcome starts with
 * "connected" (the disposition convention used by the Telecaller report).
 * Calls with no outcome are not counted either way.
 */
export function callOutcome(outcome: string | null | undefined): 'connected' | 'not_connected' | 'none' {
  const o = String(outcome ?? '').toLowerCase().replace(/[–—]/g, '-').trim();
  if (!o) return 'none';
  return o.startsWith('connected') ? 'connected' : 'not_connected';
}

/** Whole-day bucket for "days to convert" style distributions. */
export const DAY_BUCKETS: Array<{ bucket: string; max: number }> = [
  { bucket: '<1d', max: 0 },
  { bucket: '1–3d', max: 3 },
  { bucket: '4–7d', max: 7 },
  { bucket: '8–14d', max: 14 },
  { bucket: '15–30d', max: 30 },
  { bucket: '31–60d', max: 60 },
  { bucket: '60d+', max: Infinity },
];
export function dayBucket(days: number): string {
  const whole = Math.floor(Math.max(0, days));
  return (DAY_BUCKETS.find((b) => whole <= b.max) ?? DAY_BUCKETS[DAY_BUCKETS.length - 1]).bucket;
}

/** Deal-size bands in INR (plain bins, not benchmarks). */
export const DEAL_SIZE_BANDS: Array<{ bucket: string; min: number; max: number }> = [
  { bucket: 'No amount', min: -Infinity, max: 0 },
  { bucket: 'Under ₹10K', min: 0, max: 10_000 },
  { bucket: '₹10K–50K', min: 10_000, max: 50_000 },
  { bucket: '₹50K–1L', min: 50_000, max: 100_000 },
  { bucket: '₹1L–5L', min: 100_000, max: 500_000 },
  { bucket: '₹5L–10L', min: 500_000, max: 1_000_000 },
  { bucket: '₹10L+', min: 1_000_000, max: Infinity },
];
export function dealSizeBand(amount: number): string {
  if (!(amount > 0)) return 'No amount';
  const b = DEAL_SIZE_BANDS.find((x) => x.min > -Infinity && amount >= x.min && amount < x.max);
  return (b ?? DEAL_SIZE_BANDS[DEAL_SIZE_BANDS.length - 1]).bucket;
}
