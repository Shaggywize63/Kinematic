/**
 * Field-Force analytics (plus) — PURE computation, no I/O.
 *
 * Everything here takes plain rows (already scoped to one org / the caller's
 * reps by the loaders in ffm-plus.data.ts) and returns the numbers the new FFM
 * widgets and report endpoints serve. Keeping it free of Supabase imports means
 * every formula is unit-testable with a handful of seeded rows
 * (tests/ffmAnalyticsPlusCompute.test.ts).
 *
 * Counting rules used throughout (stated in the dashboard descriptions too):
 *  - A "stop" is one planned outlet on one rep's plan. When an outlet is on
 *    several of a rep's plans for the same day (one plan per activity), it is
 *    ONE call: stops are collapsed per (rep, day, outlet) and the call counts as
 *    visited when any of its stops reached a visited status.
 *  - Visited statuses are the same four the existing FFM widgets use.
 *  - A visit is "productive" when the same rep booked a non-cancelled,
 *    non-draft order at that outlet on the visit date (IST).
 *  - Times are IST. Money is INR. Distances are km (plans) or metres (check-ins).
 *  - Medians are over the reps shown, so a comparison always names its basis.
 */
import { addDaysYmd, istParts, weekdayOf } from '../../services/attendanceRules.service';

// ── tiny numeric helpers ──────────────────────────────────────────────────

export const VISITED = new Set(['visited', 'completed', 'done', 'checked_out']);
export const isVisited = (status?: string | null): boolean => !!status && VISITED.has(String(status).toLowerCase());

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round0 = (n: number): number => Math.round(n);
/** Percentage to one decimal; 0 when the denominator is 0. */
export const pct = (num: number, den: number): number => (den > 0 ? round1((num / den) * 100) : 0);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function median(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
export function mean(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

/** 'HH:MM' for a minute-of-day (0..1439); null passes through. */
export function hhmm(minuteOfDay: number | null | undefined): string | null {
  if (minuteOfDay == null || !Number.isFinite(minuteOfDay)) return null;
  const m = Math.max(0, Math.min(1439, Math.round(minuteOfDay)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ── dates (all 'YYYY-MM-DD', IST) ─────────────────────────────────────────

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** Monday of the ISO week containing `ymd`. */
export function weekStartOf(ymd: string): string {
  return addDaysYmd(ymd, -((weekdayOf(ymd) + 6) % 7));
}

/** ISO week label such as '2026-W44' (same shape the existing AOV widget uses). */
export function isoWeekLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (t.getUTCDay() + 6) % 7;                 // Monday = 0
  t.setUTCDate(t.getUTCDate() - dayNum + 3);              // the Thursday of this week decides the year
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── row shapes ────────────────────────────────────────────────────────────

export interface RepLite { id: string; name: string; supervisor_id: string | null }

export interface Stop {
  plan_id: string;
  user_id: string;
  plan_date: string;
  territory_label: string | null;
  store_id: string | null;
  status: string | null;
  planned_duration_min: number | null;
  checkin_at: string | null;
  checkout_at: string | null;
  checkin_distance_m: number | null;
  geofence_radius_m: number | null;
}
export interface PlanLite { id: string; user_id: string; plan_date: string; km: number }
export interface OrderLite { salesman_id: string; outlet_id: string | null; revenue: number; day: string }
export interface AttLite {
  user_id: string; date: string; status: string | null;
  checkin_at: string | null; checkout_at: string | null; total_hours: number | null; is_regularised: boolean | null;
}

/** One physical call: (rep, day, outlet) with its stops merged. */
export interface Call {
  user_id: string; day: string; store_id: string | null; territory_label: string | null;
  visited: boolean;
  planned_duration_min: number | null;
  checkin_at: string | null; checkout_at: string | null;
  checkin_distance_m: number | null; geofence_radius_m: number | null;
}

/** Merge stops for the same rep + day + outlet into one call (outlets with no id never merge). */
export function collapseStops(stops: Stop[]): Call[] {
  const byKey = new Map<string, Call>();
  let anon = 0;
  for (const s of stops) {
    const key = s.store_id ? `${s.user_id}|${s.plan_date}|${s.store_id}` : `anon|${anon++}`;
    const visited = isVisited(s.status);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        user_id: s.user_id, day: s.plan_date, store_id: s.store_id, territory_label: s.territory_label, visited,
        planned_duration_min: s.planned_duration_min, checkin_at: s.checkin_at, checkout_at: s.checkout_at,
        checkin_distance_m: s.checkin_distance_m, geofence_radius_m: s.geofence_radius_m,
      });
      continue;
    }
    // Prefer the stop that was actually visited / carries the check-in evidence.
    if (visited && !cur.visited) {
      cur.visited = true;
      cur.checkin_at = s.checkin_at ?? cur.checkin_at;
      cur.checkout_at = s.checkout_at ?? cur.checkout_at;
      cur.checkin_distance_m = s.checkin_distance_m ?? cur.checkin_distance_m;
      cur.geofence_radius_m = s.geofence_radius_m ?? cur.geofence_radius_m;
    } else {
      cur.checkin_at = cur.checkin_at ?? s.checkin_at;
      cur.checkout_at = cur.checkout_at ?? s.checkout_at;
      cur.checkin_distance_m = cur.checkin_distance_m ?? s.checkin_distance_m;
      cur.geofence_radius_m = cur.geofence_radius_m ?? s.geofence_radius_m;
    }
    cur.planned_duration_min = cur.planned_duration_min ?? s.planned_duration_min;
    cur.territory_label = cur.territory_label ?? s.territory_label;
  }
  return Array.from(byKey.values());
}

export const orderKey = (userId: string, storeId: string | null | undefined, day: string) => `${userId}|${storeId ?? ''}|${day}`;
export function orderKeys(orders: OrderLite[]): Set<string> {
  const s = new Set<string>();
  for (const o of orders) if (o.salesman_id && o.outlet_id) s.add(orderKey(o.salesman_id, o.outlet_id, o.day));
  return s;
}
export const isProductive = (c: Call, keys: Set<string>): boolean => c.visited && !!c.store_id && keys.has(orderKey(c.user_id, c.store_id, c.day));

/** Minutes between check-in and check-out when both exist and the span is sane (0 < m <= 8h). */
export const MAX_DWELL_MIN = 480;
export function dwellMinutes(c: Pick<Call, 'checkin_at' | 'checkout_at'>): number | null {
  if (!c.checkin_at || !c.checkout_at) return null;
  const a = Date.parse(c.checkin_at); const b = Date.parse(c.checkout_at);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const m = (b - a) / 60_000;
  return m > 0 && m <= MAX_DWELL_MIN ? m : null;
}

// ── weekly trends ─────────────────────────────────────────────────────────

export interface WeekAdherence { week: string; week_start: string; planned: number; visited: number; missed: number; adherence_pct: number; active_reps: number }

export function weeklyAdherence(calls: Call[]): WeekAdherence[] {
  const by = new Map<string, { start: string; planned: number; visited: number; reps: Set<string> }>();
  for (const c of calls) {
    const start = weekStartOf(c.day);
    const cur = by.get(start) || { start, planned: 0, visited: 0, reps: new Set<string>() };
    cur.planned += 1;
    if (c.visited) cur.visited += 1;
    cur.reps.add(c.user_id);
    by.set(start, cur);
  }
  return Array.from(by.values()).sort((a, b) => a.start.localeCompare(b.start)).map((w) => ({
    week: isoWeekLabel(w.start), week_start: w.start, planned: w.planned, visited: w.visited,
    missed: Math.max(0, w.planned - w.visited), adherence_pct: pct(w.visited, w.planned), active_reps: w.reps.size,
  }));
}

export interface WeekProductive { week: string; week_start: string; visits: number; productive_visits: number; productive_pct: number }

export function weeklyProductive(calls: Call[], keys: Set<string>): WeekProductive[] {
  const by = new Map<string, { visits: number; productive: number }>();
  for (const c of calls) {
    if (!c.visited) continue;
    const start = weekStartOf(c.day);
    const cur = by.get(start) || { visits: 0, productive: 0 };
    cur.visits += 1;
    if (isProductive(c, keys)) cur.productive += 1;
    by.set(start, cur);
  }
  return Array.from(by.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([start, w]) => ({
    week: isoWeekLabel(start), week_start: start, visits: w.visits, productive_visits: w.productive, productive_pct: pct(w.productive, w.visits),
  }));
}

// ── outlet-level distributions ────────────────────────────────────────────

export interface BucketRow { bucket: string; outlets: number; share_pct: number }

export const RECENCY_BUCKETS = ['0–7 days', '8–14 days', '15–30 days', '31–60 days', '61–90 days', 'Not visited'] as const;

/** Outlets planned in the window, grouped by days since the last visited call (relative to `asOf`). */
export function outletRecency(calls: Call[], asOf: string): BucketRow[] {
  const last = new Map<string, string | null>();           // store -> latest visited day
  for (const c of calls) {
    if (!c.store_id) continue;
    if (!last.has(c.store_id)) last.set(c.store_id, null);
    if (c.visited) {
      const prev = last.get(c.store_id);
      if (!prev || c.day > prev) last.set(c.store_id, c.day);
    }
  }
  if (!last.size) return [];
  const counts = RECENCY_BUCKETS.map(() => 0);
  for (const day of last.values()) {
    if (!day) { counts[5] += 1; continue; }
    const d = daysBetween(day, asOf);
    counts[d <= 7 ? 0 : d <= 14 ? 1 : d <= 30 ? 2 : d <= 60 ? 3 : 4] += 1;
  }
  const total = last.size;
  return RECENCY_BUCKETS.map((b, i) => ({ bucket: b, outlets: counts[i], share_pct: pct(counts[i], total) }));
}

export const FREQUENCY_BUCKETS = ['Not visited', '1 visit', '2 visits', '3 visits', '4+ visits'] as const;

/** Outlets planned in the window by how many visits they got (one visit = one rep at the outlet on one day). */
export function visitFrequency(calls: Call[]): BucketRow[] {
  const visits = new Map<string, number>();
  for (const c of calls) {
    if (!c.store_id) continue;
    visits.set(c.store_id, (visits.get(c.store_id) || 0) + (c.visited ? 1 : 0));
  }
  if (!visits.size) return [];
  const counts = FREQUENCY_BUCKETS.map(() => 0);
  for (const n of visits.values()) counts[Math.min(n, 4)] += 1;
  const total = visits.size;
  return FREQUENCY_BUCKETS.map((b, i) => ({ bucket: b, outlets: counts[i], share_pct: pct(counts[i], total) }));
}

export interface HourRow { hour: number; hour_label: string; visits: number; share_pct: number }

/** Visited calls by IST hour of check-in (calls without a check-in time are left out). */
export function visitHours(calls: Call[]): HourRow[] {
  const byHour = new Map<number, number>();
  let total = 0;
  for (const c of calls) {
    if (!c.visited || !c.checkin_at) continue;
    const p = istParts(c.checkin_at);
    if (!p) continue;
    const h = Math.floor(p.minuteOfDay / 60);
    byHour.set(h, (byHour.get(h) || 0) + 1);
    total += 1;
  }
  return Array.from(byHour.entries()).sort((a, b) => a[0] - b[0]).map(([h, n]) => ({
    hour: h, hour_label: `${String(h).padStart(2, '0')}:00`, visits: n, share_pct: pct(n, total),
  }));
}

export interface ChurnRow { segment: string; outlets: number; revenue_last_30d_inr: number; revenue_prior_30d_inr: number }

/**
 * Outlets by ordering pattern: `cur` = orders in the latest window, `prior` = the window before it.
 * Retained = ordered in both; New / returning = only in the latest; Lapsed = only in the earlier one.
 */
export function outletChurn(cur: OrderLite[], prior: OrderLite[]): ChurnRow[] {
  const sum = (orders: OrderLite[]) => {
    const m = new Map<string, number>();
    for (const o of orders) if (o.outlet_id) m.set(o.outlet_id, (m.get(o.outlet_id) || 0) + o.revenue);
    return m;
  };
  const a = sum(cur); const b = sum(prior);
  if (!a.size && !b.size) return [];
  const seg = {
    retained: { outlets: 0, cur: 0, prior: 0 },
    fresh: { outlets: 0, cur: 0, prior: 0 },
    lapsed: { outlets: 0, cur: 0, prior: 0 },
  };
  for (const [id, rev] of a) {
    const p = b.get(id);
    const t = p === undefined ? seg.fresh : seg.retained;
    t.outlets += 1; t.cur += rev; t.prior += p ?? 0;
  }
  for (const [id, rev] of b) {
    if (a.has(id)) continue;
    seg.lapsed.outlets += 1; seg.lapsed.prior += rev;
  }
  const row = (segment: string, t: { outlets: number; cur: number; prior: number }): ChurnRow => ({
    segment, outlets: t.outlets, revenue_last_30d_inr: round0(t.cur), revenue_prior_30d_inr: round0(t.prior),
  });
  return [
    row('Retained (ordered in both)', seg.retained),
    row('New or returning (last 30 days only)', seg.fresh),
    row('Lapsed (earlier 30 days only)', seg.lapsed),
  ];
}

// ── attendance ────────────────────────────────────────────────────────────

export interface AttendanceStats {
  user_id: string;
  days_present: number;
  avg_checkin_min: number | null;
  avg_checkin_time: string | null;
  avg_checkout_min: number | null;
  avg_checkout_time: string | null;
  total_hours: number;
  hours_days: number;
  avg_hours: number | null;
  missed_checkouts: number;
  regularised_days: number;
}

const ABSENT_STATUSES = new Set(['absent', 'on_leave']);

/** Hours for one attendance row: the stored total_hours, else check-out minus check-in. */
export function attendanceHours(a: Pick<AttLite, 'total_hours' | 'checkin_at' | 'checkout_at'>): number | null {
  const stored = a.total_hours == null ? NaN : Number(a.total_hours);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (a.checkin_at && a.checkout_at) {
    const h = (Date.parse(a.checkout_at) - Date.parse(a.checkin_at)) / 3_600_000;
    if (Number.isFinite(h) && h > 0 && h <= 24) return h;
  }
  return null;
}

/** Per-user attendance roll-up. A present day has a check-in and is not absent / on leave. `today` = IST today. */
export function attendanceStats(rows: AttLite[], today: string): Map<string, AttendanceStats> {
  const out = new Map<string, AttendanceStats & { _in: number[]; _out: number[] }>();
  const seen = new Set<string>();
  for (const a of rows) {
    const status = String(a.status ?? '').toLowerCase();
    if (!a.checkin_at || ABSENT_STATUSES.has(status)) continue;
    const dayKey = `${a.user_id}|${a.date}`;
    if (seen.has(dayKey)) continue;                        // one row per rep per day
    seen.add(dayKey);
    let s = out.get(a.user_id);
    if (!s) {
      s = {
        user_id: a.user_id, days_present: 0, avg_checkin_min: null, avg_checkin_time: null, avg_checkout_min: null, avg_checkout_time: null,
        total_hours: 0, hours_days: 0, avg_hours: null, missed_checkouts: 0, regularised_days: 0, _in: [], _out: [],
      };
      out.set(a.user_id, s);
    }
    s.days_present += 1;
    const pin = istParts(a.checkin_at);
    if (pin) s._in.push(pin.minuteOfDay);
    if (a.checkout_at) {
      const pout = istParts(a.checkout_at);
      if (pout) s._out.push(pout.minuteOfDay);
    } else if (a.date < today) {
      s.missed_checkouts += 1;                             // a closed day with no check-out
    }
    const h = attendanceHours(a);
    if (h != null) { s.total_hours += h; s.hours_days += 1; }
    if (a.is_regularised) s.regularised_days += 1;
  }
  const result = new Map<string, AttendanceStats>();
  for (const s of out.values()) {
    const mi = mean(s._in); const mo = mean(s._out);
    result.set(s.user_id, {
      user_id: s.user_id, days_present: s.days_present,
      avg_checkin_min: mi == null ? null : round0(mi), avg_checkin_time: hhmm(mi),
      avg_checkout_min: mo == null ? null : round0(mo), avg_checkout_time: hhmm(mo),
      total_hours: round1(s.total_hours), hours_days: s.hours_days,
      avg_hours: s.hours_days ? round1(s.total_hours / s.hours_days) : null,
      missed_checkouts: s.missed_checkouts, regularised_days: s.regularised_days,
    });
  }
  return result;
}

// ── per-rep activity (the shared core of the rep widgets + reports) ───────

export interface RepActivityRow {
  fe_id: string;
  fe_name: string;
  supervisor_id: string | null;
  plans: number;
  planned_stops: number;
  visited_stops: number;
  missed_stops: number;
  adherence_pct: number;
  plan_days: number;
  active_days: number;
  zero_visit_days: number;
  productive_visits: number;
  productive_pct: number;
  orders: number;
  revenue_inr: number;
  aov_inr: number;
  order_days: number;
  orders_per_day: number;
  calls_per_day: number;
  km_total: number;
  km_per_visit: number;
  km_per_day: number;
  timed_visits: number;
  avg_dwell_min: number | null;
  avg_planned_min: number | null;
  under_2min_pct: number | null;
  onsite_min: number;
  onsite_hours: number;
  first_call_min: number | null;
  first_call_time: string | null;
  last_call_min: number | null;
  last_call_time: string | null;
  avg_span_hours: number | null;
  checkins: number;
  outside_geofence: number;
  outside_pct: number;
  max_distance_m: number;
  days_present: number;
  avg_hours: number | null;
  total_hours: number;
  avg_checkin_time: string | null;
  missed_checkouts: number;
}

/** Default geofence radius (m) the existing off-route widget applies when a stop has none stored. */
export const DEFAULT_GEOFENCE_M = 100;

export function repActivity(input: {
  reps: RepLite[]; calls: Call[]; plans: PlanLite[]; orders: OrderLite[]; attendance: AttLite[]; today: string;
}): RepActivityRow[] {
  const { reps, calls, plans, orders, attendance, today } = input;
  const keys = orderKeys(orders);
  const att = attendanceStats(attendance, today);

  const callsBy = new Map<string, Call[]>();
  for (const c of calls) (callsBy.get(c.user_id) ?? callsBy.set(c.user_id, []).get(c.user_id)!).push(c);
  const plansBy = new Map<string, PlanLite[]>();
  for (const p of plans) (plansBy.get(p.user_id) ?? plansBy.set(p.user_id, []).get(p.user_id)!).push(p);
  const ordersBy = new Map<string, OrderLite[]>();
  for (const o of orders) if (o.salesman_id) (ordersBy.get(o.salesman_id) ?? ordersBy.set(o.salesman_id, []).get(o.salesman_id)!).push(o);

  return reps.map((rep) => {
    const mine = callsBy.get(rep.id) ?? [];
    const myPlans = plansBy.get(rep.id) ?? [];
    const myOrders = ordersBy.get(rep.id) ?? [];
    const visited = mine.filter((c) => c.visited);
    const planDays = new Set(mine.map((c) => c.day));
    const activeDays = new Set(visited.map((c) => c.day));
    const productive = visited.filter((c) => isProductive(c, keys)).length;
    const revenue = myOrders.reduce((s, o) => s + o.revenue, 0);
    const orderDays = new Set(myOrders.map((o) => o.day));
    const km = myPlans.reduce((s, p) => s + p.km, 0);

    const dwell = visited.map((c) => ({ c, m: dwellMinutes(c) })).filter((x): x is { c: Call; m: number } => x.m != null);
    const planned = dwell.map((x) => x.c.planned_duration_min).filter((m): m is number => m != null && Number(m) > 0).map(Number);

    // Per active day: the earliest check-in and the latest activity (check-out, else check-in).
    const firsts: number[] = []; const lasts: number[] = []; const spans: number[] = [];
    for (const day of activeDays) {
      const ins: number[] = []; const outs: number[] = [];
      for (const c of visited) {
        if (c.day !== day) continue;
        const pi = c.checkin_at ? istParts(c.checkin_at) : null;
        const po = c.checkout_at ? istParts(c.checkout_at) : null;
        if (pi) { ins.push(pi.minuteOfDay); outs.push(pi.minuteOfDay); }
        if (po) outs.push(po.minuteOfDay);
      }
      if (ins.length) {
        const f = Math.min(...ins); const l = Math.max(...outs);
        firsts.push(f); lasts.push(l); spans.push(Math.max(0, l - f));
      }
    }

    const withDistance = visited.filter((c) => c.checkin_at && c.checkin_distance_m != null);
    const outside = withDistance.filter((c) => num(c.checkin_distance_m) > (num(c.geofence_radius_m) || DEFAULT_GEOFENCE_M));
    const a = att.get(rep.id);
    const first = mean(firsts); const last = mean(lasts); const span = mean(spans);

    return {
      fe_id: rep.id, fe_name: rep.name, supervisor_id: rep.supervisor_id,
      plans: myPlans.length,
      planned_stops: mine.length,
      visited_stops: visited.length,
      missed_stops: Math.max(0, mine.length - visited.length),
      adherence_pct: pct(visited.length, mine.length),
      plan_days: planDays.size,
      active_days: activeDays.size,
      zero_visit_days: Array.from(planDays).filter((d) => !activeDays.has(d)).length,
      productive_visits: productive,
      productive_pct: pct(productive, visited.length),
      orders: myOrders.length,
      revenue_inr: round0(revenue),
      aov_inr: myOrders.length ? round0(revenue / myOrders.length) : 0,
      order_days: orderDays.size,
      orders_per_day: orderDays.size ? round1(myOrders.length / orderDays.size) : 0,
      calls_per_day: activeDays.size ? round1(visited.length / activeDays.size) : 0,
      km_total: round1(km),
      km_per_visit: visited.length ? round1(km / visited.length) : 0,
      km_per_day: activeDays.size ? round1(km / activeDays.size) : 0,
      timed_visits: dwell.length,
      avg_dwell_min: dwell.length ? round1(dwell.reduce((s, x) => s + x.m, 0) / dwell.length) : null,
      avg_planned_min: planned.length ? round1(planned.reduce((s, m) => s + m, 0) / planned.length) : null,
      under_2min_pct: dwell.length ? pct(dwell.filter((x) => x.m < 2).length, dwell.length) : null,
      onsite_min: round1(dwell.reduce((s, x) => s + x.m, 0)),
      onsite_hours: round1(dwell.reduce((s, x) => s + x.m, 0) / 60),
      first_call_min: first == null ? null : round0(first), first_call_time: hhmm(first),
      last_call_min: last == null ? null : round0(last), last_call_time: hhmm(last),
      avg_span_hours: span == null ? null : round1(span / 60),
      checkins: withDistance.length,
      outside_geofence: outside.length,
      outside_pct: pct(outside.length, withDistance.length),
      max_distance_m: outside.length ? Math.max(...outside.map((c) => num(c.checkin_distance_m))) : 0,
      days_present: a?.days_present ?? 0,
      avg_hours: a?.avg_hours ?? null,
      total_hours: a?.total_hours ?? 0,
      avg_checkin_time: a?.avg_checkin_time ?? null,
      missed_checkouts: a?.missed_checkouts ?? 0,
    };
  });
}

/** Median of a numeric field over the rows where `eligible` holds; null when no row qualifies. */
export function medianOf<T>(rows: T[], pick: (r: T) => number | null | undefined, eligible: (r: T) => boolean = () => true): number | null {
  const xs: number[] = [];
  for (const r of rows) if (eligible(r)) { const v = pick(r); if (v != null && Number.isFinite(v)) xs.push(v); }
  const m = median(xs);
  return m == null ? null : round1(m);
}

// ── supervisor roll-up ────────────────────────────────────────────────────

export interface SupervisorRow {
  supervisor_id: string | null;
  supervisor_name: string;
  reps: number;
  active_reps: number;
  planned_stops: number;
  visited_stops: number;
  adherence_pct: number;
  productive_visits: number;
  productive_pct: number;
  active_rep_days: number;
  calls_per_rep_day: number;
  orders: number;
  revenue_inr: number;
  revenue_per_rep_inr: number;
  days_present: number;
}

/** Group per-rep rows by supervisor. Reps with no supervisor on record form one "No supervisor" row. */
export function supervisorRollup(rows: RepActivityRow[], names: Map<string, string>): SupervisorRow[] {
  const groups = new Map<string, RepActivityRow[]>();
  for (const r of rows) {
    const k = r.supervisor_id ?? '';
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: SupervisorRow[] = [];
  for (const [k, g] of groups) {
    const sum = (f: (r: RepActivityRow) => number) => g.reduce((s, r) => s + f(r), 0);
    const visited = sum((r) => r.visited_stops);
    const planned = sum((r) => r.planned_stops);
    const productive = sum((r) => r.productive_visits);
    const repDays = sum((r) => r.active_days);
    const revenue = sum((r) => r.revenue_inr);
    out.push({
      supervisor_id: k || null,
      supervisor_name: k ? (names.get(k) || 'Supervisor') : 'No supervisor on record',
      reps: g.length,
      active_reps: g.filter((r) => r.visited_stops > 0).length,
      planned_stops: planned, visited_stops: visited, adherence_pct: pct(visited, planned),
      productive_visits: productive, productive_pct: pct(productive, visited),
      active_rep_days: repDays, calls_per_rep_day: repDays ? round1(visited / repDays) : 0,
      orders: sum((r) => r.orders), revenue_inr: round0(revenue),
      revenue_per_rep_inr: g.length ? round0(revenue / g.length) : 0,
      days_present: sum((r) => r.days_present),
    });
  }
  return out.sort((a, b) => b.visited_stops - a.visited_stops || a.supervisor_name.localeCompare(b.supervisor_name));
}

// ── outlet visit gaps (report) ────────────────────────────────────────────

export interface OutletGap {
  store_id: string;
  planned_calls: number;
  visited_calls: number;
  last_visit_date: string | null;
  days_since_last_visit: number | null;     // null = not visited in the window
  top_rep_id: string | null;                // the rep with most planned calls for this outlet
  last_order_date: string | null;
  orders: number;
  revenue_inr: number;
}

export function outletGaps(calls: Call[], orders: OrderLite[], asOf: string): OutletGap[] {
  const by = new Map<string, { planned: number; visited: number; last: string | null; reps: Map<string, number> }>();
  for (const c of calls) {
    if (!c.store_id) continue;
    const cur = by.get(c.store_id) || { planned: 0, visited: 0, last: null, reps: new Map<string, number>() };
    cur.planned += 1;
    cur.reps.set(c.user_id, (cur.reps.get(c.user_id) || 0) + 1);
    if (c.visited) { cur.visited += 1; if (!cur.last || c.day > cur.last) cur.last = c.day; }
    by.set(c.store_id, cur);
  }
  const ord = new Map<string, { last: string | null; n: number; rev: number }>();
  for (const o of orders) {
    if (!o.outlet_id) continue;
    const cur = ord.get(o.outlet_id) || { last: null, n: 0, rev: 0 };
    cur.n += 1; cur.rev += o.revenue; if (!cur.last || o.day > cur.last) cur.last = o.day;
    ord.set(o.outlet_id, cur);
  }
  return Array.from(by.entries()).map(([id, v]) => {
    const top = Array.from(v.reps.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const o = ord.get(id);
    return {
      store_id: id, planned_calls: v.planned, visited_calls: v.visited, last_visit_date: v.last,
      days_since_last_visit: v.last ? daysBetween(v.last, asOf) : null,
      top_rep_id: top ? top[0] : null,
      last_order_date: o?.last ?? null, orders: o?.n ?? 0, revenue_inr: round0(o?.rev ?? 0),
    };
  });
}
