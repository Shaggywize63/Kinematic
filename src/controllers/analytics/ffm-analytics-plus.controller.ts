/**
 * Field-Force Management analytics (plus) — /api/v1/analytics/ffm/*
 *
 * Twelve more widget datasets and eight report endpoints for the dashboard's FFM
 * Analytics section and FFM Reports pages. Additive: nothing here replaces a
 * handler in ffm-analytics.controller.ts. Mounted from ffm-analytics.routes.ts
 * behind the same `analytics` module gate.
 *
 * Conventions (same as the older handlers):
 *  - `{ success, data }` envelope; widgets return an array of rows, reports an object.
 *  - Demo org: early exit with an empty result (the dashboard's demo tenant is
 *    served by client-side mocks).
 *  - Sparse data never errors: nothing to report -> [] / zero totals.
 * Scope is ffm-plus.data.ts (org, client, supervisor subtree, reps see only
 * themselves); the arithmetic is ffm-plus.compute.ts. Rankings here are advisory:
 * every comparison row carries the evidence (counts) and the basis (team median).
 */
import { Response } from 'express';
import { AuthRequest } from '../../types';
import { ok, badRequest } from '../../utils';
import { asyncHandler } from '../../utils/asyncHandler';
import { isDemo } from '../../utils/demoData';
import {
  resolveScope, parseRange, parseUuidParam, parseIntParam, todayIst, addDaysYmd,
  loadReps, loadPlans, loadOrders, loadAttendance, loadUserNames, loadStores, loadSecurityAlerts, loadSuspectPings,
  type FfmScope,
} from './ffm-plus.data';
import {
  collapseStops, orderKeys, weeklyAdherence, weeklyProductive, outletRecency, visitFrequency, visitHours, outletChurn,
  attendanceStats, repActivity, medianOf, supervisorRollup, outletGaps, weekStartOf,
  pct, round0, round1, median, DEFAULT_GEOFENCE_M, type RepLite, type RepActivityRow, type Call,
} from './ffm-plus.compute';

// ── plumbing ──────────────────────────────────────────────────────────────

interface Ctx { scope: FfmScope; reps: RepLite[]; repIds: Set<string>; today: string }

const lastDays = (today: string, n: number) => ({ from: addDaysYmd(today, -(n - 1)), to: today });
/** Eight ISO weeks ending today (the latest one is week-to-date). */
const eightWeeks = (today: string) => ({ from: addDaysYmd(weekStartOf(today), -49), to: today });

/** A widget dataset: demo -> [], no reps in scope -> [], otherwise whatever `fn` returns. */
const widget = (fn: (c: Ctx) => Promise<unknown[]>) => asyncHandler<AuthRequest>(async (req, res) => {
  if (isDemo(req.user!)) return ok(res, []);
  const scope = await resolveScope(req);
  const reps = await loadReps(scope);
  if (!reps.length) return ok(res, []);
  return ok(res, await fn({ scope, reps, repIds: new Set(reps.map((r) => r.id)), today: todayIst() }));
});

interface ReportCtx extends Ctx { from: string; to: string; effectiveTo: string; req: AuthRequest }

/**
 * A report endpoint: validates from/to (400 on a bad range), short-circuits the demo org and an
 * empty roster to `empty(from, to)`, otherwise returns whatever `fn` builds.
 */
const report = (defaultDays: number | (() => number), empty: (from: string, to: string) => Record<string, unknown>, fn: (c: ReportCtx, res: Response) => Promise<unknown>) =>
  asyncHandler<AuthRequest>(async (req, res) => {
    const range = parseRange(req.query as Record<string, unknown>, typeof defaultDays === 'function' ? defaultDays() : defaultDays);
    if ('error' in range) return badRequest(res, range.error);
    const { from, to, effectiveTo } = range;
    if (isDemo(req.user!)) return ok(res, empty(from, effectiveTo));
    const scope = await resolveScope(req);
    const reps = await loadReps(scope);
    if (!reps.length || from > effectiveTo) return ok(res, empty(from, effectiveTo));
    const out = await fn({ scope, reps, repIds: new Set(reps.map((r) => r.id)), today: todayIst(), from, to, effectiveTo, req }, res);
    if (out !== undefined) return ok(res, out);
  });

const sumBy = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
const byName = <T extends { fe_name?: string }>(a: T, b: T) => String(a.fe_name ?? '').localeCompare(String(b.fe_name ?? ''), undefined, { sensitivity: 'base' });

// ══════════════════════════════════════════════════════════════════════════
// Widgets
// ══════════════════════════════════════════════════════════════════════════

/** GET /beat-adherence-trend — weekly visited ÷ planned calls, last 8 ISO weeks. */
export const beatAdherenceTrend = widget(async ({ scope, repIds, today }) => {
  const { from, to } = eightWeeks(today);
  const { stops } = await loadPlans(scope, repIds, from, to);
  return weeklyAdherence(collapseStops(stops));
});

/** GET /outlet-recency — outlets planned in the last 90 days by days since their last visit. */
export const outletRecencyWidget = widget(async ({ scope, repIds, today }) => {
  const { from, to } = lastDays(today, 90);
  const { stops } = await loadPlans(scope, repIds, from, to);
  return outletRecency(collapseStops(stops), to);
});

/** GET /visit-frequency — outlets planned in the last 30 days by number of days visited. */
export const visitFrequencyWidget = widget(async ({ scope, repIds, today }) => {
  const { from, to } = lastDays(today, 30);
  const { stops } = await loadPlans(scope, repIds, from, to);
  return visitFrequency(collapseStops(stops));
});

/** GET /productive-trend — weekly productive visits ÷ visits, last 8 ISO weeks. */
export const productiveTrend = widget(async ({ scope, repIds, today }) => {
  const { from, to } = eightWeeks(today);
  const [{ stops }, orders] = await Promise.all([loadPlans(scope, repIds, from, to), loadOrders(scope, repIds, from, to)]);
  return weeklyProductive(collapseStops(stops), orderKeys(orders));
});

/** GET /rep-basket — per rep orders, revenue and average order value (last 30 days). */
export const repBasket = widget(async ({ scope, reps, repIds, today }) => {
  const { from, to } = lastDays(today, 30);
  const orders = await loadOrders(scope, repIds, from, to);
  const agg = new Map<string, { n: number; rev: number; days: Set<string> }>();
  for (const o of orders) {
    const cur = agg.get(o.salesman_id) || { n: 0, rev: 0, days: new Set<string>() };
    cur.n += 1; cur.rev += o.revenue; cur.days.add(o.day);
    agg.set(o.salesman_id, cur);
  }
  const totalN = sumBy(Array.from(agg.values()), (a) => a.n);
  const teamAov = totalN ? sumBy(Array.from(agg.values()), (a) => a.rev) / totalN : 0;
  return reps
    .filter((r) => (agg.get(r.id)?.n ?? 0) > 0)
    .map((r) => {
      const a = agg.get(r.id)!;
      const aov = a.rev / a.n;
      return {
        fe_id: r.id, fe_name: r.name, orders: a.n, revenue_inr: round0(a.rev), aov_inr: round0(aov),
        active_days: a.days.size, orders_per_day: round1(a.n / a.days.size),
        vs_team_aov_pct: teamAov ? round1((aov / teamAov - 1) * 100) : 0,
      };
    })
    .sort((a, b) => b.revenue_inr - a.revenue_inr || byName(a, b));
});

/** Per-rep activity over the last `days` days (plans only — no orders / attendance). */
async function planActivity(c: Ctx, days: number): Promise<{ rows: RepActivityRow[]; calls: Call[] }> {
  const { from, to } = lastDays(c.today, days);
  const { plans, stops } = await loadPlans(c.scope, c.repIds, from, to);
  const calls = collapseStops(stops);
  return { calls, rows: repActivity({ reps: c.reps, calls, plans, orders: [], attendance: [], today: c.today }) };
}

/** GET /calls-per-day — per rep visited calls per active day vs the team median (last 14 days). */
export const callsPerDay = widget(async (c) => {
  const { rows } = await planActivity(c, 14);
  const active = rows.filter((r) => r.visited_stops > 0);
  const teamMedian = medianOf(active, (r) => r.calls_per_day);
  return active
    .map((r) => ({
      fe_id: r.fe_id, fe_name: r.fe_name, visit_days: r.active_days, visits: r.visited_stops, calls_per_day: r.calls_per_day,
      team_median: teamMedian ?? 0, vs_median: round1(r.calls_per_day - (teamMedian ?? 0)),
    }))
    .sort((a, b) => b.calls_per_day - a.calls_per_day || byName(a, b));
});

/** GET /dwell-time — per rep average minutes between check-in and check-out (last 14 days). */
export const dwellTime = widget(async (c) => {
  const { rows } = await planActivity(c, 14);
  return rows
    .filter((r) => r.timed_visits > 0)
    .map((r) => ({
      fe_id: r.fe_id, fe_name: r.fe_name, timed_visits: r.timed_visits, avg_dwell_min: r.avg_dwell_min ?? 0,
      avg_planned_min: r.avg_planned_min ?? 0, under_2min_pct: r.under_2min_pct ?? 0,
    }))
    .sort((a, b) => b.avg_dwell_min - a.avg_dwell_min || byName(a, b));
});

/** GET /visit-hours — visited calls by IST hour of check-in (last 14 days). */
export const visitHoursWidget = widget(async (c) => {
  const { calls } = await planActivity(c, 14);
  return visitHours(calls);
});

/** GET /travel-efficiency — per rep km, visits and km per visit (last 14 days). */
export const travelEfficiency = widget(async (c) => {
  const { rows } = await planActivity(c, 14);
  return rows
    .filter((r) => r.km_total > 0)
    .map((r) => ({
      fe_id: r.fe_id, fe_name: r.fe_name, km_total: r.km_total, visits: r.visited_stops, km_per_visit: r.km_per_visit,
      active_days: r.active_days, km_per_day: r.km_per_day,
    }))
    .sort((a, b) => b.km_total - a.km_total || byName(a, b));
});

/** GET /geo-exceptions — per rep check-ins made outside the outlet's geofence (last 14 days). */
export const geoExceptions = widget(async (c) => {
  const { rows } = await planActivity(c, 14);
  return rows
    .filter((r) => r.checkins > 0)
    .map((r) => ({
      fe_id: r.fe_id, fe_name: r.fe_name, checkins: r.checkins, outside_geofence: r.outside_geofence,
      outside_pct: r.outside_pct, max_distance_m: round0(r.max_distance_m),
    }))
    .sort((a, b) => b.outside_geofence - a.outside_geofence || b.outside_pct - a.outside_pct || byName(a, b));
});

/** GET /attendance-hours — per rep days present, average hours and check-in time (last 30 days). */
export const attendanceHours = widget(async ({ scope, reps, repIds, today }) => {
  const { from, to } = lastDays(today, 30);
  const stats = attendanceStats(await loadAttendance(scope, repIds, from, to), today);
  return reps
    .filter((r) => stats.has(r.id))
    .map((r) => {
      const s = stats.get(r.id)!;
      return {
        fe_id: r.id, fe_name: r.name, days_present: s.days_present, avg_hours: s.avg_hours ?? 0,
        avg_checkin_time: s.avg_checkin_time ?? '—', avg_checkin_min: s.avg_checkin_min ?? 0, missed_checkouts: s.missed_checkouts,
      };
    })
    .sort((a, b) => b.days_present - a.days_present || byName(a, b));
});

/** GET /outlet-churn — outlets by ordering pattern: last 30 days vs the 30 days before. */
export const outletChurnWidget = widget(async ({ scope, repIds, today }) => {
  const { from, to } = lastDays(today, 60);
  const orders = await loadOrders(scope, repIds, from, to);
  const split = addDaysYmd(today, -29);                    // latest window = [today-29, today]
  return outletChurn(orders.filter((o) => o.day >= split), orders.filter((o) => o.day < split));
});

// ══════════════════════════════════════════════════════════════════════════
// Reports  (GET /reports/*?from=&to=)
// ══════════════════════════════════════════════════════════════════════════

const medianBlock = (rows: RepActivityRow[]) => ({
  calls_per_day: medianOf(rows, (r) => r.calls_per_day, (r) => r.visited_stops > 0),
  adherence_pct: medianOf(rows, (r) => r.adherence_pct, (r) => r.planned_stops > 0),
  productive_pct: medianOf(rows, (r) => r.productive_pct, (r) => r.visited_stops > 0),
  aov_inr: medianOf(rows, (r) => r.aov_inr, (r) => r.orders > 0),
  avg_dwell_min: medianOf(rows, (r) => r.avg_dwell_min, (r) => r.timed_visits > 0),
  km_per_visit: medianOf(rows, (r) => r.km_per_visit, (r) => r.visited_stops > 0 && r.km_total > 0),
});

/** Everything a per-rep report needs for [from, effectiveTo]. */
async function activityFor(c: ReportCtx, repSubset?: RepLite[]) {
  const reps = repSubset ?? c.reps;
  const ids = new Set(reps.map((r) => r.id));
  const [{ plans, stops }, orders, attendance] = await Promise.all([
    loadPlans(c.scope, ids, c.from, c.effectiveTo),
    loadOrders(c.scope, ids, c.from, c.effectiveTo),
    loadAttendance(c.scope, ids, c.from, c.effectiveTo),
  ]);
  const calls = collapseStops(stops);
  const rows = repActivity({ reps, calls, plans, orders, attendance, today: c.today });
  return { rows, calls, orders, attendance };
}

/** Rep dropdown options for filters — always the full roster in view, not the filtered subset. */
const repOptions = (reps: RepLite[]) => reps.map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

const emptyActivity = (from: string, to: string) => ({ from, to, rows: [], totals: null, median: null, reps_in_view: 0 });

/** GET /reports/rep-activity — one row per rep: coverage, productivity, orders, travel, time on site, attendance. */
export const repActivityReport = report(14, emptyActivity, async (c) => {
  const { rows } = await activityFor(c);
  const shown = rows.filter((r) => r.planned_stops > 0 || r.orders > 0 || r.days_present > 0).sort(byName);
  const planned = sumBy(shown, (r) => r.planned_stops);
  const visited = sumBy(shown, (r) => r.visited_stops);
  const productive = sumBy(shown, (r) => r.productive_visits);
  const orders = sumBy(shown, (r) => r.orders);
  const revenue = sumBy(shown, (r) => r.revenue_inr);
  const km = sumBy(shown, (r) => r.km_total);
  return {
    from: c.from, to: c.effectiveTo, reps_in_view: shown.length, rows: shown,
    totals: {
      planned_stops: planned, visited_stops: visited, adherence_pct: pct(visited, planned),
      productive_visits: productive, productive_pct: pct(productive, visited),
      orders, revenue_inr: round0(revenue), aov_inr: orders ? round0(revenue / orders) : 0,
      km_total: round1(km), km_per_visit: visited ? round1(km / visited) : 0,
    },
    median: medianBlock(shown),
  };
});

/** GET /reports/beat-compliance?user_id= — weekly planned vs visited calls, overall and per rep. */
export const beatComplianceReport = report(28, (from, to) => ({ from, to, weeks: [], reps: [], totals: null, median_adherence_pct: null, rep_options: [] }), async (c, res) => {
  const user = parseUuidParam(c.req.query.user_id, 'user_id');
  if ('error' in user) return void badRequest(res, user.error);
  const subset = user.value ? c.reps.filter((r) => r.id === user.value) : c.reps;
  const { plans, stops } = await loadPlans(c.scope, new Set(subset.map((r) => r.id)), c.from, c.effectiveTo);
  const calls = collapseStops(stops);
  const weeks = weeklyAdherence(calls);
  const callsBy = new Map<string, Call[]>();
  for (const k of calls) (callsBy.get(k.user_id) ?? callsBy.set(k.user_id, []).get(k.user_id)!).push(k);
  const plansBy = new Map<string, number>();
  for (const p of plans) plansBy.set(p.user_id, (plansBy.get(p.user_id) || 0) + 1);

  const reps = subset
    .filter((r) => (callsBy.get(r.id)?.length ?? 0) > 0)
    .map((r) => {
      const mine = callsBy.get(r.id)!;
      const visited = mine.filter((k) => k.visited);
      const planDays = new Set(mine.map((k) => k.day));
      const activeDays = new Set(visited.map((k) => k.day));
      const perWeek = new Map<string, { p: number; v: number }>();
      for (const k of mine) {
        const ws = weekStartOf(k.day);
        const cur = perWeek.get(ws) || { p: 0, v: 0 };
        cur.p += 1; if (k.visited) cur.v += 1;
        perWeek.set(ws, cur);
      }
      const by_week: Record<string, number | null> = {};
      for (const w of weeks) { const x = perWeek.get(w.week_start); by_week[w.week_start] = x ? pct(x.v, x.p) : null; }
      return {
        fe_id: r.id, fe_name: r.name, plans: plansBy.get(r.id) || 0, planned: mine.length, visited: visited.length,
        missed: Math.max(0, mine.length - visited.length), adherence_pct: pct(visited.length, mine.length),
        plan_days: planDays.size, zero_visit_days: Array.from(planDays).filter((d) => !activeDays.has(d)).length, by_week,
      };
    })
    .sort(byName);
  const planned = sumBy(reps, (r) => r.planned);
  const visited = sumBy(reps, (r) => r.visited);
  return {
    from: c.from, to: c.effectiveTo, weeks, reps,
    totals: { planned, visited, missed: Math.max(0, planned - visited), adherence_pct: pct(visited, planned), plan_days: sumBy(reps, (r) => r.plan_days), zero_visit_days: sumBy(reps, (r) => r.zero_visit_days) },
    median_adherence_pct: medianOf(reps, (r) => r.adherence_pct),
    rep_options: repOptions(c.reps),
  };
});

/** GET /reports/time-and-travel — per rep km, calls, time on site, first / last call and attendance hours. */
export const timeAndTravelReport = report(14, (from, to) => ({ from, to, rows: [], totals: null, median: null }), async (c) => {
  const { rows } = await activityFor(c);
  const shown = rows.filter((r) => r.planned_stops > 0 || r.days_present > 0).sort(byName).map((r) => ({
    fe_id: r.fe_id, fe_name: r.fe_name, active_days: r.active_days, km_total: r.km_total, km_per_day: r.km_per_day,
    visited_stops: r.visited_stops, km_per_visit: r.km_per_visit, timed_visits: r.timed_visits, avg_dwell_min: r.avg_dwell_min,
    onsite_hours: r.onsite_hours, onsite_min: r.onsite_min, first_call_time: r.first_call_time, last_call_time: r.last_call_time, avg_span_hours: r.avg_span_hours,
    days_present: r.days_present, worked_hours: r.total_hours,
    onsite_share_pct: r.total_hours > 0 && r.timed_visits > 0 ? pct(r.onsite_min / 60, r.total_hours) : null,
  }));
  return {
    from: c.from, to: c.effectiveTo, rows: shown,
    totals: {
      km_total: round1(sumBy(shown, (r) => r.km_total)), visited_stops: sumBy(shown, (r) => r.visited_stops),
      onsite_hours: round1(sumBy(shown, (r) => r.onsite_min) / 60), worked_hours: round1(sumBy(shown, (r) => r.worked_hours)),
    },
    median: {
      km_per_visit: medianOf(shown, (r) => r.km_per_visit, (r) => r.visited_stops > 0 && r.km_total > 0),
      avg_dwell_min: medianOf(shown, (r) => r.avg_dwell_min, (r) => r.timed_visits > 0),
      avg_span_hours: medianOf(shown, (r) => r.avg_span_hours, (r) => r.avg_span_hours != null),
      onsite_share_pct: medianOf(shown, (r) => r.onsite_share_pct, (r) => r.onsite_share_pct != null),
    },
  };
});

/** GET /reports/outlet-visit-gaps?min_days=&user_id=&limit= — outlets and how long since each was visited. */
export const outletVisitGapsReport = report(60, (from, to) => ({ from, to, as_of: to, total: 0, rows: [], summary: null, rep_options: [] }), async (c, res) => {
  const user = parseUuidParam(c.req.query.user_id, 'user_id');
  if ('error' in user) return void badRequest(res, user.error);
  const minDays = parseIntParam(c.req.query.min_days, 'min_days', 0, 365, 0);
  if ('error' in minDays) return void badRequest(res, minDays.error);
  const limit = parseIntParam(c.req.query.limit, 'limit', 1, 1000, 200);
  if ('error' in limit) return void badRequest(res, limit.error);

  const subset = user.value ? c.reps.filter((r) => r.id === user.value) : c.reps;
  const ids = new Set(subset.map((r) => r.id));
  const [{ stops }, orders] = await Promise.all([
    loadPlans(c.scope, ids, c.from, c.effectiveTo), loadOrders(c.scope, ids, c.from, c.effectiveTo),
  ]);
  const gaps = outletGaps(collapseStops(stops), orders, c.effectiveTo)
    .filter((g) => g.days_since_last_visit === null || g.days_since_last_visit >= minDays.value);
  // Never visited first, then the longest gap, then the busiest outlet; store id keeps the order stable.
  gaps.sort((a, b) =>
    (a.days_since_last_visit === null ? 1e9 : a.days_since_last_visit) < (b.days_since_last_visit === null ? 1e9 : b.days_since_last_visit) ? 1
      : (a.days_since_last_visit === null ? 1e9 : a.days_since_last_visit) > (b.days_since_last_visit === null ? 1e9 : b.days_since_last_visit) ? -1
        : b.planned_calls - a.planned_calls || a.store_id.localeCompare(b.store_id));
  const page = gaps.slice(0, limit.value);
  const stores = await loadStores(c.scope, page.map((g) => g.store_id));
  const repName = new Map(c.reps.map((r) => [r.id, r.name]));
  const seen = gaps.filter((g) => g.days_since_last_visit !== null);
  return {
    from: c.from, to: c.effectiveTo, as_of: c.effectiveTo, total: gaps.length,
    summary: {
      outlets: gaps.length, never_visited: gaps.length - seen.length, visited: seen.length,
      avg_days_since_last_visit: seen.length ? round1(sumBy(seen, (g) => g.days_since_last_visit as number) / seen.length) : null,
    },
    rows: page.map((g) => ({
      store_id: g.store_id, outlet_name: stores.get(g.store_id)?.name ?? 'Outlet', city: stores.get(g.store_id)?.city ?? null,
      rep_id: g.top_rep_id, rep_name: g.top_rep_id ? repName.get(g.top_rep_id) ?? 'Rep' : null,
      planned_calls: g.planned_calls, visited_calls: g.visited_calls, last_visit_date: g.last_visit_date,
      days_since_last_visit: g.days_since_last_visit, last_order_date: g.last_order_date, orders: g.orders, revenue_inr: g.revenue_inr,
    })),
    rep_options: repOptions(c.reps),
  };
});

/** GET /reports/geo-exceptions?user_id=&min_distance_m= — check-ins outside the outlet geofence, with alert counts. */
export const geoExceptionsReport = report(14, (from, to) => ({ from, to, total: 0, rows: [], summary: [], rep_options: [] }), async (c, res) => {
  const user = parseUuidParam(c.req.query.user_id, 'user_id');
  if ('error' in user) return void badRequest(res, user.error);
  const minDist = parseIntParam(c.req.query.min_distance_m, 'min_distance_m', 0, 100000, 0);
  if ('error' in minDist) return void badRequest(res, minDist.error);

  const subset = user.value ? c.reps.filter((r) => r.id === user.value) : c.reps;
  const ids = new Set(subset.map((r) => r.id));
  const { plans, stops } = await loadPlans(c.scope, ids, c.from, c.effectiveTo);
  const calls = collapseStops(stops);
  const [alerts, suspects] = await Promise.all([
    loadSecurityAlerts(c.scope, ids, c.from, c.effectiveTo), loadSuspectPings(c.scope, ids, c.from, c.effectiveTo),
  ]);
  const acts = repActivity({ reps: subset, calls, plans, orders: [], attendance: [], today: c.today });
  const summary = acts
    .map((r) => ({
      fe_id: r.fe_id, fe_name: r.fe_name, checkins: r.checkins, outside_geofence: r.outside_geofence, outside_pct: r.outside_pct,
      max_distance_m: round0(r.max_distance_m),
      mock_location: alerts.get(r.fe_id)?.mock_location ?? 0, vpn_detected: alerts.get(r.fe_id)?.vpn_detected ?? 0, suspect_pings: suspects.get(r.fe_id) ?? 0,
    }))
    .filter((r) => r.checkins > 0 || r.mock_location + r.vpn_detected + r.suspect_pings > 0)
    .sort((a, b) => b.outside_geofence - a.outside_geofence || b.outside_pct - a.outside_pct || byName(a, b));

  const repName = new Map(c.reps.map((r) => [r.id, r.name]));
  const out = calls
    .filter((k) => k.visited && k.checkin_at && k.checkin_distance_m != null)
    .map((k) => ({ k, geo: Number(k.geofence_radius_m) || DEFAULT_GEOFENCE_M, dist: Number(k.checkin_distance_m) }))
    .filter((x) => x.dist > x.geo && x.dist >= minDist.value)
    .sort((a, b) => b.dist - a.dist || String(a.k.checkin_at).localeCompare(String(b.k.checkin_at)));
  const page = out.slice(0, 500);
  const stores = await loadStores(c.scope, page.map((x) => x.k.store_id as string).filter(Boolean));
  return {
    from: c.from, to: c.effectiveTo, total: out.length, summary,
    rows: page.map((x) => ({
      fe_id: x.k.user_id, fe_name: repName.get(x.k.user_id) ?? 'Rep',
      outlet_name: x.k.store_id ? stores.get(x.k.store_id)?.name ?? 'Outlet' : 'Outlet',
      beat: x.k.territory_label ?? '—', visited_at: x.k.checkin_at, day: x.k.day,
      distance_m: round0(x.dist), geofence_m: round0(x.geo), over_by_m: round0(x.dist - x.geo),
    })),
    rep_options: repOptions(c.reps),
  };
});

/** GET /reports/supervisor-teams — per direct supervisor: team size, coverage and output, with team-size-neutral measures. */
export const supervisorTeamsReport = report(14, (from, to) => ({ from, to, rows: [], median: null, reps_in_view: 0 }), async (c) => {
  const { rows } = await activityFor(c);
  const names = await loadUserNames(c.scope, rows.map((r) => r.supervisor_id as string).filter(Boolean));
  const teams = supervisorRollup(rows, names);
  return {
    from: c.from, to: c.effectiveTo, reps_in_view: rows.length, rows: teams,
    median: {
      adherence_pct: medianOf(teams, (t) => t.adherence_pct, (t) => t.planned_stops > 0),
      productive_pct: medianOf(teams, (t) => t.productive_pct, (t) => t.visited_stops > 0),
      calls_per_rep_day: medianOf(teams, (t) => t.calls_per_rep_day, (t) => t.active_rep_days > 0),
      revenue_per_rep_inr: medianOf(teams, (t) => t.revenue_per_rep_inr),
    },
  };
});

/**
 * GET /reports/attendance-extras — per-user extras for the Attendance Summary report (average check-in / check-out,
 * hours, missed check-outs, regularised days). Any role that punched is included, like the summary's roster; a caller
 * below supervisor only gets themselves. Keyed by user_id so the page can join it to /attendance/summary.
 */
export const attendanceExtrasReport = asyncHandler<AuthRequest>(async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>, 14);
  if ('error' in range) return badRequest(res, range.error);
  const { from, effectiveTo } = range;
  const empty = { from, to: effectiveTo, rows: [], median: null };
  if (isDemo(req.user!) || from > effectiveTo) return ok(res, empty);
  const scope = await resolveScope(req);
  const att = await loadAttendance(scope, null, from, effectiveTo);
  const stats = Array.from(attendanceStats(att, todayIst()).values());
  return ok(res, {
    from, to: effectiveTo, rows: stats,
    median: { avg_hours: medianOf(stats, (s) => s.avg_hours, (s) => s.avg_hours != null), avg_checkin_min: median(stats.map((s) => s.avg_checkin_min).filter((m): m is number => m != null)) },
  });
});

/**
 * GET /reports/visit-coverage — the Visit Coverage report's data: outlets planned vs visited in the window (default:
 * this month so far), by city and by rep. Replaces the page's old dependency on /analytics/outlet-coverage, which
 * answers a different shape (form-submission outlet counts).
 */
export const visitCoverageReport = report(
  () => Number(todayIst().slice(8, 10)),                    // month to date: the 1st .. today
  (from, to) => ({ from, to, universe: 0, covered: 0, coverage_pct: 0, never_visited: 0, by_city: [], by_rep: [] }),
  async (c) => {
    const { plans: _plans, stops } = await loadPlans(c.scope, c.repIds, c.from, c.effectiveTo);
    const calls = collapseStops(stops).filter((k) => k.store_id);
    const universe = new Set<string>(); const covered = new Set<string>();
    const repUniverse = new Map<string, Set<string>>(); const repCovered = new Map<string, Set<string>>();
    for (const k of calls) {
      const id = k.store_id as string;
      universe.add(id);
      (repUniverse.get(k.user_id) ?? repUniverse.set(k.user_id, new Set()).get(k.user_id)!).add(id);
      if (k.visited) {
        covered.add(id);
        (repCovered.get(k.user_id) ?? repCovered.set(k.user_id, new Set()).get(k.user_id)!).add(id);
      }
    }
    const stores = await loadStores(c.scope, Array.from(universe));
    const city = new Map<string, { universe: number; covered: number }>();
    for (const id of universe) {
      const name = stores.get(id)?.city || 'No city on record';
      const cur = city.get(name) || { universe: 0, covered: 0 };
      cur.universe += 1; if (covered.has(id)) cur.covered += 1;
      city.set(name, cur);
    }
    const by_rep = c.reps
      .filter((r) => (repUniverse.get(r.id)?.size ?? 0) > 0)
      .map((r) => {
        const u = repUniverse.get(r.id)!.size; const v = repCovered.get(r.id)?.size ?? 0;
        return { fe_id: r.id, fe_name: r.name, universe: u, covered: v, gap: u - v, coverage_pct: pct(v, u) };
      })
      .sort(byName);
    return {
      from: c.from, to: c.effectiveTo, universe: universe.size, covered: covered.size, coverage_pct: pct(covered.size, universe.size),
      never_visited: universe.size - covered.size,
      by_city: Array.from(city.entries()).map(([name, v]) => ({ city: name, universe: v.universe, covered: v.covered })).sort((a, b) => a.city.localeCompare(b.city)),
      by_rep,
    };
  },
);
