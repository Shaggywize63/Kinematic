/**
 * Form visit times (check-in / check-out on a form) — PURE logic, no I/O.
 *
 * `form_submissions` and `builder_submissions` already carry `check_in_at`, `check_out_at`,
 * `check_in_gps`, `check_out_gps` and `duration_minutes`; the apps send the first four. This module
 * turns whatever arrives into values that are safe to store and to total up, WITHOUT ever rejecting
 * a submission (old app builds must keep working):
 *
 *   - an unparseable timestamp                  -> null
 *   - a timestamp > 5 min in the future         -> the server's "now" (a skewed phone clock)
 *   - check_out earlier than check_in           -> both kept, duration_minutes null
 *   - check_in but no check_out, and the client's `form_checkin_required` rule is on
 *                                               -> check_out_at = server now
 *   - duration_minutes = round((out - in) / 60 000) whenever both are valid, and null when it
 *     would be negative or longer than 24 h.
 *
 * The DB-facing wrapper (reads the client's rule) is formVisit.store.ts.
 */
import { isValidYmd } from './attendanceRules.service';

/** A check-in / check-out may be at most this far ahead of the server clock before it is clamped. */
export const FORM_VISIT_FUTURE_SKEW_MS = 5 * 60_000;
/** A visit longer than this is not a real visit (a forgotten check-out): no duration is stored. */
export const FORM_VISIT_MAX_MS = 24 * 3_600_000;

// 'YYYY-MM-DD' + 'T' or ' ' + 'HH:MM[:SS[.fff…]]' + optional zone. A zone-less stamp is read as UTC —
// what Postgres does with a timestamptz literal on a UTC database — never in the server's local zone.
const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Epoch ms of a well-formed timestamp string, else null. Never throws. */
export function parseVisitTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = TS_RE.exec(v.trim());
  if (!m || !isValidYmd(m[1])) return null;
  let zone = (m[3] ?? 'Z').toUpperCase();
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    zone = `${zone[0]}${digits.slice(0, 2)}:${digits.length >= 4 ? digits.slice(2, 4) : '00'}`;
  }
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole minutes between two instants, or null when either is missing, out < in, or the gap is over 24 h. */
export function visitDurationMinutes(inMs: number | null | undefined, outMs: number | null | undefined): number | null {
  if (inMs == null || outMs == null || !Number.isFinite(inMs) || !Number.isFinite(outMs)) return null;
  const diff = outMs - inMs;
  if (diff < 0 || diff > FORM_VISIT_MAX_MS) return null;
  return Math.round(diff / 60_000);
}

export interface VisitTimes {
  check_in_at: string | null;
  check_out_at: string | null;
  duration_minutes: number | null;
}

export interface SanitiseOptions {
  /** Server clock (ms since epoch). */
  nowMs: number;
  /** The client's `form_checkin_required` rule: a check-in with no check-out is closed at `nowMs`. */
  autoCheckout: boolean;
}

/** Sanitise a submission's check-in / check-out pair. Never throws, never rejects. */
export function sanitiseVisitTimes(
  input: { check_in_at?: unknown; check_out_at?: unknown },
  opts: SanitiseOptions,
): VisitTimes {
  const limit = opts.nowMs + FORM_VISIT_FUTURE_SKEW_MS;
  const clamp = (ms: number | null): number | null => (ms != null && ms > limit ? opts.nowMs : ms);
  const inMs = clamp(parseVisitTimestamp(input.check_in_at));
  let outMs = clamp(parseVisitTimestamp(input.check_out_at));
  if (inMs != null && outMs == null && opts.autoCheckout) outMs = opts.nowMs;
  return {
    check_in_at: inMs == null ? null : new Date(inMs).toISOString(),
    check_out_at: outMs == null ? null : new Date(outMs).toISOString(),
    duration_minutes: visitDurationMinutes(inMs, outMs),
  };
}

/** Does this pair need the client's rule at all? (A valid check-in with no valid check-out.) */
export function mayAutoCheckout(input: { check_in_at?: unknown; check_out_at?: unknown }): boolean {
  return parseVisitTimestamp(input.check_in_at) != null && parseVisitTimestamp(input.check_out_at) == null;
}

/**
 * Make sure a stored submission row exposes the five visit fields (null when the row has none) and
 * compute `duration_minutes` for old rows that have both times but no stored duration. Mutates and
 * returns the row, like the other response enrichers.
 */
export function withVisitFields<T extends Record<string, any>>(row: T): T & {
  check_in_at: string | null; check_out_at: string | null;
  check_in_gps: string | null; check_out_gps: string | null; duration_minutes: number | null;
} {
  const r = row as any;
  r.check_in_at = r.check_in_at ?? null;
  r.check_out_at = r.check_out_at ?? null;
  r.check_in_gps = r.check_in_gps ?? null;
  r.check_out_gps = r.check_out_gps ?? null;
  if (r.duration_minutes == null) {
    const a = r.check_in_at ? Date.parse(String(r.check_in_at)) : NaN;
    const b = r.check_out_at ? Date.parse(String(r.check_out_at)) : NaN;
    r.duration_minutes = visitDurationMinutes(Number.isFinite(a) ? a : null, Number.isFinite(b) ? b : null);
  }
  return r;
}

// ── GPS ───────────────────────────────────────────────────────────────────

export interface LatLng { lat: number; lng: number }

/**
 * A usable coordinate: finite, in range, and not exactly (0, 0) — the "no fix" placeholder apps send
 * when location was unavailable (a real rep is never at Null Island).
 */
export function toLatLng(lat: unknown, lng: unknown): LatLng | null {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  if (a === 0 && b === 0) return null;
  return { lat: a, lng: b };
}

/** Parse the apps' "lat,lng" text (check_in_gps / check_out_gps / gps). */
export function parseLatLng(s: unknown): LatLng | null {
  if (typeof s !== 'string') return null;
  const parts = s.split(',');
  if (parts.length !== 2) return null;
  return toLatLng(parts[0].trim(), parts[1].trim());
}
