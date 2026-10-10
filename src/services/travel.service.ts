/**
 * Distance travelled in a day — PURE logic (plus an orchestrator that takes its data fetchers as
 * arguments), so it is unit-testable with no database. The DB-facing wrapper is travel.store.ts.
 *
 * Definition. For one user on one IST day that has an attendance row, the ANCHORS in time order are
 *
 *   attendance check-in
 *   → for each form visit inside the shift window [checkin_at, checkout_at ?? now] that has both
 *     `check_in_at` and `check_out_at` and a coordinate:  form check-in, form check-out
 *   → attendance check-out  (or "now" while the shift is still open)
 *
 * A LEG is the travel between two consecutive anchors where the user is NOT at a form:
 *   (attendance check-in → first form check-in), (form_k check-out → form_k+1 check-in),
 *   (last form check-out → attendance check-out). With no forms there is one leg, check-in → check-out.
 * A visit that overlaps the previous one (or is out of order) gets no leg of its own.
 *
 * Leg km. The user's `work_activity` fixes inside the leg's time range (plus the two anchor points)
 * are summed with sumTrailKm — the very guards the expense mileage suggestion uses (mock/suspect
 * fixes skipped; hops > 20 km, gaps > 15 min and speeds > 150 km/h dropped). When the trail cannot
 * carry the leg the straight-line haversine between the two anchors is used instead
 * (method `straight_line`), and when even that is impossible the leg is 0 km / `none`.
 *
 * Interpretation notes (where the definition leaves room):
 *   - "the trail cannot carry the leg" = fewer than 2 usable (non-mock) fixes strictly inside the
 *     leg, OR no segment of it survived the guards (e.g. every fix was a long gap apart). Counting
 *     the anchors as "usable points" would make a trail-less leg look like a 2-point trail.
 *   - A shift with no check-out that is more than 24 h old is a forgotten check-out: it is not
 *     "in progress", the window is capped at 24 h after check-in, and there is no final leg.
 *   - A coordinate of exactly (0, 0) is the apps' "no fix" placeholder and is treated as missing.
 *   - A visit with no coordinate at all is skipped (the legs around it simply span it).
 *
 * Halts (EFocus wave 2). The same pings also yield the places the person STOPPED (haltDetection.ts):
 * the usable (non-mock, non-suspect) fixes inside the shift plus the attendance check-in / check-out
 * points, minus halts that are really a customer visit. Halts are reported separately from the legs and
 * never change `total_km`. The ordered ping sequence they were found in is also returned
 * (computeDayTravel's `path`) so the daily report can draw the route from the SAME data.
 */
import { istDateOf } from './attendanceRules.service';
import { parseVisitTimestamp, parseLatLng, toLatLng, type LatLng } from './formVisit.service';
import { haversineKm, sumTrailKm, type TrailFix } from './expenses/trail';
import { detectHalts, type Halt } from './haltDetection';

const DAY_MS = 86_400_000;
/** An open shift older than this is treated as a forgotten check-out. */
export const OPEN_SHIFT_MAX_MS = DAY_MS;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Today's date in IST ('YYYY-MM-DD'). */
export const istToday = (nowMs: number = Date.now()): string => istDateOf(nowMs) as string;

// ── shapes ────────────────────────────────────────────────────────────────

export type LegMethod = 'gps_trail' | 'straight_line' | 'none';
export type TravelMethod = LegMethod | 'mixed';

export interface TravelAnchorOut<K extends string> {
  kind: K;
  at: string;
  lat: number | null;
  lng: number | null;
  label: string;
}

export interface TravelLeg {
  index: number;
  km: number;
  method: LegMethod;
  from: TravelAnchorOut<'checkin' | 'form_checkout'>;
  to: TravelAnchorOut<'form_checkin' | 'checkout' | 'now'>;
}

export interface TravelStop {
  submission_id: string;
  label: string;
  check_in_at: string;
  check_out_at: string;
  minutes: number;
  /** Where the form was checked in (the visit location). */
  lat: number;
  lng: number;
}

export interface DayTravel {
  date: string;
  user_id: string;
  attendance_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  in_progress: boolean;
  total_km: number;
  method: TravelMethod;
  legs: TravelLeg[];
  stops: TravelStop[];
  /** Places the person stopped (see haltDetection.ts); not part of the legs or of total_km. */
  halts: Halt[];
  points_used: number;
  points_excluded: number;
}

/** The attendance columns this service reads. */
export interface TravelAttendanceRow {
  id: string;
  status?: string | null;
  checkin_at?: string | null;
  checkout_at?: string | null;
  checkin_lat?: unknown;
  checkin_lng?: unknown;
  checkout_lat?: unknown;
  checkout_lng?: unknown;
  // Not read by the travel maths — the daily report reads them off a full `select('*')` row.
  total_hours?: unknown;
  break_minutes?: unknown;
  transport_mode?: unknown;
}

/** A row of `form_submissions` ('form') or `builder_submissions` ('builder') as the DB returns it. */
export interface RawVisitRow {
  source: 'form' | 'builder';
  row: Record<string, any>;
}

/** A `work_activity` row. */
export interface TrailRow {
  lat: unknown;
  lng: unknown;
  captured_at: string | number;
  is_mock?: boolean | null;
  is_suspect?: boolean | null;
  /** HEARTBEAT / CHECK_IN / ... — only used to collapse repeated heartbeats on the route. */
  activity_type?: string | null;
}

/** Data access, injected so the service needs no database in tests. */
export interface TravelFetchers {
  /** The user's attendance row for an IST date (null when none). */
  attendance(userId: string, date: string): Promise<TravelAttendanceRow | null>;
  /** Form visits (both tables) of the user whose check-in lies in [fromIso, toIso] and that have a check-out. */
  visits(userId: string, fromIso: string, toIso: string): Promise<RawVisitRow[]>;
  /** The user's work_activity fixes with captured_at in [fromIso, toIso], oldest first. */
  trail(userId: string, fromIso: string, toIso: string): Promise<TrailRow[]>;
}

// ── shift window ──────────────────────────────────────────────────────────

export interface ShiftWindow {
  startMs: number;
  endMs: number;
  /** No check-out recorded. */
  open: boolean;
  /** Open, but long enough ago that the check-out was evidently forgotten. */
  stale: boolean;
  /** Open and recent: the "now" end applies. */
  inProgress: boolean;
}

/** The time span of the shift, or null when the row has no usable check-in (or ends before it starts). */
export function shiftWindow(att: TravelAttendanceRow, nowMs: number): ShiftWindow | null {
  const startMs = parseVisitTimestamp(att.checkin_at);
  if (startMs == null) return null;
  const outMs = parseVisitTimestamp(att.checkout_at);
  if (outMs != null) {
    if (outMs < startMs) return null;
    return { startMs, endMs: outMs, open: false, stale: false, inProgress: false };
  }
  const stale = nowMs - startMs > OPEN_SHIFT_MAX_MS;
  const endMs = stale ? startMs + OPEN_SHIFT_MAX_MS : Math.max(nowMs, startMs);
  return { startMs, endMs, open: true, stale, inProgress: !stale };
}

// ── visits ────────────────────────────────────────────────────────────────

interface Visit {
  id: string;
  label: string;
  inMs: number;
  outMs: number;
  inPt: LatLng;
  outPt: LatLng;
}

function titleOf(row: Record<string, any>): string | null {
  const bf = Array.isArray(row.builder_forms) ? row.builder_forms[0] : row.builder_forms;
  const t = bf && typeof bf.title === 'string' ? bf.title.trim() : '';
  return t || null;
}

/**
 * A usable visit: both times valid with out ≥ in, and a coordinate. Coordinates come from
 * check_in_gps / check_out_gps ("lat,lng"), else latitude/longitude (forms) / location_lat/lng
 * (builder submissions); a missing end reuses the other end.
 */
export function normalizeVisit(raw: RawVisitRow): Visit | null {
  const r = raw.row ?? {};
  const inMs = parseVisitTimestamp(r.check_in_at);
  const outMs = parseVisitTimestamp(r.check_out_at);
  if (inMs == null || outMs == null || outMs < inMs) return null;
  const gIn = parseLatLng(r.check_in_gps);
  const gOut = parseLatLng(r.check_out_gps);
  const fallback = raw.source === 'builder' ? toLatLng(r.location_lat, r.location_lng) : toLatLng(r.latitude, r.longitude);
  const inPt = gIn ?? fallback ?? gOut;
  const outPt = gOut ?? fallback ?? gIn;
  if (!inPt || !outPt || r.id == null) return null;
  const label = titleOf(r) ?? (typeof r.outlet_name === 'string' && r.outlet_name.trim() ? r.outlet_name.trim() : 'Form visit');
  return { id: String(r.id), label, inMs, outMs, inPt, outPt };
}

// ── the computation ───────────────────────────────────────────────────────

interface Anchor {
  kind: 'checkin' | 'form_checkout' | 'form_checkin' | 'checkout' | 'now';
  at: number;
  pt: LatLng | null;
  label: string;
}

interface Fix { ms: number; lat: number; lng: number; is_mock: boolean; is_suspect: boolean; activity_type: string | null }

const iso = (ms: number): string => new Date(ms).toISOString();

function anchorOut<K extends string>(a: Anchor, pt: LatLng | null): TravelAnchorOut<K> {
  return { kind: a.kind as K, at: iso(a.at), lat: pt?.lat ?? null, lng: pt?.lng ?? null, label: a.label };
}

/** One point of the shift's ordered path: the check-in / check-out points and every usable fix between. */
export interface PathPing {
  ms: number;
  lat: number;
  lng: number;
  /** HEARTBEAT / CHECK_IN / CHECK_OUT / FORM_SUBMIT ...; the attendance punches are CHECK_IN / CHECK_OUT. */
  activity_type: string | null;
}

export interface DayTravelComputation {
  travel: DayTravel;
  /**
   * The ordered pings the halts were found in: attendance check-in point, the usable (non-mock,
   * non-suspect) fixes inside the shift, attendance check-out point. Empty when there is no usable shift.
   */
  path: PathPing[];
}

export interface BuildDayTravelInput {
  date: string;
  userId: string;
  attendance: TravelAttendanceRow | null;
  visits: RawVisitRow[];
  trail: TrailRow[];
  nowMs: number;
  /** Minimum halt length in minutes (clamped 3..120, default 10). */
  minHaltMinutes?: number;
}

/** Pure: compute a day's travel from already-fetched rows. */
export function buildDayTravel(input: BuildDayTravelInput): DayTravel {
  return computeDayTravel(input).travel;
}

/**
 * Pure: the day's travel AND the ordered path it was measured on. This is the one computation —
 * `buildDayTravel` and the daily report both read it.
 */
export function computeDayTravel(input: BuildDayTravelInput): DayTravelComputation {
  const { date, userId, attendance: att, nowMs } = input;
  const base: DayTravel = {
    date, user_id: userId, attendance_id: att?.id ?? null, started_at: null, ended_at: null, in_progress: false,
    total_km: 0, method: 'none', legs: [], stops: [], halts: [], points_used: 0, points_excluded: 0,
  };
  if (!att) return { travel: base, path: [] };

  const startMs = parseVisitTimestamp(att.checkin_at);
  const outMs = parseVisitTimestamp(att.checkout_at);
  base.started_at = startMs == null ? null : iso(startMs);
  base.ended_at = outMs == null ? null : iso(outMs);
  const win = shiftWindow(att, nowMs);
  if (!win) return { travel: base, path: [] };
  base.in_progress = win.inProgress;

  // Fixes inside the shift, oldest first, with usable numbers only.
  const trail: Fix[] = [];
  for (const t of input.trail ?? []) {
    const ms = typeof t.captured_at === 'number' ? t.captured_at : Date.parse(String(t.captured_at));
    const pt = toLatLng(t.lat, t.lng);
    if (!Number.isFinite(ms) || !pt || ms < win.startMs || ms > win.endMs) continue;
    trail.push({ ms, lat: pt.lat, lng: pt.lng, is_mock: !!t.is_mock, is_suspect: !!t.is_suspect, activity_type: typeof t.activity_type === 'string' ? t.activity_type : null });
  }
  trail.sort((a, b) => a.ms - b.ms);

  // Visits fully inside the shift, in time order.
  const visits = (input.visits ?? [])
    .map(normalizeVisit)
    .filter((v): v is Visit => !!v && v.inMs >= win.startMs && v.outMs <= win.endMs)
    .sort((a, b) => a.inMs - b.inMs || a.outMs - b.outMs);
  base.stops = visits.map((v) => ({
    submission_id: v.id, label: v.label, check_in_at: iso(v.inMs), check_out_at: iso(v.outMs),
    minutes: Math.round((v.outMs - v.inMs) / 60_000), lat: v.inPt.lat, lng: v.inPt.lng,
  }));

  let used = 0;
  let excluded = 0;

  /** Km, method and the resolved end point of one leg. */
  const legBetween = (from: Anchor, to: Anchor): { km: number; method: LegMethod; toPt: LatLng | null } => {
    const inRange = (t: number) => t > from.at && (to.kind === 'now' ? t <= to.at : t < to.at);
    const fixes = trail.filter((f) => inRange(f.ms));
    const valid = fixes.filter((f) => !f.is_mock && !f.is_suspect);
    used += valid.length;
    excluded += fixes.length - valid.length;

    // "now" has no recorded end point: the latest usable fix stands in for it.
    const toPt: LatLng | null = to.kind === 'now'
      ? (valid.length ? { lat: valid[valid.length - 1].lat, lng: valid[valid.length - 1].lng } : null)
      : to.pt;

    const pts: TrailFix[] = [];
    if (from.pt) pts.push({ lat: from.pt.lat, lng: from.pt.lng, captured_at: from.at });
    for (const f of fixes) pts.push({ lat: f.lat, lng: f.lng, captured_at: f.ms, is_mock: f.is_mock, is_suspect: f.is_suspect });
    if (to.kind !== 'now' && toPt) pts.push({ lat: toPt.lat, lng: toPt.lng, captured_at: to.at });
    const sum = sumTrailKm(pts);

    if (valid.length >= 2 && sum.segments_counted >= 1) return { km: round2(sum.km), method: 'gps_trail', toPt };
    if (from.pt && toPt) return { km: round2(haversineKm(from.pt.lat, from.pt.lng, toPt.lat, toPt.lng)), method: 'straight_line', toPt };
    return { km: 0, method: 'none', toPt };
  };

  const pushLeg = (from: Anchor, to: Anchor): void => {
    if (to.at <= from.at) return;                       // no time between the anchors: nothing travelled
    const r = legBetween(from, to);
    base.legs.push({
      index: base.legs.length, km: r.km, method: r.method,
      from: anchorOut<'checkin' | 'form_checkout'>(from, from.pt),
      to: anchorOut<'form_checkin' | 'checkout' | 'now'>(to, r.toPt),
    });
  };

  let cursor: Anchor = { kind: 'checkin', at: win.startMs, pt: toLatLng(att.checkin_lat, att.checkin_lng), label: 'Check-in' };
  for (const v of visits) {
    if (v.inMs >= cursor.at) {
      pushLeg(cursor, { kind: 'form_checkin', at: v.inMs, pt: v.inPt, label: v.label });
      cursor = { kind: 'form_checkout', at: v.outMs, pt: v.outPt, label: v.label };
    } else if (v.outMs > cursor.at) {
      // Overlaps the previous visit: no leg into it, but it moves where the rep last was.
      cursor = { kind: 'form_checkout', at: v.outMs, pt: v.outPt, label: v.label };
    }
    // else: wholly inside the previous visit — nothing to do.
  }

  if (!win.open) {
    pushLeg(cursor, { kind: 'checkout', at: win.endMs, pt: toLatLng(att.checkout_lat, att.checkout_lng), label: 'Check-out' });
  } else if (win.inProgress) {
    pushLeg(cursor, { kind: 'now', at: win.endMs, pt: null, label: 'Now' });
  }
  // (stale open shift: no recorded end, so no final leg)

  base.total_km = round2(base.legs.reduce((s, l) => s + l.km, 0));
  const methods = base.legs.map((l) => l.method).filter((m) => m !== 'none');
  base.method = !methods.length ? 'none'
    : methods.every((m) => m === 'gps_trail') ? 'gps_trail'
    : methods.every((m) => m === 'straight_line') ? 'straight_line'
    : 'mixed';
  base.points_used = used;
  base.points_excluded = excluded;

  // The path: attendance check-in point, the usable fixes, attendance check-out point. The punches are
  // normally also stored as CHECK_IN / CHECK_OUT fixes at the very same instant — not added twice.
  const usable = trail.filter((f) => !f.is_mock && !f.is_suspect);
  const path: PathPing[] = usable.map((f) => ({ ms: f.ms, lat: f.lat, lng: f.lng, activity_type: f.activity_type }));
  const inPt = toLatLng(att.checkin_lat, att.checkin_lng);
  if (inPt && path[0]?.ms !== win.startMs) path.unshift({ ms: win.startMs, lat: inPt.lat, lng: inPt.lng, activity_type: 'CHECK_IN' });
  const outPt = !win.open ? toLatLng(att.checkout_lat, att.checkout_lng) : null;
  if (outPt && path[path.length - 1]?.ms !== win.endMs) path.push({ ms: win.endMs, lat: outPt.lat, lng: outPt.lng, activity_type: 'CHECK_OUT' });

  base.halts = detectHalts(path, visits, { minMinutes: input.minHaltMinutes });
  return { travel: base, path };
}

export interface GetDayTravelParams {
  userId: string;
  date: string;
  nowMs?: number;
  /** Minimum halt length in minutes (clamped 3..120, default 10). */
  minHaltMinutes?: number;
}

/**
 * Fetch what is needed and compute the day's travel — and the path it was measured on — for `userId`
 * on the IST day `date` (the attendance row's `date`). `date` must already be a valid 'YYYY-MM-DD'.
 */
export async function getDayTravelComputation(fetchers: TravelFetchers, p: GetDayTravelParams): Promise<DayTravelComputation> {
  const nowMs = p.nowMs ?? Date.now();
  const attendance = await fetchers.attendance(p.userId, p.date);
  const win = attendance ? shiftWindow(attendance, nowMs) : null;
  if (!attendance || !win) {
    return computeDayTravel({ date: p.date, userId: p.userId, attendance, visits: [], trail: [], nowMs, minHaltMinutes: p.minHaltMinutes });
  }
  const fromIso = iso(win.startMs);
  const toIso = iso(win.endMs);
  const [visits, trail] = await Promise.all([
    fetchers.visits(p.userId, fromIso, toIso),
    fetchers.trail(p.userId, fromIso, toIso),
  ]);
  return computeDayTravel({ date: p.date, userId: p.userId, attendance, visits, trail, nowMs, minHaltMinutes: p.minHaltMinutes });
}

/** The day's travel for `userId` on the IST day `date` (see getDayTravelComputation). */
export async function getDayTravel(fetchers: TravelFetchers, p: GetDayTravelParams): Promise<DayTravel> {
  return (await getDayTravelComputation(fetchers, p)).travel;
}
