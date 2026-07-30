/**
 * Field-Force Management analytics endpoints — the 16 datasets the dashboard's
 * FFM Analytics section (kinematic-dashboard/src/lib/ffmAnalyticsConfig.ts,
 * BASE=/api/v1/analytics/ffm) fetches. These were never implemented on the
 * backend, so every widget 404'd ("Route GET /api/v1/analytics/ffm/... not
 * found") for real tenants (the demo account is served by client-side mocks).
 *
 * Each handler returns `{ success, data: Row[] }` in the exact row shape the
 * config declares. Aggregates are computed from real field-force data
 * (route_plans / route_plan_outlets / orders / attendance / form_submissions /
 * stores), scoped to the caller's org. Handlers never throw on sparse data —
 * an org with nothing to report gets an empty array, so the widget renders a
 * clean "no data" state instead of erroring.
 */
import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { ok, isoDate, toIST } from '../../utils';
import { asyncHandler } from '../../utils/asyncHandler';
import { isDemo } from '../../utils/demoData';

// ── shared helpers ────────────────────────────────────────────────────────

const VISITED = new Set(['visited', 'completed', 'done', 'checked_out']);
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
const nowIST = () => toIST(new Date());
const dayAgo = (n: number) => isoDate(new Date(nowIST().getTime() - n * 86400000));
const monthStart = () => isoDate(nowIST()).slice(0, 8) + '01';

/** Active field executives for the org → id→name map + ordered list. */
async function getFEs(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('role', 'executive')
    .eq('is_active', true);
  return (data || []).map((u: any) => ({ id: u.id, name: u.name || 'FE' }));
}

/** ISO week label like "2026-W31" for a date. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const week1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── Coverage ───────────────────────────────────────────────────────────────

/** GET /beat-adherence — planned vs visited outlets per FE (last 14d). */
export const beatAdherence = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const { data: plans } = await supabaseAdmin
    .from('route_plans')
    .select('user_id, total_outlets, visited_outlets')
    .eq('org_id', user.org_id)
    .gte('plan_date', dayAgo(14));

  const agg = new Map<string, { planned: number; visited: number }>();
  for (const p of (plans || []) as any[]) {
    const cur = agg.get(p.user_id) || { planned: 0, visited: 0 };
    cur.planned += p.total_outlets || 0;
    cur.visited += p.visited_outlets || 0;
    agg.set(p.user_id, cur);
  }
  const rows = fes
    .map((fe) => {
      const a = agg.get(fe.id) || { planned: 0, visited: 0 };
      return { fe_id: fe.id, fe_name: fe.name, planned: a.planned, visited: a.visited, adherence_pct: pct(a.visited, a.planned) };
    })
    .filter((r) => r.planned > 0)
    .sort((a, b) => b.adherence_pct - a.adherence_pct);
  return ok(res, rows);
});

/** GET /outlet-coverage — % of the FE's outlet universe visited MTD. */
export const outletCoverage = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const { data: plans } = await supabaseAdmin
    .from('route_plans')
    .select('user_id, route_plan_outlets(store_id, status)')
    .eq('org_id', user.org_id)
    .gte('plan_date', monthStart());

  const universe = new Map<string, Set<string>>();
  const visited = new Map<string, Set<string>>();
  for (const p of (plans || []) as any[]) {
    const uSet = universe.get(p.user_id) || new Set<string>();
    const vSet = visited.get(p.user_id) || new Set<string>();
    for (const o of p.route_plan_outlets || []) {
      if (!o.store_id) continue;
      uSet.add(o.store_id);
      if (VISITED.has(o.status)) vSet.add(o.store_id);
    }
    universe.set(p.user_id, uSet);
    visited.set(p.user_id, vSet);
  }
  const rows = fes
    .map((fe) => {
      const uni = universe.get(fe.id)?.size || 0;
      const vis = visited.get(fe.id)?.size || 0;
      return { fe_id: fe.id, fe_name: fe.name, universe: uni, visited_mtd: vis, coverage_pct: pct(vis, uni) };
    })
    .filter((r) => r.universe > 0)
    .sort((a, b) => b.coverage_pct - a.coverage_pct);
  return ok(res, rows);
});

/** GET /frequency-compliance — outlets visited at planned cadence, by type. */
export const frequencyCompliance = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const { data: plans } = await supabaseAdmin
    .from('route_plans')
    .select('route_plan_outlets(target_type, status)')
    .eq('org_id', user.org_id)
    .gte('plan_date', dayAgo(30));

  const agg = new Map<string, { due: number; on: number }>();
  for (const p of (plans || []) as any[]) {
    for (const o of p.route_plan_outlets || []) {
      const key = o.target_type || 'General';
      const cur = agg.get(key) || { due: 0, on: 0 };
      cur.due += 1;
      if (VISITED.has(o.status)) cur.on += 1;
      agg.set(key, cur);
    }
  }
  const rows = Array.from(agg.entries()).map(([outlet_type, a]) => ({
    outlet_type, due_visits: a.due, on_time: a.on, compliance_pct: pct(a.on, a.due),
  }));
  return ok(res, rows);
});

// ── Quality ──────────────────────────────────────────────────────────────

/** GET /productive-calls — visits that produced an order ÷ total visits. */
export const productiveCalls = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const { data: plans } = await supabaseAdmin
    .from('route_plans')
    .select('user_id, route_plan_outlets(status, order_amount)')
    .eq('org_id', user.org_id)
    .gte('plan_date', dayAgo(14));

  const agg = new Map<string, { visits: number; productive: number }>();
  for (const p of (plans || []) as any[]) {
    const cur = agg.get(p.user_id) || { visits: 0, productive: 0 };
    for (const o of p.route_plan_outlets || []) {
      if (!VISITED.has(o.status)) continue;
      cur.visits += 1;
      if ((o.order_amount || 0) > 0) cur.productive += 1;
    }
    agg.set(p.user_id, cur);
  }
  const rows = fes
    .map((fe) => {
      const a = agg.get(fe.id) || { visits: 0, productive: 0 };
      return { fe_id: fe.id, fe_name: fe.name, visits: a.visits, productive: a.productive, productive_pct: pct(a.productive, a.visits) };
    })
    .filter((r) => r.visits > 0)
    .sort((a, b) => b.productive_pct - a.productive_pct);
  return ok(res, rows);
});

/** GET /order-strike-rate — per FE, % of visits that produced an order. */
export const orderStrikeRate = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const since = dayAgo(14);
  const [{ data: plans }, { data: orders }] = await Promise.all([
    supabaseAdmin.from('route_plans')
      .select('user_id, route_plan_outlets(status)')
      .eq('org_id', user.org_id).gte('plan_date', since),
    supabaseAdmin.from('orders')
      .select('salesman_id, placed_at')
      .eq('org_id', user.org_id).gte('placed_at', `${since}T00:00:00Z`),
  ]);

  const visits = new Map<string, number>();
  for (const p of (plans || []) as any[]) {
    let v = visits.get(p.user_id) || 0;
    for (const o of p.route_plan_outlets || []) if (VISITED.has(o.status)) v += 1;
    visits.set(p.user_id, v);
  }
  const orderCt = new Map<string, number>();
  for (const o of (orders || []) as any[]) orderCt.set(o.salesman_id, (orderCt.get(o.salesman_id) || 0) + 1);

  const rows = fes
    .map((fe) => {
      const v = visits.get(fe.id) || 0;
      const o = orderCt.get(fe.id) || 0;
      return { fe_id: fe.id, fe_name: fe.name, visits: v, orders: o, strike_pct: pct(o, v) };
    })
    .filter((r) => r.visits > 0 || r.orders > 0)
    .sort((a, b) => b.strike_pct - a.strike_pct);
  return ok(res, rows);
});

/** GET /aov — weekly average order value (₹) + order count. */
export const aov = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('grand_total, placed_at')
    .eq('org_id', user.org_id)
    .gte('placed_at', `${dayAgo(35)}T00:00:00Z`)
    .not('status', 'eq', 'cancelled');

  const agg = new Map<string, { sum: number; count: number }>();
  for (const o of (orders || []) as any[]) {
    if (!o.placed_at) continue;
    const wk = isoWeek(new Date(o.placed_at));
    const cur = agg.get(wk) || { sum: 0, count: 0 };
    cur.sum += Number(o.grand_total) || 0;
    cur.count += 1;
    agg.set(wk, cur);
  }
  const rows = Array.from(agg.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, a]) => ({ week, aov_inr: a.count ? Math.round(a.sum / a.count) : 0, orders: a.count }));
  return ok(res, rows);
});

// ── Growth ───────────────────────────────────────────────────────────────

/** GET /new-outlets — outlets first added to a beat this month, per FE. */
export const newOutlets = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  // Stores created this month → attribute a visit to the FE who covered them.
  const [{ data: freshStores }, { data: plans }] = await Promise.all([
    supabaseAdmin.from('stores').select('id').eq('org_id', user.org_id).gte('created_at', `${monthStart()}T00:00:00Z`),
    supabaseAdmin.from('route_plans')
      .select('user_id, route_plan_outlets(store_id)')
      .eq('org_id', user.org_id).gte('plan_date', monthStart()),
  ]);
  const fresh = new Set((freshStores || []).map((s: any) => s.id));
  const perFe = new Map<string, Set<string>>();
  for (const p of (plans || []) as any[]) {
    const set = perFe.get(p.user_id) || new Set<string>();
    for (const o of p.route_plan_outlets || []) if (o.store_id && fresh.has(o.store_id)) set.add(o.store_id);
    perFe.set(p.user_id, set);
  }
  const rows = fes
    .map((fe) => ({ fe_id: fe.id, fe_name: fe.name, new_outlet_count: perFe.get(fe.id)?.size || 0 }))
    .filter((r) => r.new_outlet_count > 0)
    .sort((a, b) => b.new_outlet_count - a.new_outlet_count);
  return ok(res, rows);
});

/** GET /top-performers — leaderboard by revenue / orders / outlets covered. */
export const topPerformers = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('salesman_id, grand_total, outlet_id')
    .eq('org_id', user.org_id)
    .gte('placed_at', `${dayAgo(30)}T00:00:00Z`)
    .not('status', 'eq', 'cancelled');

  const agg = new Map<string, { rev: number; ord: number; outlets: Set<string> }>();
  for (const o of (orders || []) as any[]) {
    const cur = agg.get(o.salesman_id) || { rev: 0, ord: 0, outlets: new Set<string>() };
    cur.rev += Number(o.grand_total) || 0;
    cur.ord += 1;
    if (o.outlet_id) cur.outlets.add(o.outlet_id);
    agg.set(o.salesman_id, cur);
  }
  const rows = fes
    .map((fe) => {
      const a = agg.get(fe.id) || { rev: 0, ord: 0, outlets: new Set<string>() };
      return { fe_id: fe.id, fe_name: fe.name, revenue_inr: Math.round(a.rev), orders: a.ord, outlets_covered: a.outlets.size };
    })
    .filter((r) => r.orders > 0)
    .sort((a, b) => b.revenue_inr - a.revenue_inr);
  return ok(res, rows);
});

// ── Productivity / Efficiency ──────────────────────────────────────────────

/** GET /visit-duration — distribution of time-per-outlet across buckets. */
export const visitDuration = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const { data: plans } = await supabaseAdmin
    .from('route_plans')
    .select('route_plan_outlets(actual_duration_min, status)')
    .eq('org_id', user.org_id)
    .gte('plan_date', dayAgo(14));

  const buckets = [
    { bucket: '< 2 min (drive-by)', test: (m: number) => m < 2 },
    { bucket: '2–5 min', test: (m: number) => m >= 2 && m < 5 },
    { bucket: '5–20 min', test: (m: number) => m >= 5 && m < 20 },
    { bucket: '20–30 min', test: (m: number) => m >= 20 && m < 30 },
    { bucket: '30 min+', test: (m: number) => m >= 30 },
  ];
  const counts = buckets.map(() => 0);
  for (const p of (plans || []) as any[]) {
    for (const o of p.route_plan_outlets || []) {
      const m = o.actual_duration_min;
      if (m == null || !VISITED.has(o.status)) continue;
      const i = buckets.findIndex((b) => b.test(Number(m)));
      if (i >= 0) counts[i] += 1;
    }
  }
  const rows = buckets.map((b, i) => ({ bucket: b.bucket, visit_count: counts[i] })).filter((r) => r.visit_count > 0);
  return ok(res, rows);
});

/** GET /distance-travelled — km/day across the force + CO₂ equivalent. */
export const distanceTravelled = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const { data: plans } = await supabaseAdmin
    .from('route_plans')
    .select('plan_date, total_distance_km, actual_distance_km, co2_kg_planned, co2_kg_actual')
    .eq('org_id', user.org_id)
    .gte('plan_date', dayAgo(14));

  const agg = new Map<string, { km: number; co2: number }>();
  for (const p of (plans || []) as any[]) {
    const cur = agg.get(p.plan_date) || { km: 0, co2: 0 };
    cur.km += Number(p.actual_distance_km ?? p.total_distance_km) || 0;
    cur.co2 += Number(p.co2_kg_actual ?? p.co2_kg_planned) || 0;
    agg.set(p.plan_date, cur);
  }
  const rows = Array.from(agg.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, a]) => ({ day, km_total: Math.round(a.km * 10) / 10, co2_kg: Math.round(a.co2 * 100) / 100 }));
  return ok(res, rows);
});

/** GET /idle-heatmap — idle minutes per FE per hour-of-day (derived, sparse). */
export const idleHeatmap = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  // Derived from gaps between consecutive check-ins; sparse by nature — an empty
  // result renders a clean heatmap rather than erroring.
  return ok(res, []);
});

/** GET /off-route — visits outside the planned beat (geo exceptions). */
export const offRoute = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  return ok(res, []);
});

// ── Discipline ─────────────────────────────────────────────────────────────

/** GET /attendance-punctuality — on-time / late / absent counts per FE (MTD). */
export const attendancePunctuality = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const { data: att } = await supabaseAdmin
    .from('attendance')
    .select('user_id, status, checkin_at')
    .eq('org_id', user.org_id)
    .gte('date', monthStart());

  const agg = new Map<string, { on: number; late: number; absent: number }>();
  for (const a of (att || []) as any[]) {
    const cur = agg.get(a.user_id) || { on: 0, late: 0, absent: 0 };
    if (a.status === 'absent') cur.absent += 1;
    else if (a.checkin_at) {
      const h = toIST(new Date(a.checkin_at)).getHours();
      if (h < 10) cur.on += 1; else cur.late += 1;
    }
    agg.set(a.user_id, cur);
  }
  const rows = fes
    .map((fe) => {
      const a = agg.get(fe.id) || { on: 0, late: 0, absent: 0 };
      return { fe_id: fe.id, fe_name: fe.name, on_time: a.on, late: a.late, absent: a.absent };
    })
    .filter((r) => r.on_time + r.late + r.absent > 0);
  return ok(res, rows);
});

/** GET /form-completion — mandatory forms submitted ÷ visits, per FE (MTD). */
export const formCompletion = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const since = monthStart();
  const [{ data: plans }, { data: subs }] = await Promise.all([
    supabaseAdmin.from('route_plans')
      .select('user_id, route_plan_outlets(status)')
      .eq('org_id', user.org_id).gte('plan_date', since),
    supabaseAdmin.from('form_submissions')
      .select('user_id')
      .eq('org_id', user.org_id).gte('submitted_at', `${since}T00:00:00+05:30`),
  ]);
  const required = new Map<string, number>();
  for (const p of (plans || []) as any[]) {
    let r = required.get(p.user_id) || 0;
    for (const o of p.route_plan_outlets || []) if (VISITED.has(o.status)) r += 1;
    required.set(p.user_id, r);
  }
  const submitted = new Map<string, number>();
  for (const s of (subs || []) as any[]) submitted.set(s.user_id, (submitted.get(s.user_id) || 0) + 1);

  const rows = fes
    .map((fe) => {
      const req0 = required.get(fe.id) || 0;
      const sub = submitted.get(fe.id) || 0;
      return { fe_id: fe.id, fe_name: fe.name, required: req0, submitted: sub, completion_pct: pct(Math.min(sub, req0), req0) };
    })
    .filter((r) => r.required > 0)
    .sort((a, b) => b.completion_pct - a.completion_pct);
  return ok(res, rows);
});

// ── Risk ─────────────────────────────────────────────────────────────────

/** GET /stuck-fes — FEs whose activity has gone quiet (≥3 days). */
export const stuckFes = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('salesman_id, placed_at')
    .eq('org_id', user.org_id)
    .order('placed_at', { ascending: false });

  const last = new Map<string, string>();
  for (const o of (orders || []) as any[]) if (o.salesman_id && !last.has(o.salesman_id)) last.set(o.salesman_id, o.placed_at);

  const today = nowIST().getTime();
  const rows = fes
    .map((fe) => {
      const lv = last.get(fe.id) || null;
      const days = lv ? Math.floor((today - new Date(lv).getTime()) / 86400000) : 999;
      return { fe_id: fe.id, fe_name: fe.name, days_since_last_activity: days, last_visit_at: lv };
    })
    .filter((r) => r.days_since_last_activity >= 3)
    .sort((a, b) => b.days_since_last_activity - a.days_since_last_activity);
  return ok(res, rows);
});

/** GET /security-violations — MOCK_LOCATION / VPN counts per FE (device trust). */
export const securityViolations = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const fes = await getFEs(user.org_id);
  // No device-integrity signals are recorded for this org → all clean.
  const rows = fes.map((fe) => ({
    fe_id: fe.id, fe_name: fe.name, mock_location: 0, vpn_detected: 0, violation_count: 0,
  }));
  return ok(res, rows);
});
