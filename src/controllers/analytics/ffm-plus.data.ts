/**
 * Field-Force analytics (plus) — scope, request parsing and data loaders.
 *
 * Shared by ffm-analytics-plus.controller.ts. The arithmetic lives in
 * ffm-plus.compute.ts (pure); this file only decides WHICH rows a caller may
 * see and reads them.
 *
 * Scope = the neighbouring field-force analytics reads (analytics.controller
 * getUserPerformance / getLiveLocations):
 *   - the caller's org (always);
 *   - the caller's client when they are client-bound (JWT-pinned);
 *   - the supervisor subtree when the client opted into supervisor scoping
 *     (fieldForceScopeIds; null = no restriction, exactly as elsewhere).
 * It can only ever NARROW what the older org-wide FFM widgets show.
 *
 * Reads page through PostgREST's 1000-row cap. Tables that may not exist on
 * every tenant (orders, attendance, security_alerts, work_activity, cities,
 * stores) fail soft — the metric reads as empty and a warning is logged — so an
 * org with nothing never errors. The core tables (users, route_plans) fail loud.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { AppError, isUUID } from '../../utils';
import { AuthRequest } from '../../types';
import { fieldForceScopeIds } from '../../services/supervisor-scope.service';
import { SUPERVISOR_OR_ABOVE_ROLES } from '../../middleware/auth';
import { addDaysYmd, inclusiveDayCount, isValidYmd, istDateOf, SUMMARY_MAX_RANGE_DAYS } from '../../services/attendanceRules.service';
import type { AttLite, OrderLite, PlanLite, RepLite, Stop } from './ffm-plus.compute';

// ── scope ─────────────────────────────────────────────────────────────────

export interface FfmScope { orgId: string; clientId: string | null; scopeIds: string[] | null }

export async function resolveScope(req: AuthRequest): Promise<FfmScope> {
  const u = req.user!;
  let scopeIds = await fieldForceScopeIds(req);
  // A caller below supervisor (a rep, HR) only ever gets their own numbers — the same rule the attendance summary
  // applies. The older org-wide FFM widgets do not narrow this far; these never widen it.
  const isManager = SUPERVISOR_OR_ABOVE_ROLES.includes(String(u.role || '').toLowerCase() as any);
  if (!isManager) scopeIds = scopeIds ? scopeIds.filter((id) => id === u.id) : [u.id];
  return {
    orgId: u.org_id,
    clientId: isUUID(u.client_id) ? (u.client_id as string) : null,
    scopeIds,
  };
}

export const todayIst = (): string => istDateOf(Date.now()) as string;
export { addDaysYmd };

// ── request parsing ───────────────────────────────────────────────────────

export type RangeResult =
  | { from: string; to: string; effectiveTo: string }
  | { error: string };

/**
 * `from` / `to` (YYYY-MM-DD, IST). Neither given -> the last `defaultDays` days ending today. Exactly one, a bad
 * date, to < from, or more than 62 days is a 400. `effectiveTo` is `to` capped at today: future plan days are
 * not "missed" yet.
 */
export function parseRange(q: Record<string, unknown>, defaultDays: number): RangeResult {
  const today = todayIst();
  const rawFrom = q.from === '' ? undefined : q.from;
  const rawTo = q.to === '' ? undefined : q.to;
  if (rawFrom === undefined && rawTo === undefined) {
    const from = addDaysYmd(today, -(defaultDays - 1));
    return { from, to: today, effectiveTo: today };
  }
  if (rawFrom === undefined || rawTo === undefined) return { error: 'from and to must be given together as dates in YYYY-MM-DD format' };
  if (!isValidYmd(rawFrom) || !isValidYmd(rawTo)) return { error: 'from and to must be dates in YYYY-MM-DD format' };
  if (rawTo < rawFrom) return { error: 'to must not be before from' };
  if (inclusiveDayCount(rawFrom, rawTo) > SUMMARY_MAX_RANGE_DAYS) return { error: `Range too large: at most ${SUMMARY_MAX_RANGE_DAYS} days` };
  return { from: rawFrom, to: rawTo, effectiveTo: rawTo < today ? rawTo : today };
}

/** Optional UUID query param: undefined when absent, an error string when malformed. */
export function parseUuidParam(v: unknown, name: string): { value: string | null } | { error: string } {
  if (v === undefined || v === '') return { value: null };
  if (typeof v !== 'string' || !isUUID(v)) return { error: `${name} must be a valid UUID` };
  return { value: v };
}

/** Optional integer query param within [min, max]. */
export function parseIntParam(v: unknown, name: string, min: number, max: number, dflt: number): { value: number } | { error: string } {
  if (v === undefined || v === '') return { value: dflt };
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return { error: `${name} must be a whole number from ${min} to ${max}` };
  return { value: n };
}

// ── paging ────────────────────────────────────────────────────────────────

const PAGE = 1000;               // PostgREST returns at most 1000 rows per request
const MAX_PAGES = 40;            // 40k rows per read is a safety valve, not a target
const ID_CHUNK = 100;            // keeps `in.(…)` URLs short

export function chunk<T>(xs: T[], n = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Read every page of a ranged query. `soft` tables log and return what was read instead of throwing. */
async function fetchAll<T>(label: string, soft: boolean, build: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (soft) { logger.warn(`[ffm-plus] ${label} read failed (treated as empty): ${error.message}`); return out; }
      throw new AppError(500, error.message, 'DB_ERROR');
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  logger.warn(`[ffm-plus] ${label} read hit the ${MAX_PAGES}-page cap; result may be truncated`);
  return out;
}

// ── loaders ───────────────────────────────────────────────────────────────

const FIELD_ROLES = ['executive', 'field_executive'];

/** The field reps this caller may see: active executives of the org (and client / supervisor subtree when scoped). */
export async function loadReps(scope: FfmScope): Promise<RepLite[]> {
  const rows = await fetchAll<any>('users', false, (a, b) => {
    let q: any = supabaseAdmin.from('users').select('id, name, supervisor_id')
      .eq('org_id', scope.orgId).in('role', FIELD_ROLES).eq('is_active', true).is('deleted_at', null);
    if (scope.clientId) q = q.eq('client_id', scope.clientId);
    return q.order('id', { ascending: true }).range(a, b);
  });
  const allow = scope.scopeIds ? new Set(scope.scopeIds) : null;
  return rows
    .filter((u) => !allow || allow.has(u.id))
    .map((u) => ({ id: u.id as string, name: (u.name as string) || 'Rep', supervisor_id: (u.supervisor_id as string) || null }));
}

export interface PlanData { plans: PlanLite[]; stops: Stop[] }

/** Route plans (+ their stops) for the given reps over [from, to]. */
export async function loadPlans(scope: FfmScope, repIds: Set<string>, from: string, to: string): Promise<PlanData> {
  if (!repIds.size) return { plans: [], stops: [] };
  const rows = await fetchAll<any>('route_plans', false, (a, b) =>
    supabaseAdmin.from('route_plans')
      .select('id, user_id, plan_date, territory_label, total_distance_km, actual_distance_km, route_plan_outlets(store_id, status, planned_duration_min, checkin_at, checkout_at, checkin_distance_m, geofence_radius_m)')
      .eq('org_id', scope.orgId).gte('plan_date', from).lte('plan_date', to)
      .order('plan_date', { ascending: true }).order('id', { ascending: true }).range(a, b) as any);
  const plans: PlanLite[] = [];
  const stops: Stop[] = [];
  for (const p of rows) {
    if (!repIds.has(p.user_id)) continue;
    const km = Number(p.actual_distance_km ?? p.total_distance_km);
    plans.push({ id: p.id, user_id: p.user_id, plan_date: String(p.plan_date).slice(0, 10), km: Number.isFinite(km) ? km : 0 });
    const outlets = Array.isArray(p.route_plan_outlets) ? p.route_plan_outlets : p.route_plan_outlets ? [p.route_plan_outlets] : [];
    for (const o of outlets) {
      const dist = o.checkin_distance_m == null ? null : Number(o.checkin_distance_m);
      const geo = o.geofence_radius_m == null ? null : Number(o.geofence_radius_m);
      stops.push({
        plan_id: p.id, user_id: p.user_id, plan_date: String(p.plan_date).slice(0, 10), territory_label: p.territory_label ?? null,
        store_id: o.store_id ?? null, status: o.status ?? null,
        planned_duration_min: o.planned_duration_min == null ? null : Number(o.planned_duration_min),
        checkin_at: o.checkin_at ?? null, checkout_at: o.checkout_at ?? null,
        checkin_distance_m: dist != null && Number.isFinite(dist) ? dist : null,
        geofence_radius_m: geo != null && Number.isFinite(geo) ? geo : null,
      });
    }
  }
  return { plans, stops };
}

/** Non-cancelled, non-draft orders booked by the given reps whose IST day falls in [from, to]. */
export async function loadOrders(scope: FfmScope, repIds: Set<string>, from: string, to: string): Promise<OrderLite[]> {
  if (!repIds.size) return [];
  const rows = await fetchAll<any>('orders', true, (a, b) =>
    supabaseAdmin.from('orders').select('salesman_id, outlet_id, grand_total, placed_at')
      .eq('org_id', scope.orgId)
      .gte('placed_at', `${from}T00:00:00+05:30`).lt('placed_at', `${addDaysYmd(to, 1)}T00:00:00+05:30`)
      .not('status', 'in', '(cancelled,draft)')
      .order('placed_at', { ascending: true }).order('id', { ascending: true }).range(a, b) as any);
  const out: OrderLite[] = [];
  for (const o of rows) {
    if (!o.salesman_id || !repIds.has(o.salesman_id)) continue;
    const day = o.placed_at ? istDateOf(o.placed_at) : null;
    if (!day) continue;
    const rev = Number(o.grand_total);
    out.push({ salesman_id: o.salesman_id, outlet_id: o.outlet_id ?? null, revenue: Number.isFinite(rev) ? rev : 0, day });
  }
  return out;
}

/** Attendance rows for the given users over [from, to]. `userIds` null = every user the org scope allows. */
export async function loadAttendance(scope: FfmScope, userIds: Set<string> | null, from: string, to: string): Promise<AttLite[]> {
  if (userIds && !userIds.size) return [];
  const rows = await fetchAll<any>('attendance', true, (a, b) => {
    let q: any = supabaseAdmin.from('attendance')
      .select('user_id, date, status, checkin_at, checkout_at, total_hours, is_regularised')
      .eq('org_id', scope.orgId).gte('date', from).lte('date', to);
    // Given an explicit user set the roster already carries the client; only an open read needs the client filter.
    if (!userIds && scope.clientId) q = q.eq('client_id', scope.clientId);
    return q.order('date', { ascending: true }).order('id', { ascending: true }).range(a, b);
  });
  const allow = userIds ?? (scope.scopeIds ? new Set(scope.scopeIds) : null);
  return rows
    .filter((a) => !allow || allow.has(a.user_id))
    .map((a) => ({
      user_id: a.user_id, date: String(a.date).slice(0, 10), status: a.status ?? null, checkin_at: a.checkin_at ?? null,
      checkout_at: a.checkout_at ?? null, total_hours: a.total_hours == null ? null : Number(a.total_hours), is_regularised: a.is_regularised ?? null,
    }));
}

/** id -> name for the given users (supervisors), org-scoped. Soft: a failure leaves names generic. */
export async function loadUserNames(scope: FfmScope, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(Array.from(new Set(ids.filter(Boolean))))) {
    const { data, error } = await supabaseAdmin.from('users').select('id, name').eq('org_id', scope.orgId).in('id', part);
    if (error) { logger.warn(`[ffm-plus] user names read failed: ${error.message}`); continue; }
    for (const u of (data || []) as any[]) out.set(u.id, u.name || 'User');
  }
  return out;
}

export interface StoreInfo { id: string; name: string; city: string | null }

/** id -> {name, city} for outlets, org-scoped. Soft. */
export async function loadStores(scope: FfmScope, ids: string[]): Promise<Map<string, StoreInfo>> {
  const out = new Map<string, StoreInfo>();
  const cityOf = new Map<string, string | null>();
  for (const part of chunk(Array.from(new Set(ids.filter(Boolean))))) {
    const { data, error } = await supabaseAdmin.from('stores').select('id, name, city_id').eq('org_id', scope.orgId).in('id', part);
    if (error) { logger.warn(`[ffm-plus] stores read failed: ${error.message}`); continue; }
    for (const s of (data || []) as any[]) { out.set(s.id, { id: s.id, name: s.name || 'Outlet', city: null }); cityOf.set(s.id, s.city_id ?? null); }
  }
  const cityIds = Array.from(new Set(Array.from(cityOf.values()).filter((c): c is string => !!c)));
  if (cityIds.length) {
    const names = new Map<string, string>();
    for (const part of chunk(cityIds)) {
      const { data, error } = await supabaseAdmin.from('cities').select('id, name').in('id', part);
      if (error) { logger.warn(`[ffm-plus] cities read failed: ${error.message}`); continue; }
      for (const c of (data || []) as any[]) names.set(c.id, c.name);
    }
    for (const [sid, cid] of cityOf) { const s = out.get(sid); if (s && cid) s.city = names.get(cid) ?? null; }
  }
  return out;
}

export interface AlertCounts { mock_location: number; vpn_detected: number }

/** Mock-location / VPN alerts per user in [from, to] (security_alerts). Soft: a missing table reads as no alerts. */
export async function loadSecurityAlerts(scope: FfmScope, userIds: Set<string>, from: string, to: string): Promise<Map<string, AlertCounts>> {
  const out = new Map<string, AlertCounts>();
  if (!userIds.size) return out;
  const rows = await fetchAll<any>('security_alerts', true, (a, b) =>
    supabaseAdmin.from('security_alerts').select('user_id, type')
      .eq('org_id', scope.orgId)
      .gte('created_at', `${from}T00:00:00+05:30`).lt('created_at', `${addDaysYmd(to, 1)}T00:00:00+05:30`)
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(a, b) as any);
  for (const r of rows) {
    if (!userIds.has(r.user_id)) continue;
    const cur = out.get(r.user_id) || { mock_location: 0, vpn_detected: 0 };
    if (r.type === 'MOCK_LOCATION') cur.mock_location += 1;
    else if (r.type === 'VPN_DETECTED') cur.vpn_detected += 1;
    out.set(r.user_id, cur);
  }
  return out;
}

/** Server-flagged teleport pings per user in [from, to] (work_activity.is_suspect). Soft. */
export async function loadSuspectPings(scope: FfmScope, userIds: Set<string>, from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!userIds.size) return out;
  const rows = await fetchAll<any>('work_activity', true, (a, b) =>
    supabaseAdmin.from('work_activity').select('user_id')
      .eq('org_id', scope.orgId).eq('is_suspect', true)
      .gte('captured_at', `${from}T00:00:00+05:30`).lt('captured_at', `${addDaysYmd(to, 1)}T00:00:00+05:30`)
      .order('captured_at', { ascending: true }).order('id', { ascending: true }).range(a, b) as any);
  for (const r of rows) if (userIds.has(r.user_id)) out.set(r.user_id, (out.get(r.user_id) || 0) + 1);
  return out;
}
