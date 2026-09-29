import { supabaseAdmin as supabase } from '../lib/supabase';
import { optimizeRoute, haversineKm, GeoPoint, OutletPoint } from './route-optimizer.service';
import { resolveFactor, normalizeVehicleType, DEFAULT_VEHICLE_TYPE } from './carbon.service';

/**
 * TEAM auto-assignment — the engine behind the dashboard's "Automated Route
 * Plans" section. Where route-autoplan.service.buildAutoPlanDraft() designs a
 * plan for ONE named FE, this decides, for a whole org on a given day, WHICH
 * field executive gets WHICH due outlets — under a manager-chosen METHOD — and
 * then sequences each FE's stops shortest-path.
 *
 * Shared shape for every method:
 *   1. build the DUE POOL once — outlets overdue against their cadence
 *      (outlet_visit_frequency) or flagged priority=high, that aren't already
 *      on someone's plan for that date and have coordinates;
 *   2. load the active FIELD EXECUTIVES (never the manager/admin tier), each
 *      with a start point (live GPS → zone meeting point → first outlet);
 *   3. the chosen METHOD distributes the pool across the FEs (respecting a
 *      per-FE cap); a common cap-enforcer spills overflow to the nearest
 *      under-cap FE and records anything that couldn't be placed;
 *   4. each FE's outlets are ordered nearest-neighbour + 2-opt from their start.
 *
 * Pure compute — it never writes. The controller decides preview vs assign, so
 * the dashboard preview and the persisted plans always agree.
 */

export type AutoPlanMethod =
  | 'cadence_priority'
  | 'territory'
  | 'geo_cluster'
  | 'nearest_fe'
  | 'balanced_workload'
  | 'recurring_pjp'
  | 'manual';

/** UI catalog — single source of truth the dashboard renders method cards from. */
export interface AutoPlanMethodMeta {
  id: AutoPlanMethod;
  label: string;
  tagline: string;
  description: string;
  /** true = this method auto-assigns; 'manual' does not. */
  automatic: boolean;
  /** Which shared params this method actually uses (for the config UI). */
  uses: Array<'max_outlets_per_fe' | 'vehicle_type' | 'max_radius_km'>;
}

export const AUTOPLAN_METHODS: AutoPlanMethodMeta[] = [
  {
    id: 'cadence_priority',
    label: 'Cadence & priority',
    tagline: 'Cover the most overdue outlets, split evenly',
    description:
      'Ranks every outlet that is overdue against its visit cadence or flagged high priority, then shares them out evenly across all field executives — most-urgent first. Best when you just want due outlets covered fairly, regardless of geography.',
    automatic: true,
    uses: ['max_outlets_per_fe', 'vehicle_type'],
  },
  {
    id: 'territory',
    label: 'Territory / beat',
    tagline: 'Assign by the city each rep owns',
    description:
      "Groups due outlets by city and hands each city's outlets to the field executive(s) who cover that city (by their zone). Outlets in a city no one covers are given to the least-loaded rep. Best when reps own stable beats.",
    automatic: true,
    uses: ['max_outlets_per_fe', 'vehicle_type'],
  },
  {
    id: 'geo_cluster',
    label: 'Geographic clusters',
    tagline: 'Group nearby outlets, one cluster per rep',
    description:
      'Clusters the day’s due outlets by location and assigns each compact cluster to its nearest field executive. Produces tight, low-travel routes without any pre-drawn territories.',
    automatic: true,
    uses: ['max_outlets_per_fe', 'vehicle_type'],
  },
  {
    id: 'nearest_fe',
    label: 'Nearest field executive',
    tagline: 'Each outlet to the closest available rep',
    description:
      'Assigns every due outlet to the nearest field executive who still has capacity (by their live location or base). Great for reactive, same-day planning.',
    automatic: true,
    uses: ['max_outlets_per_fe', 'vehicle_type', 'max_radius_km'],
  },
  {
    id: 'balanced_workload',
    label: 'Balanced workload',
    tagline: 'Even out stops across the team',
    description:
      'Distributes due outlets so every field executive gets a similar number of stops, preferring the nearest rep under the average. Prevents one rep getting 25 stops while another gets 4.',
    automatic: true,
    uses: ['max_outlets_per_fe', 'vehicle_type', 'max_radius_km'],
  },
  {
    id: 'recurring_pjp',
    label: 'Recurring journey plan',
    tagline: 'Fixed weekday beats from preferred day',
    description:
      "A permanent journey plan: only outlets whose preferred day matches the plan date's weekday (or that have no preferred day set) are scheduled, then assigned by territory. Set preferred days in Outlet Priorities to build a repeating weekly beat.",
    automatic: true,
    uses: ['max_outlets_per_fe', 'vehicle_type'],
  },
  {
    id: 'manual',
    label: 'Manual only',
    tagline: 'No auto-assignment — plan by hand',
    description:
      'Turns automatic assignment off. Managers build each route plan themselves. You can switch to an automatic method at any time.',
    automatic: false,
    uses: [],
  },
];

export function isAutoPlanMethod(v: unknown): v is AutoPlanMethod {
  return typeof v === 'string' && AUTOPLAN_METHODS.some((m) => m.id === v);
}

// Cadence (days) implied by an outlet_visit_frequency.frequency value. Mirrors
// route-autoplan.service (daily|weekly|bi_weekly|monthly + legacy spellings).
const FREQUENCY_DAYS: Record<string, number> = {
  daily: 1, weekly: 7, bi_weekly: 14, 'bi-weekly': 14, biweekly: 14,
  fortnightly: 14, monthly: 30, quarterly: 90,
};
const DAY_MS = 86_400_000;
const DEFAULT_CAP = 15;
const DEFAULT_RADIUS_KM = 25;

const round = (n: number, dp: number): number => {
  const m = Math.pow(10, dp);
  return Math.round((Number(n) || 0) * m) / m;
};

const ADMIN_TIER = new Set(['sub_admin', 'admin', 'main_admin', 'super_admin', 'client']);

export interface DueOutlet {
  store_id: string;
  store_name: string;
  store_code: string | null;
  lat: number;
  lng: number;
  city: string | null;
  reason: 'overdue' | 'high_priority';
  priority: string | null;
  frequency: string | null;
  overdue_days: number | null;
  never_visited: boolean;
  preferred_day: number | null;
  score: number;
}

export interface FieldExec {
  user_id: string;
  name: string;
  start: GeoPoint | null;
  /**
   * Where `start` came from. Field executives have no coordinates until they
   * first check in, so the chain falls back: live GPS → a manager-set base
   * (users.base_lat/base_lng) → the last CAPTURED fix from the work_activity
   * ping log (survives checkout, unlike users.last_latitude which is nulled) →
   * the FE's zone meeting point → none (sequencing then starts at first outlet).
   */
  start_source: 'live_location' | 'base_location' | 'last_capture' | 'zone_meeting' | 'none';
  cities: string[]; // lower-cased cities this FE covers (own city + zone city)
  has_live: boolean;
  base: GeoPoint | null;
  last_capture: { lat: number; lng: number; at: string } | null;
}

export interface FeDraftStop {
  store_id: string;
  store_name: string;
  store_code: string | null;
  visit_order: number;
  lat: number;
  lng: number;
  reason: 'overdue' | 'high_priority';
  overdue_days: number | null;
  never_visited: boolean;
}

export interface FeDraft {
  user_id: string;
  user_name: string;
  stops: FeDraftStop[];
  total_km: number;
  est_co2_kg: number;
  start_source: FieldExec['start_source'] | 'first_outlet';
  start: GeoPoint | null;
}

export interface TeamAutoPlanResult {
  method: AutoPlanMethod;
  plan_date: string;
  vehicle_type: string;
  fes: FeDraft[];
  summary: {
    fe_count: number;
    considered: number;          // outlet_visit_frequency rows examined
    due_pool: number;            // outlets due & placeable
    assigned_outlets: number;
    unassigned_outlets: number;  // due but no FE had capacity / range
    skipped_no_geo: number;
    skipped_already_planned: number;
    cap_per_fe: number;
  };
}

export interface TeamAutoPlanOptions {
  orgId: string;
  planDate: string;                 // IST date yyyy-mm-dd
  method: AutoPlanMethod;
  maxOutletsPerFe?: number;
  vehicleType?: string;
  maxRadiusKm?: number;
}

// ── data loaders ──────────────────────────────────────────────────────────

async function loadDuePool(
  orgId: string,
  planDate: string,
): Promise<{ pool: DueOutlet[]; considered: number; skippedNoGeo: number; skippedPlanned: number }> {
  const { data: freqRows } = await supabase
    .from('outlet_visit_frequency')
    .select('store_id, frequency, priority, last_visited_at, preferred_day, is_active')
    .eq('org_id', orgId);
  const active = (freqRows || []).filter((f: any) => f.is_active !== false && f.store_id);

  const storeIds = active.map((f: any) => f.store_id);
  const storeById = new Map<string, any>();
  if (storeIds.length) {
    const { data: stores } = await supabase
      .from('stores')
      .select('id, name, store_code, lat, lng, city, is_active')
      .eq('org_id', orgId)
      .in('id', storeIds);
    (stores || []).forEach((s: any) => { if (s.is_active !== false) storeById.set(s.id, s); });
  }

  // Outlets already planned for this date (any FE) — never double-book.
  const plannedStores = await alreadyPlannedStores(orgId, planDate);

  const planDateMs = new Date(`${planDate}T23:59:59+05:30`).getTime();
  let skippedPlanned = 0;
  let skippedNoGeo = 0;
  const pool: DueOutlet[] = [];

  for (const f of active as any[]) {
    const cadenceDays = FREQUENCY_DAYS[(f.frequency || '').toLowerCase()];
    const high = (f.priority || '').toLowerCase() === 'high';

    let overdue = false;
    let overdueDays: number | null = null;
    let neverVisited = false;
    if (cadenceDays != null) {
      if (!f.last_visited_at) {
        overdue = true;
        neverVisited = true;
      } else {
        const daysSince = (planDateMs - new Date(f.last_visited_at).getTime()) / DAY_MS;
        if (daysSince >= cadenceDays) {
          overdue = true;
          overdueDays = Math.max(0, Math.floor(daysSince - cadenceDays));
        }
      }
    }
    if (!overdue && !high) continue;

    const store = storeById.get(f.store_id);
    if (!store) continue;
    if (plannedStores.has(f.store_id)) { skippedPlanned++; continue; }
    if (typeof store.lat !== 'number' || typeof store.lng !== 'number') { skippedNoGeo++; continue; }

    const urgency = neverVisited ? 3 : (overdueDays != null && cadenceDays ? Math.min(overdueDays / cadenceDays, 3) : 0);
    const prioWeight = high ? 2 : (f.priority || '').toLowerCase() === 'normal' ? 1 : 0;
    pool.push({
      store_id: f.store_id,
      store_name: store.name || store.store_code || 'Outlet',
      store_code: store.store_code ?? null,
      lat: store.lat,
      lng: store.lng,
      city: (store.city ?? null) ? String(store.city).trim() : null,
      reason: overdue ? 'overdue' : 'high_priority',
      priority: f.priority ?? null,
      frequency: f.frequency ?? null,
      overdue_days: overdueDays,
      never_visited: neverVisited,
      preferred_day: f.preferred_day != null ? Number(f.preferred_day) : null,
      score: (overdue ? 2 : 0) + prioWeight + urgency,
    });
  }

  pool.sort((a, b) => b.score - a.score);
  return { pool, considered: active.length, skippedNoGeo, skippedPlanned };
}

async function alreadyPlannedStores(orgId: string, planDate: string): Promise<Set<string>> {
  const { data: dayPlans } = await supabase
    .from('route_plans')
    .select('id')
    .eq('org_id', orgId)
    .eq('plan_date', planDate);
  const ids = (dayPlans || []).map((p: any) => p.id);
  const set = new Set<string>();
  if (ids.length) {
    const { data: rows } = await supabase
      .from('route_plan_outlets')
      .select('store_id, route_plan_id')
      .in('route_plan_id', ids);
    (rows || []).forEach((o: any) => { if (o.store_id) set.add(o.store_id); });
  }
  return set;
}

export async function loadFieldExecs(orgId: string): Promise<FieldExec[]> {
  const { data } = await supabase
    .from('users')
    .select('id, name, role, city, last_latitude, last_longitude, base_lat, base_lng, org_role:org_roles!org_role_id(data_scope), zones:zones!zone_id(name, city, meeting_lat, meeting_lng)')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .not('role', 'in', '(admin,super_admin)');

  interface Tmp { exec: FieldExec; live: GeoPoint | null; zone: GeoPoint | null }
  const tmps: Tmp[] = [];
  for (const u of (data || []) as any[]) {
    const rel = Array.isArray(u.org_role) ? u.org_role[0] : u.org_role;
    const scope = rel?.data_scope;
    const isManagerTier = ADMIN_TIER.has(String(u.role || '').toLowerCase()) && (scope === 'team' || scope === 'all');
    if (isManagerTier) continue; // never assign to the manager/admin tier

    const zoneRow = Array.isArray(u.zones) ? u.zones[0] : u.zones;
    const live: GeoPoint | null = (typeof u.last_latitude === 'number' && typeof u.last_longitude === 'number')
      ? { lat: u.last_latitude, lng: u.last_longitude } : null;
    const base: GeoPoint | null = (typeof u.base_lat === 'number' && typeof u.base_lng === 'number')
      ? { lat: u.base_lat, lng: u.base_lng } : null;
    const zone: GeoPoint | null = (zoneRow && typeof zoneRow.meeting_lat === 'number' && typeof zoneRow.meeting_lng === 'number')
      ? { lat: zoneRow.meeting_lat, lng: zoneRow.meeting_lng } : null;

    const cities = new Set<string>();
    if (u.city) cities.add(String(u.city).trim().toLowerCase());
    if (zoneRow?.city) cities.add(String(zoneRow.city).trim().toLowerCase());

    tmps.push({
      exec: {
        user_id: u.id, name: u.name || 'Field executive',
        start: null, start_source: 'none', cities: Array.from(cities),
        has_live: !!live, base, last_capture: null,
      },
      live, zone,
    });
  }

  // Attach each FE's last CAPTURED fix from the work_activity ping log (used for
  // the start fallback AND surfaced so the UI can offer "use last known").
  const capById = await fetchLastCaptures(orgId, tmps.map((t) => t.exec.user_id));
  for (const t of tmps) {
    t.exec.last_capture = capById.get(t.exec.user_id) ?? null;
    // start chain: live GPS → manager-set base → last captured fix → zone meeting.
    if (t.live) { t.exec.start = t.live; t.exec.start_source = 'live_location'; }
    else if (t.exec.base) { t.exec.start = t.exec.base; t.exec.start_source = 'base_location'; }
    else if (t.exec.last_capture) { t.exec.start = { lat: t.exec.last_capture.lat, lng: t.exec.last_capture.lng }; t.exec.start_source = 'last_capture'; }
    else if (t.zone) { t.exec.start = t.zone; t.exec.start_source = 'zone_meeting'; }
  }
  return tmps.map((t) => t.exec);
}

/**
 * Latest non-(0,0) fix per user from the work_activity ping log. Append-only, so
 * it survives checkout (which nulls users.last_latitude) — this is the durable
 * "last captured during last ping / checkout" location.
 */
async function fetchLastCaptures(
  orgId: string,
  userIds: string[],
): Promise<Map<string, { lat: number; lng: number; at: string }>> {
  const out = new Map<string, { lat: number; lng: number; at: string }>();
  if (!userIds.length) return out;
  const { data } = await supabase
    .from('work_activity')
    .select('user_id, lat, lng, captured_at, activity_type')
    .eq('org_id', orgId)
    .in('user_id', userIds)
    .in('activity_type', ['HEARTBEAT', 'CHECK_IN', 'CHECK_OUT', 'FORM_SUBMIT'])
    .order('captured_at', { ascending: false })
    .limit(3000);
  for (const r of (data || []) as any[]) {
    if (out.has(r.user_id)) continue; // desc order ⇒ first seen is the latest
    const lat = Number(r.lat), lng = Number(r.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
    out.set(r.user_id, { lat, lng, at: r.captured_at });
  }
  return out;
}

// ── cap enforcement (shared) ─────────────────────────────────────────────

/**
 * Trim each FE's list to `cap`, then try to re-home the overflow (lowest score
 * first) onto the nearest FE that still has room. Anything that can't be placed
 * is returned as `unassigned`. Mutates `assigned` in place.
 */
function enforceCaps(
  assigned: Map<string, DueOutlet[]>,
  fes: FieldExec[],
  cap: number,
): DueOutlet[] {
  const overflow: DueOutlet[] = [];
  for (const [uid, list] of assigned) {
    if (list.length <= cap) continue;
    list.sort((a, b) => b.score - a.score);
    overflow.push(...list.splice(cap)); // keep the top `cap`
    assigned.set(uid, list);
  }
  const unassigned: DueOutlet[] = [];
  overflow.sort((a, b) => b.score - a.score);
  for (const o of overflow) {
    const target = nearestFeWithRoom(o, fes, assigned, cap, Infinity);
    if (target) assigned.get(target)!.push(o);
    else unassigned.push(o);
  }
  return unassigned;
}

function nearestFeWithRoom(
  o: DueOutlet,
  fes: FieldExec[],
  assigned: Map<string, DueOutlet[]>,
  cap: number,
  maxRadiusKm: number,
): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const fe of fes) {
    if ((assigned.get(fe.user_id)?.length ?? 0) >= cap) continue;
    const d = fe.start ? haversineKm(fe.start, { lat: o.lat, lng: o.lng }) : Number.MAX_SAFE_INTEGER;
    if (d < bestD && d <= maxRadiusKm) { bestD = d; best = fe.user_id; }
  }
  // If nobody is in range (or no FE has a location), fall back to the emptiest FE.
  if (!best) {
    let min = Infinity;
    for (const fe of fes) {
      const n = assigned.get(fe.user_id)?.length ?? 0;
      if (n < cap && n < min) { min = n; best = fe.user_id; }
    }
  }
  return best;
}

const emptyMap = (fes: FieldExec[]): Map<string, DueOutlet[]> =>
  new Map(fes.map((f) => [f.user_id, [] as DueOutlet[]]));

// ── assignment strategies ────────────────────────────────────────────────

/** Round-robin the urgency-sorted pool across FEs (coverage-first). */
function assignCadencePriority(pool: DueOutlet[], fes: FieldExec[]): Map<string, DueOutlet[]> {
  const map = emptyMap(fes);
  pool.forEach((o, i) => map.get(fes[i % fes.length].user_id)!.push(o));
  return map;
}

/** Group by city → FE(s) covering that city; unmatched cities → least-loaded FE. */
function assignTerritory(pool: DueOutlet[], fes: FieldExec[]): Map<string, DueOutlet[]> {
  const map = emptyMap(fes);
  const rr = new Map<string, number>(); // per-city round-robin cursor
  for (const o of pool) {
    const city = (o.city || '').toLowerCase();
    const owners = city ? fes.filter((f) => f.cities.includes(city)) : [];
    if (owners.length) {
      const k = rr.get(city) || 0;
      map.get(owners[k % owners.length].user_id)!.push(o);
      rr.set(city, k + 1);
    } else {
      leastLoaded(map, fes)!.push(o);
    }
  }
  return map;
}

/** k-means clusters (k = #FE) → each cluster to its nearest FE start. */
function assignGeoCluster(pool: DueOutlet[], fes: FieldExec[]): Map<string, DueOutlet[]> {
  const k = Math.min(fes.length, pool.length) || 1;
  const clusters = kmeans(pool, k);
  const map = emptyMap(fes);
  const usedFe = new Set<string>();
  for (const cluster of clusters) {
    if (!cluster.points.length) continue;
    // pick the closest not-yet-used FE to this cluster centroid; then allow reuse.
    let best: FieldExec | null = null;
    let bestD = Infinity;
    for (const fe of fes) {
      if (!fe.start) continue;
      if (usedFe.has(fe.user_id) && usedFe.size < fes.length) continue;
      const d = haversineKm(fe.start, cluster.centroid);
      if (d < bestD) { bestD = d; best = fe; }
    }
    if (!best) best = fes.find((f) => !usedFe.has(f.user_id)) || fes[0];
    usedFe.add(best.user_id);
    map.get(best.user_id)!.push(...cluster.points);
  }
  return map;
}

/** Greedy: each outlet (urgency order) → nearest under-cap FE within radius. */
function assignNearestFe(pool: DueOutlet[], fes: FieldExec[], cap: number, radiusKm: number): Map<string, DueOutlet[]> {
  const map = emptyMap(fes);
  for (const o of pool) {
    const uid = nearestFeWithRoom(o, fes, map, cap, radiusKm);
    if (uid) map.get(uid)!.push(o);
  }
  return map;
}

/** Assign each outlet to the least-loaded FE (nearest breaks ties) within radius. */
function assignBalanced(pool: DueOutlet[], fes: FieldExec[], cap: number, radiusKm: number): Map<string, DueOutlet[]> {
  const map = emptyMap(fes);
  for (const o of pool) {
    let best: string | null = null;
    let bestLoad = Infinity;
    let bestD = Infinity;
    for (const fe of fes) {
      const load = map.get(fe.user_id)!.length;
      if (load >= cap) continue;
      const d = fe.start ? haversineKm(fe.start, { lat: o.lat, lng: o.lng }) : Number.MAX_SAFE_INTEGER;
      if (d > radiusKm && Number.isFinite(d)) continue;
      if (load < bestLoad || (load === bestLoad && d < bestD)) { bestLoad = load; bestD = d; best = fe.user_id; }
    }
    if (!best) best = leastLoadedId(map, fes, cap);
    if (best) map.get(best)!.push(o);
  }
  return map;
}

/** Recurring PJP: only outlets due on this weekday (by preferred_day), then territory. */
function assignRecurringPjp(pool: DueOutlet[], fes: FieldExec[], planDate: string): Map<string, DueOutlet[]> {
  const dow = new Date(`${planDate}T12:00:00+05:30`).getDay(); // 0=Sun..6=Sat
  const scoped = pool.filter((o) => o.preferred_day == null || Number(o.preferred_day) === dow);
  return assignTerritory(scoped, fes);
}

function leastLoaded(map: Map<string, DueOutlet[]>, fes: FieldExec[]): DueOutlet[] | null {
  const id = leastLoadedId(map, fes, Infinity);
  return id ? map.get(id)! : null;
}
function leastLoadedId(map: Map<string, DueOutlet[]>, fes: FieldExec[], cap: number): string | null {
  let best: string | null = null;
  let min = Infinity;
  for (const fe of fes) {
    const n = map.get(fe.user_id)!.length;
    if (n < cap && n < min) { min = n; best = fe.user_id; }
  }
  return best;
}

// ── tiny k-means (k-means++ seed, a few iterations) ───────────────────────

interface Cluster { centroid: GeoPoint; points: DueOutlet[] }

function kmeans(points: DueOutlet[], k: number): Cluster[] {
  if (points.length <= k) return points.map((p) => ({ centroid: { lat: p.lat, lng: p.lng }, points: [p] }));
  // k-means++ seeding
  const centroids: GeoPoint[] = [{ lat: points[0].lat, lng: points[0].lng }];
  while (centroids.length < k) {
    let far: DueOutlet | null = null;
    let farD = -1;
    for (const p of points) {
      const d = Math.min(...centroids.map((c) => haversineKm(c, { lat: p.lat, lng: p.lng })));
      if (d > farD) { farD = d; far = p; }
    }
    centroids.push({ lat: far!.lat, lng: far!.lng });
  }
  let clusters: Cluster[] = centroids.map((c) => ({ centroid: c, points: [] }));
  for (let iter = 0; iter < 8; iter++) {
    clusters.forEach((c) => (c.points = []));
    for (const p of points) {
      let bi = 0, bd = Infinity;
      clusters.forEach((c, i) => {
        const d = haversineKm(c.centroid, { lat: p.lat, lng: p.lng });
        if (d < bd) { bd = d; bi = i; }
      });
      clusters[bi].points.push(p);
    }
    let moved = false;
    for (const c of clusters) {
      if (!c.points.length) continue;
      const lat = c.points.reduce((s, p) => s + p.lat, 0) / c.points.length;
      const lng = c.points.reduce((s, p) => s + p.lng, 0) / c.points.length;
      if (Math.abs(lat - c.centroid.lat) > 1e-6 || Math.abs(lng - c.centroid.lng) > 1e-6) moved = true;
      c.centroid = { lat, lng };
    }
    if (!moved) break;
  }
  return clusters;
}

// ── orchestrator ──────────────────────────────────────────────────────────

export async function buildTeamAutoPlan(opts: TeamAutoPlanOptions): Promise<TeamAutoPlanResult> {
  const { orgId, planDate, method } = opts;
  const cap = Math.min(Math.max(Number(opts.maxOutletsPerFe) || DEFAULT_CAP, 1), 50);
  const vehicleType = normalizeVehicleType(opts.vehicleType || DEFAULT_VEHICLE_TYPE);
  const radiusKm = Math.min(Math.max(Number(opts.maxRadiusKm) || DEFAULT_RADIUS_KM, 1), 500);

  const [{ pool, considered, skippedNoGeo, skippedPlanned }, fes] = await Promise.all([
    loadDuePool(orgId, planDate),
    loadFieldExecs(orgId),
  ]);

  const emptyResult = (): TeamAutoPlanResult => ({
    method, plan_date: planDate, vehicle_type: vehicleType, fes: [],
    summary: {
      fe_count: fes.length, considered, due_pool: pool.length, assigned_outlets: 0,
      unassigned_outlets: pool.length, skipped_no_geo: skippedNoGeo,
      skipped_already_planned: skippedPlanned, cap_per_fe: cap,
    },
  });

  if (method === 'manual') return emptyResult();
  if (!fes.length || !pool.length) return emptyResult();

  // 1. distribute
  let assigned: Map<string, DueOutlet[]>;
  switch (method) {
    case 'territory': assigned = assignTerritory(pool, fes); break;
    case 'geo_cluster': assigned = assignGeoCluster(pool, fes); break;
    case 'nearest_fe': assigned = assignNearestFe(pool, fes, cap, radiusKm); break;
    case 'balanced_workload': assigned = assignBalanced(pool, fes, cap, radiusKm); break;
    case 'recurring_pjp': assigned = assignRecurringPjp(pool, fes, planDate); break;
    case 'cadence_priority':
    default: assigned = assignCadencePriority(pool, fes); break;
  }

  // 2. enforce the per-FE cap (spill overflow to nearest under-cap FE)
  const unassigned = enforceCaps(assigned, fes, cap);

  // 3. sequence each FE's stops shortest-path from their start
  const factor = await resolveFactor(orgId, vehicleType);
  const feDrafts: FeDraft[] = [];
  let assignedCount = 0;
  for (const fe of fes) {
    const list = assigned.get(fe.user_id) || [];
    if (!list.length) continue;
    const points: OutletPoint[] = list.map((c) => ({ id: c.store_id, lat: c.lat, lng: c.lng }));
    const start = fe.start ?? undefined;
    const seq = await optimizeRoute(orgId, vehicleType, start, points);
    const byStore = new Map(list.map((c) => [c.store_id, c]));
    const stops: FeDraftStop[] = seq.ordered.map((sid, i) => {
      const c = byStore.get(sid)!;
      return {
        store_id: c.store_id, store_name: c.store_name, store_code: c.store_code,
        visit_order: i + 1, lat: c.lat, lng: c.lng, reason: c.reason,
        overdue_days: c.overdue_days, never_visited: c.never_visited,
      };
    });
    assignedCount += stops.length;
    feDrafts.push({
      user_id: fe.user_id,
      user_name: fe.name,
      stops,
      total_km: round(seq.optimized_km, 2),
      est_co2_kg: round(seq.optimized_km * factor, 3),
      start_source: fe.start ? fe.start_source : 'first_outlet',
      start: fe.start,
    });
  }
  feDrafts.sort((a, b) => a.user_name.localeCompare(b.user_name));

  return {
    method, plan_date: planDate, vehicle_type: vehicleType, fes: feDrafts,
    summary: {
      fe_count: fes.length, considered, due_pool: pool.length,
      assigned_outlets: assignedCount, unassigned_outlets: unassigned.length,
      skipped_no_geo: skippedNoGeo, skipped_already_planned: skippedPlanned, cap_per_fe: cap,
    },
  };
}
