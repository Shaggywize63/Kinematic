/**
 * Daily travel report — PURE assembly (plus orchestrators that take their data fetchers as arguments), so
 * it is unit-testable with no database.
 *
 * The report is NOT a second computation: it is the day-travel service's result (travel.service.ts —
 * legs, km, visits, halts, and the ordered path they were measured on) laid out for a person to read:
 * who, the shift, the mode of transport, the distance, the customer visits, the halts, the route to draw
 * and a summary. Everything numeric in it comes from the same `computeDayTravel` that backs
 * GET /attendance/travel, so the two can never disagree.
 *
 *   - `route.points`: the shift's ordered path (attendance check-in point, usable fixes, check-out point),
 *     run through the same duplicate/"no fix" tidy-up as the Live Trailing trail (lib/trailThin.ts) and
 *     then, if more than ROUTE_MAX_POINTS remain, evenly down-sampled to ROUTE_MAX_POINTS keeping the
 *     first and last. `thinned` is true only when that cap dropped points.
 *   - `visits` are the travel service's `stops` (arrival / departure of the form check-in / check-out).
 *   - A day with no attendance is a normal answer: empty arrays, `shift.attendance_id: null`.
 *   - The team report is one row per person who has a shift that day, computed with bounded concurrency.
 */
import { collapseDuplicatePings } from '../lib/trailThin';
import { labelForTransportMode } from './transportMode.service';
import {
  computeDayTravel, getDayTravel, getDayTravelComputation, shiftWindow,
  type DayTravel, type DayTravelComputation, type PathPing, type TravelAttendanceRow, type TravelFetchers, type TravelLeg,
} from './travel.service';
import type { Halt } from './haltDetection';

/** Most points `route.points` carries. */
export const ROUTE_MAX_POINTS = 600;
/** Most people one team report covers. */
export const TEAM_REPORT_MAX_USERS = 300;
/** People computed in parallel by the team report. */
export const TEAM_REPORT_CONCURRENCY = 5;

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── shapes ────────────────────────────────────────────────────────────────

export interface ReportUser {
  id: string;
  name: string | null;
  employee_id: string | null;
  role: string | null;
}

export interface RoutePoint { lat: number; lng: number; at: string }

export interface DailyReportVisit {
  submission_id: string;
  label: string;
  arrival_at: string;
  departure_at: string;
  minutes: number;
  lat: number;
  lng: number;
}

export interface DailyReport {
  date: string;
  user: ReportUser;
  shift: {
    attendance_id: string | null;
    checkin_at: string | null;
    checkout_at: string | null;
    total_hours: number | null;
    in_progress: boolean;
  };
  transport: { mode: string | null; label: string | null };
  travel: { total_km: number; method: DayTravel['method']; legs: TravelLeg[] };
  visits: DailyReportVisit[];
  halts: Halt[];
  route: { points: RoutePoint[]; thinned: boolean };
  summary: { visits: number; visit_minutes: number; halts: number; halt_minutes: number; total_km: number };
}

export interface TeamReportRow {
  user_id: string;
  name: string | null;
  employee_id: string | null;
  checkin_at: string | null;
  checkout_at: string | null;
  total_hours: number | null;
  mode: string | null;
  label: string | null;
  total_km: number;
  visits: number;
  visit_minutes: number;
  halts: number;
  halt_minutes: number;
}

// ── pieces ────────────────────────────────────────────────────────────────

/**
 * The route to draw: the path tidied like the Live Trailing trail, then capped at `max` points by even
 * down-sampling (first and last always kept).
 */
export function thinRoute(path: ReadonlyArray<PathPing>, max: number = ROUTE_MAX_POINTS): { points: RoutePoint[]; thinned: boolean } {
  const cap = Math.max(2, Math.floor(max));
  const tidy = collapseDuplicatePings(path.map((p) => ({
    lat: p.lat, lng: p.lng, captured_at: new Date(p.ms).toISOString(), activity_type: p.activity_type,
  })));
  const toPoint = (r: { lat: number | null; lng: number | null; captured_at: string }): RoutePoint =>
    ({ lat: Number(r.lat), lng: Number(r.lng), at: r.captured_at });
  if (tidy.length <= cap) return { points: tidy.map(toPoint), thinned: false };
  const points: RoutePoint[] = [];
  for (let i = 0; i < cap; i++) points.push(toPoint(tidy[Math.round((i * (tidy.length - 1)) / (cap - 1))]));
  return { points, thinned: true };
}

/** The stored mode id of an attendance row, or null. */
export function storedTransportMode(att: TravelAttendanceRow | null | undefined): string | null {
  const m = att?.transport_mode;
  return typeof m === 'string' && m ? m : null;
}

/**
 * Hours worked: the stored `total_hours` when the row has one (it is set at check-out), else — for a
 * shift still in progress — check-in to now less break minutes. null when it cannot be known.
 */
export function shiftTotalHours(att: TravelAttendanceRow | null | undefined, travel: DayTravel, nowMs: number): number | null {
  const stored = att?.total_hours;
  if (stored !== null && stored !== undefined && stored !== '' && Number.isFinite(Number(stored))) return round2(Number(stored));
  if (!travel.started_at) return null;
  const startMs = Date.parse(travel.started_at);
  const endMs = travel.ended_at ? Date.parse(travel.ended_at) : travel.in_progress ? nowMs : null;
  if (endMs === null || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const breakMin = Number(att?.break_minutes);
  return round2(Math.max(0, (endMs - startMs) / 3_600_000 - (Number.isFinite(breakMin) ? breakMin : 0) / 60));
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export interface BuildDailyReportInput {
  date: string;
  user: ReportUser;
  /** The attendance row the travel was computed from (null = none that day). */
  attendance: TravelAttendanceRow | null;
  computation: DayTravelComputation;
  nowMs: number;
  /** Display label of a stored mode id; defaults to the fixed / default labels, else the id made readable. */
  modeLabel?: (mode: string) => string | null;
}

/** Pure: lay a day's travel computation out as the daily report. */
export function buildDailyReport(input: BuildDailyReportInput): DailyReport {
  const { travel, path } = input.computation;
  const hasShift = !!input.attendance;
  const mode = hasShift ? storedTransportMode(input.attendance) : null;
  const label = mode ? (input.modeLabel ? input.modeLabel(mode) : labelForTransportMode(mode)) : null;
  const route = thinRoute(path);
  const visits: DailyReportVisit[] = travel.stops.map((s) => ({
    submission_id: s.submission_id, label: s.label, arrival_at: s.check_in_at, departure_at: s.check_out_at,
    minutes: s.minutes, lat: s.lat, lng: s.lng,
  }));
  return {
    date: input.date,
    user: input.user,
    shift: {
      attendance_id: travel.attendance_id,
      checkin_at: travel.started_at,
      checkout_at: travel.ended_at,
      total_hours: hasShift ? shiftTotalHours(input.attendance, travel, input.nowMs) : null,
      in_progress: travel.in_progress,
    },
    transport: { mode, label },
    travel: { total_km: travel.total_km, method: travel.method, legs: travel.legs },
    visits,
    halts: travel.halts,
    route,
    summary: {
      visits: visits.length,
      visit_minutes: sum(visits.map((v) => v.minutes)),
      halts: travel.halts.length,
      halt_minutes: sum(travel.halts.map((h) => h.minutes)),
      total_km: travel.total_km,
    },
  };
}

/** The report of a day with nothing to report (no database reads). */
export function emptyDailyReport(date: string, user: ReportUser, nowMs: number = Date.now()): DailyReport {
  const computation = computeDayTravel({ date, userId: user.id, attendance: null, visits: [], trail: [], nowMs });
  return buildDailyReport({ date, user, attendance: null, computation, nowMs });
}

export interface GetDailyReportParams {
  userId: string;
  date: string;
  user: ReportUser;
  nowMs?: number;
  /** Minimum halt length in minutes (clamped 3..120, default 10). */
  minHaltMinutes?: number;
  modeLabel?: BuildDailyReportInput['modeLabel'];
}

/**
 * One person's report for an IST day. Reads the attendance row, form visits and GPS trail through
 * `fetchers` ONCE each (the row the travel was computed from is the row the shift / mode come from).
 */
export async function getDailyReport(fetchers: TravelFetchers, p: GetDailyReportParams): Promise<DailyReport> {
  const nowMs = p.nowMs ?? Date.now();
  const seen: { row: TravelAttendanceRow | null } = { row: null };
  const capturing: TravelFetchers = {
    ...fetchers,
    async attendance(userId, date) {
      seen.row = await fetchers.attendance(userId, date);
      return seen.row;
    },
  };
  const computation = await getDayTravelComputation(capturing, { userId: p.userId, date: p.date, nowMs, minHaltMinutes: p.minHaltMinutes });
  return buildDailyReport({ date: p.date, user: p.user, attendance: seen.row, computation, nowMs, modeLabel: p.modeLabel });
}

// ── team ──────────────────────────────────────────────────────────────────

/** `fn` over `items`, at most `limit` at a time, results in input order. The first rejection rejects the whole call. */
export async function mapWithConcurrency<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, worker));
  return out;
}

/** A person with a (possibly absent) attendance row for the date, as the team query returned it. */
export interface TeamReportMember {
  user_id: string;
  name: string | null;
  employee_id: string | null;
  attendance: TravelAttendanceRow | null;
}

export interface GetTeamReportParams {
  nowMs?: number;
  concurrency?: number;
  maxUsers?: number;
  minHaltMinutes?: number;
  /** Display label of a stored mode id for one person (their own policy's vehicle labels). */
  modeLabel?: (userId: string, mode: string) => string | null;
  date: string;
}

/**
 * The team table for an IST day: one row per member who has a shift that day (members with no
 * attendance row, or a row with no usable check-in, are skipped), at most `maxUsers` (300), computed
 * `concurrency` (5) at a time from the SAME travel service. The attendance rows are the ones the caller
 * already loaded, so only the visits and the GPS trail are read per person, through `fetchers`.
 * Rows come back sorted by name.
 */
export async function getTeamReport(
  fetchers: Pick<TravelFetchers, 'visits' | 'trail'>,
  members: ReadonlyArray<TeamReportMember>,
  p: GetTeamReportParams,
): Promise<TeamReportRow[]> {
  const nowMs = p.nowMs ?? Date.now();
  const withShift = members
    .filter((m) => !!m.attendance && !!shiftWindow(m.attendance, nowMs))
    .slice(0, p.maxUsers ?? TEAM_REPORT_MAX_USERS);
  const byUser = new Map(withShift.map((m) => [m.user_id, m.attendance as TravelAttendanceRow] as const));
  const preloaded: TravelFetchers = {
    ...fetchers,
    attendance: async (userId) => byUser.get(userId) ?? null,
  };

  const rows = await mapWithConcurrency(withShift, p.concurrency ?? TEAM_REPORT_CONCURRENCY, async (m): Promise<TeamReportRow> => {
    const travel = await getDayTravel(preloaded, { userId: m.user_id, date: p.date, nowMs, minHaltMinutes: p.minHaltMinutes });
    const mode = storedTransportMode(m.attendance);
    return {
      user_id: m.user_id,
      name: m.name,
      employee_id: m.employee_id,
      checkin_at: travel.started_at,
      checkout_at: travel.ended_at,
      total_hours: shiftTotalHours(m.attendance, travel, nowMs),
      mode,
      label: mode ? (p.modeLabel ? p.modeLabel(m.user_id, mode) : labelForTransportMode(mode)) : null,
      total_km: travel.total_km,
      visits: travel.stops.length,
      visit_minutes: sum(travel.stops.map((s) => s.minutes)),
      halts: travel.halts.length,
      halt_minutes: sum(travel.halts.map((h) => h.minutes)),
    };
  });

  return rows.sort((a, b) =>
    String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }) || a.user_id.localeCompare(b.user_id));
}
