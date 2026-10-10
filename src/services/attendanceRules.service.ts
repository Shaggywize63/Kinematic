/**
 * Attendance rules (per client) — PURE logic, no I/O.
 *
 * Stored at `clients.settings.attendance_rules` (jsonb):
 *   { shift_start, shift_end, grace_minutes, weekly_off, allow_offline_checkin }
 * Every key is optional; a missing key resolves to ATTENDANCE_RULES_DEFAULTS.
 * A client is `configured` iff it has an `attendance_rules` object at all — an
 * unconfigured client behaves exactly as before this feature existed (no `late`
 * key on records, legacy "before 10:00 IST" punctuality, server-time punches).
 *
 * This module has NO imports from the DB layer so it is unit-testable without a
 * database (see tests/attendanceRules.test.ts). The DB-facing wrapper lives in
 * attendanceRules.store.ts.
 *
 * Time zone: everything is Asia/Kolkata (UTC+05:30, no DST). Dates are
 * 'YYYY-MM-DD' strings; weekdays are 0=Sunday .. 6=Saturday.
 */

export interface AttendanceRules {
  shift_start: string;            // 'HH:MM' 24h
  shift_end: string;              // 'HH:MM' 24h
  grace_minutes: number;          // 0..120
  weekly_off: number[];           // subset of 0..6, sorted, unique
  allow_offline_checkin: boolean;
}

export interface ResolvedAttendanceRules {
  configured: boolean;
  rules: AttendanceRules;
}

export const ATTENDANCE_RULES_SETTINGS_KEY = 'attendance_rules';
export const ATTENDANCE_RULE_KEYS = ['shift_start', 'shift_end', 'grace_minutes', 'weekly_off', 'allow_offline_checkin'] as const;
export type AttendanceRuleKey = (typeof ATTENDANCE_RULE_KEYS)[number];

export const ATTENDANCE_RULES_DEFAULTS: Readonly<AttendanceRules> = Object.freeze({
  shift_start: '09:30',
  shift_end: '18:00',
  grace_minutes: 15,
  weekly_off: Object.freeze([0]) as unknown as number[],
  allow_offline_checkin: false,
});

export const ATTENDANCE_RULES_BOUNDS = Object.freeze({
  grace_minutes: Object.freeze({ min: 0, max: 120 }),
});

/** A fresh, mutable copy of the defaults. */
export function defaultAttendanceRules(): AttendanceRules {
  return { ...ATTENDANCE_RULES_DEFAULTS, weekly_off: [...ATTENDANCE_RULES_DEFAULTS.weekly_off] };
}

// ── time-zone helpers (IST) ───────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** IST calendar date ('YYYY-MM-DD') and minute-of-day (0..1439) of an instant. */
export function istParts(instant: number | string | Date): { date: string; minuteOfDay: number } | null {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + IST_OFFSET_MS);
  if (Number.isNaN(d.getTime())) return null;
  return { date: d.toISOString().slice(0, 10), minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** IST calendar date ('YYYY-MM-DD') of an instant, or null when unparseable. */
export function istDateOf(instant: number | string | Date): string | null {
  return istParts(instant)?.date ?? null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written exactly as 'YYYY-MM-DD'. */
export function isValidYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 'YYYY-MM-DD' shifted by `n` days. */
export function addDaysYmd(ymd: string, n: number): string {
  return new Date(ymdToUtcMs(ymd) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Weekday of a 'YYYY-MM-DD' date: 0=Sunday .. 6=Saturday. */
export function weekdayOf(ymd: string): number {
  return new Date(ymdToUtcMs(ymd)).getUTCDay();
}

/** Number of days in [from, to] inclusive (0 when to < from). */
export function inclusiveDayCount(from: string, to: string): number {
  const diff = Math.round((ymdToUtcMs(to) - ymdToUtcMs(from)) / DAY_MS);
  return diff < 0 ? 0 : diff + 1;
}

// ── validation ────────────────────────────────────────────────────────────

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for a strict 24h 'HH:MM' string, else null. */
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = HHMM_RE.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function validGrace(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
    && v >= ATTENDANCE_RULES_BOUNDS.grace_minutes.min && v <= ATTENDANCE_RULES_BOUNDS.grace_minutes.max;
}

function validWeeklyOff(v: unknown): v is number[] {
  return Array.isArray(v) && v.length <= 7 && v.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6);
}

const normWeeklyOff = (v: number[]): number[] => Array.from(new Set(v)).sort((a, b) => a - b);

export type RulesPatchResult =
  | { ok: true; patch: Partial<AttendanceRules> }
  | { ok: false; error: string };

/**
 * Validate a PATCH body: any NON-EMPTY subset of the 5 rule keys. The whole
 * request is rejected on the first invalid value (or unknown key) — a partial
 * save that silently drops a field is harder to debug than a loud 400.
 */
export function validateRulesPatch(body: unknown): RulesPatchResult {
  if (!isPlainObject(body)) return { ok: false, error: 'Body must be a JSON object' };
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !(ATTENDANCE_RULE_KEYS as readonly string[]).includes(k));
  if (unknown.length) {
    return { ok: false, error: `Unknown attendance rule key(s): ${unknown.join(', ')}. Allowed: ${ATTENDANCE_RULE_KEYS.join(', ')}` };
  }
  if (keys.length === 0) {
    return { ok: false, error: `Provide at least one of: ${ATTENDANCE_RULE_KEYS.join(', ')}` };
  }

  const patch: Partial<AttendanceRules> = {};
  if ('shift_start' in body) {
    if (parseHHMM(body.shift_start) === null) return { ok: false, error: 'shift_start must be a 24h time in HH:MM format (e.g. "09:30")' };
    patch.shift_start = body.shift_start as string;
  }
  if ('shift_end' in body) {
    if (parseHHMM(body.shift_end) === null) return { ok: false, error: 'shift_end must be a 24h time in HH:MM format (e.g. "18:00")' };
    patch.shift_end = body.shift_end as string;
  }
  if ('grace_minutes' in body) {
    if (!validGrace(body.grace_minutes)) {
      return { ok: false, error: `grace_minutes must be an integer between ${ATTENDANCE_RULES_BOUNDS.grace_minutes.min} and ${ATTENDANCE_RULES_BOUNDS.grace_minutes.max}` };
    }
    patch.grace_minutes = body.grace_minutes;
  }
  if ('weekly_off' in body) {
    if (!validWeeklyOff(body.weekly_off)) return { ok: false, error: 'weekly_off must be an array of weekday numbers 0 (Sunday) to 6 (Saturday)' };
    patch.weekly_off = normWeeklyOff(body.weekly_off);
  }
  if ('allow_offline_checkin' in body) {
    if (typeof body.allow_offline_checkin !== 'boolean') return { ok: false, error: 'allow_offline_checkin must be true or false' };
    patch.allow_offline_checkin = body.allow_offline_checkin;
  }
  return { ok: true, patch };
}

// ── resolution ────────────────────────────────────────────────────────────

/**
 * Resolve a client's rules from its `clients.settings` jsonb. A stored key that
 * is missing OR no longer valid (e.g. hand-edited in SQL) falls back to its
 * default, so a bad row can never break punctuality / the summary.
 */
export function resolveAttendanceRules(settings: unknown): ResolvedAttendanceRules {
  const stored = isPlainObject(settings) ? settings[ATTENDANCE_RULES_SETTINGS_KEY] : undefined;
  const rules = defaultAttendanceRules();
  if (!isPlainObject(stored)) return { configured: false, rules };
  if (parseHHMM(stored.shift_start) !== null) rules.shift_start = stored.shift_start as string;
  if (parseHHMM(stored.shift_end) !== null) rules.shift_end = stored.shift_end as string;
  if (validGrace(stored.grace_minutes)) rules.grace_minutes = stored.grace_minutes;
  if (validWeeklyOff(stored.weekly_off)) rules.weekly_off = normWeeklyOff(stored.weekly_off);
  if (typeof stored.allow_offline_checkin === 'boolean') rules.allow_offline_checkin = stored.allow_offline_checkin;
  return { configured: true, rules };
}

/**
 * Return a NEW `clients.settings` object with the patch merged into
 * `attendance_rules`. Every other settings key — and every other key already
 * inside `attendance_rules` — is preserved untouched. Only keys the admin set
 * are persisted (the rest keep resolving to defaults).
 */
export function mergeRulesIntoSettings(settings: unknown, patch: Partial<AttendanceRules>): Record<string, unknown> {
  const base = isPlainObject(settings) ? settings : {};
  const existing = isPlainObject(base[ATTENDANCE_RULES_SETTINGS_KEY]) ? (base[ATTENDANCE_RULES_SETTINGS_KEY] as Record<string, unknown>) : {};
  return { ...base, [ATTENDANCE_RULES_SETTINGS_KEY]: { ...existing, ...patch } };
}

/** The response body of GET/PATCH /org-settings/attendance-rules. */
export function rulesAdminView(resolved: ResolvedAttendanceRules) {
  return {
    configured: resolved.configured,
    rules: resolved.rules,
    defaults: defaultAttendanceRules(),
    bounds: { grace_minutes: { ...ATTENDANCE_RULES_BOUNDS.grace_minutes } },
  };
}

// ── late computation ──────────────────────────────────────────────────────

export interface LateInfo { is_late: boolean; minutes_late: number }

/**
 * Late info for a check-in instant under `rules`.
 *   is_late      = checkin_minute_of_day > shift_start + grace_minutes
 *   minutes_late = checkin_minute_of_day - shift_start   (0 when not late)
 * Granularity is the minute: seconds are ignored, so arriving at exactly
 * shift_start+grace (even 09:45:59 for 09:30 + 15) is still on time.
 * Returns null when the instant is unparseable.
 */
export function computeLate(checkinAt: number | string | Date | null | undefined, rules: AttendanceRules): LateInfo | null {
  if (checkinAt == null || checkinAt === '') return null;
  const p = istParts(checkinAt);
  if (!p) return null;
  const start = parseHHMM(rules.shift_start);
  if (start === null) return null;
  const isLate = p.minuteOfDay > start + rules.grace_minutes;
  return { is_late: isLate, minutes_late: isLate ? p.minuteOfDay - start : 0 };
}

/**
 * Punctuality bucket for ffm-analytics. Configured clients use their rules
 * (late = after shift_start + grace). Unconfigured clients keep the legacy
 * rule: a check-in before 10:00 IST is on time.
 */
export function classifyPunctuality(
  checkinAt: number | string | Date,
  resolved: ResolvedAttendanceRules | null | undefined,
): 'on_time' | 'late' {
  if (resolved?.configured) {
    const late = computeLate(checkinAt, resolved.rules);
    return late?.is_late ? 'late' : 'on_time';
  }
  const p = istParts(checkinAt);
  return p && p.minuteOfDay < 10 * 60 ? 'on_time' : 'late';
}

/**
 * Attach `late` to an attendance record IN PLACE (mirrors enrichWithHours) —
 * only when the client is configured AND the record has a check-in. Otherwise
 * the record is returned untouched (legacy clients see no new key).
 */
export function applyLate<T extends { checkin_at?: unknown }>(record: T, resolved: ResolvedAttendanceRules | null | undefined): T {
  if (!record || !resolved?.configured || !record.checkin_at) return record;
  const late = computeLate(record.checkin_at as string | number | Date, resolved.rules);
  if (late) (record as T & { late?: LateInfo }).late = late;
  return record;
}

// ── offline capture (captured_at) ─────────────────────────────────────────

/** captured_at may be at most this far in the future (clock skew). */
export const CAPTURED_AT_MAX_FUTURE_MS = 2 * MIN_MS;
/** captured_at may be at most this old. */
export const CAPTURED_AT_MAX_AGE_MS = 36 * 3_600_000;

// ISO-8601 with an EXPLICIT zone designator: without one `Date.parse` would
// read the stamp in the server's local zone, which is ambiguous.
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export type CapturedAtReason =
  | 'ok'
  | 'not_provided'
  | 'offline_not_allowed'
  | 'no_idempotency_key'
  | 'invalid_timestamp'
  | 'in_future'
  | 'too_old'
  | 'date_mismatch'
  | 'before_checkin';

export interface CapturedAtDecision {
  /** True when the caller must store `at` instead of server time. */
  used: boolean;
  /** The instant to store (only when `used`). */
  at: Date | null;
  reason: CapturedAtReason;
}

export interface CapturedAtInput {
  /** Raw `captured_at` from the request body. */
  capturedAt: unknown;
  /** Server clock (ms since epoch). */
  nowMs: number;
  /** The client's `allow_offline_checkin` rule (false when unconfigured). */
  allowOffline: boolean;
  /** Whether a non-empty Idempotency-Key header accompanied the request. */
  hasIdempotencyKey: boolean;
  kind: 'checkin' | 'checkout';
  /** Check-in only: the attendance date being written ('YYYY-MM-DD', IST). */
  attendanceDate?: string;
  /** Check-out only: the open record's checkin_at; a checkout may not precede it. */
  notBeforeMs?: number | null;
}

/**
 * Decide whether a client-supplied `captured_at` replaces server time for a
 * check-in / check-out. Honoured ONLY when ALL hold:
 *   - the client has allow_offline_checkin = true
 *   - an Idempotency-Key header is present (a replay can't double-punch)
 *   - captured_at is a well-formed ISO timestamp with a zone designator
 *   - it is not more than 2 minutes in the future
 *   - it is not older than 36 hours
 *   - check-in only: its IST date equals the attendance date being written
 *   - check-out only: it is not earlier than the shift's check-in
 * In every other case it is IGNORED (never an error) and server time is used.
 */
export function decideCapturedAt(input: CapturedAtInput): CapturedAtDecision {
  const no = (reason: CapturedAtReason): CapturedAtDecision => ({ used: false, at: null, reason });
  const { capturedAt } = input;
  if (capturedAt === undefined || capturedAt === null || capturedAt === '') return no('not_provided');
  if (!input.allowOffline) return no('offline_not_allowed');
  if (!input.hasIdempotencyKey) return no('no_idempotency_key');
  if (typeof capturedAt !== 'string' || !ISO_WITH_ZONE_RE.test(capturedAt.trim())) return no('invalid_timestamp');
  const ms = Date.parse(capturedAt.trim());
  if (!Number.isFinite(ms)) return no('invalid_timestamp');
  if (ms - input.nowMs > CAPTURED_AT_MAX_FUTURE_MS) return no('in_future');
  if (input.nowMs - ms > CAPTURED_AT_MAX_AGE_MS) return no('too_old');
  if (input.kind === 'checkin') {
    if (!input.attendanceDate || istDateOf(ms) !== input.attendanceDate) return no('date_mismatch');
  } else if (input.notBeforeMs != null && ms < input.notBeforeMs) {
    return no('before_checkin');
  }
  return { used: true, at: new Date(ms), reason: 'ok' };
}

// ── summary: working days, presence, absence ──────────────────────────────

/** Maximum span of GET /attendance/summary, inclusive days. */
export const SUMMARY_MAX_RANGE_DAYS = 62;

export type SummaryRangeResult =
  | { ok: true; from: string; to: string }
  | { ok: false; error: string };

/** Validate the from/to query params of the summary endpoint. */
export function validateSummaryRange(from: unknown, to: unknown): SummaryRangeResult {
  if (!isValidYmd(from) || !isValidYmd(to)) return { ok: false, error: 'from and to are required and must be dates in YYYY-MM-DD format' };
  if (to < from) return { ok: false, error: 'to must not be before from' };
  if (inclusiveDayCount(from, to) > SUMMARY_MAX_RANGE_DAYS) return { ok: false, error: `Range too large: at most ${SUMMARY_MAX_RANGE_DAYS} days` };
  return { ok: true, from, to };
}

/**
 * Working days in [from, min(to, todayIst)]: every date that is not one of
 * the client's weekly-off weekdays. Future dates never count.
 */
export function workingDaysInRange(from: string, to: string, todayIst: string, weeklyOff: readonly number[]): string[] {
  const end = to < todayIst ? to : todayIst;
  const out: string[] = [];
  if (end < from) return out;
  const off = new Set(weeklyOff);
  for (let d = from; d <= end; d = addDaysYmd(d, 1)) {
    if (!off.has(weekdayOf(d))) out.push(d);
  }
  return out;
}

export interface SummaryUserInput { id: string; name: string | null; created_at?: string | null }
export interface SummaryAttendanceInput { user_id: string; date: string; status?: string | null; checkin_at?: string | null }
export interface SummaryLeaveInput {
  user_id: string; from_date: string; to_date: string;
  half_day_start?: boolean | null; half_day_end?: boolean | null;
}

export interface AttendanceSummaryRow {
  user_id: string;
  name: string | null;
  working_days: number;
  present: number;
  late: number;
  half_day: number;
  on_leave: number;
  absent: number;
}

export interface AttendanceSummary {
  from: string;
  to: string;
  working_days: number;
  rows: AttendanceSummaryRow[];
}

// A row with one of these statuses is presence even without a stored check-in
// time (e.g. an approved regularisation).
const PRESENT_STATUSES = new Set(['present', 'checked_in', 'checked_out', 'on_break']);

type DayKind = 'present' | 'half_day' | 'on_leave' | 'absent';

function classifyRow(row: SummaryAttendanceInput): DayKind {
  const status = String(row.status ?? '').toLowerCase();
  if (status === 'on_leave') return 'on_leave';
  if (status === 'half_day') return 'half_day';
  if (status === 'absent') return 'absent';
  if (row.checkin_at || PRESENT_STATUSES.has(status)) return 'present';
  return 'absent';                // a row with no presence evidence is not a present day
}

/** The row for a (user, day) — prefers one with a check-in if duplicates exist. */
function pickRow(existing: SummaryAttendanceInput | undefined, next: SummaryAttendanceInput): SummaryAttendanceInput {
  if (!existing) return next;
  if (!existing.checkin_at && next.checkin_at) return next;
  return existing;
}

function leaveKindOn(leaves: SummaryLeaveInput[] | undefined, day: string): 'on_leave' | 'half_day' | null {
  if (!leaves) return null;
  let kind: 'on_leave' | 'half_day' | null = null;
  for (const l of leaves) {
    const from = String(l.from_date).slice(0, 10);
    const to = String(l.to_date).slice(0, 10);
    if (day < from || day > to) continue;
    const half = (!!l.half_day_start && day === from) || (!!l.half_day_end && day === to);
    if (!half) return 'on_leave';             // a full leave day wins over any half-day overlap
    kind = 'half_day';
  }
  return kind;
}

/**
 * Per-user attendance summary for [from, to].
 *
 *  - working_days (top level) = dates in [from, min(to, today IST)] that are not
 *    in the scope rules' weekly_off.
 *  - Per user, each working day is classified exactly once:
 *      attendance row  -> its status (on_leave / half_day / absent) or, with a
 *                         check-in, present (late is a SUBSET of present);
 *      no row          -> approved leave covering the day -> on_leave (half_day
 *                         on a half-day boundary), otherwise absent.
 *  - A day before the user's joining date (created_at, IST) is skipped unless
 *    the user actually has a row for it, so a new joiner is not "absent" for
 *    days before they existed. A user's own `working_days` is the number of
 *    days counted for them, so present+half_day+on_leave+absent = working_days.
 *  - Attendance on a weekly-off day is not counted (working days only).
 *  - Org holidays are NOT treated specially (the contract defines working days
 *    purely by weekly_off).
 *  - `rulesForUser` lets a mixed-client roster use each user's own client rules;
 *    it defaults to the scope rules.
 */
export function buildAttendanceSummary(opts: {
  from: string;
  to: string;
  todayIst: string;
  rules: AttendanceRules;
  rulesForUser?: (userId: string) => AttendanceRules;
  users: SummaryUserInput[];
  attendance: SummaryAttendanceInput[];
  leaves: SummaryLeaveInput[];
}): AttendanceSummary {
  const { from, to, todayIst, rules } = opts;

  const rowsByUserDay = new Map<string, Map<string, SummaryAttendanceInput>>();
  for (const a of opts.attendance) {
    const day = String(a.date).slice(0, 10);
    let m = rowsByUserDay.get(a.user_id);
    if (!m) { m = new Map(); rowsByUserDay.set(a.user_id, m); }
    m.set(day, pickRow(m.get(day), a));
  }
  const leavesByUser = new Map<string, SummaryLeaveInput[]>();
  for (const l of opts.leaves) {
    const list = leavesByUser.get(l.user_id);
    if (list) list.push(l); else leavesByUser.set(l.user_id, [l]);
  }

  const out: AttendanceSummaryRow[] = [];
  for (const u of opts.users) {
    const userRules = opts.rulesForUser ? opts.rulesForUser(u.id) : rules;
    const days = workingDaysInRange(from, to, todayIst, userRules.weekly_off);
    const joined = u.created_at ? istDateOf(u.created_at) : null;
    const userRows = rowsByUserDay.get(u.id);
    const userLeaves = leavesByUser.get(u.id);

    const row: AttendanceSummaryRow = { user_id: u.id, name: u.name ?? null, working_days: 0, present: 0, late: 0, half_day: 0, on_leave: 0, absent: 0 };
    for (const day of days) {
      const att = userRows?.get(day);
      if (!att && joined && day < joined) continue;       // before the user existed
      row.working_days += 1;
      if (att) {
        const kind = classifyRow(att);
        row[kind] += 1;
        if (kind === 'present' && att.checkin_at && computeLate(att.checkin_at, userRules)?.is_late) row.late += 1;
        continue;
      }
      const leave = leaveKindOn(userLeaves, day);
      if (leave) row[leave] += 1; else row.absent += 1;
    }
    out.push(row);
  }

  out.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }) || a.user_id.localeCompare(b.user_id));
  return { from, to, working_days: workingDaysInRange(from, to, todayIst, rules.weekly_off).length, rows: out };
}
