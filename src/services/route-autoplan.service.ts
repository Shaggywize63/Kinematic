import { supabaseAdmin as supabase } from '../lib/supabase';
import { optimizeRoute, GeoPoint, OutletPoint } from './route-optimizer.service';
import { resolveFactor, normalizeVehicleType, DEFAULT_VEHICLE_TYPE } from './carbon.service';

/**
 * Auto-plan GENERATION — designs a brand-new route plan for an FE's day from
 * the outlet cadence + priority the supervisor maintains in Outlet Priorities
 * (outlet_visit_frequency). This is the missing half of the smart-route work:
 * buildRouteSuggestion() only RE-ORDERS a plan that already exists, while this
 * decides WHICH outlets belong on the day at all:
 *
 *   1. an outlet is DUE when it is overdue against its cadence (never visited,
 *      or plan_date - last_visited_at >= the cadence's days) or is flagged
 *      priority = high;
 *   2. outlets already on ANY plan for that date are skipped (no double-booking
 *      an outlet across FEs);
 *   3. due outlets are ranked (overdue-and-high first, most-overdue first) and
 *      capped, then sequenced geometrically (nearest-neighbour + 2-opt) from
 *      the FE's live location → base location → first outlet.
 *
 * Pure compute — it never writes. The controller decides whether to persist
 * (dry_run preview vs create), so the web preview and the final assign always
 * agree.
 */

// Days implied by an outlet_visit_frequency.frequency value. The DB CHECK now
// allows daily|weekly|bi_weekly|monthly; legacy spellings kept for old rows.
const FREQUENCY_DAYS: Record<string, number> = {
  daily: 1, weekly: 7, bi_weekly: 14, 'bi-weekly': 14, biweekly: 14,
  fortnightly: 14, monthly: 30, quarterly: 90,
};

const DAY_MS = 86_400_000;

export interface AutoPlanStop {
  store_id: string;
  store_name: string;
  store_code: string | null;
  visit_order: number;
  lat: number;
  lng: number;
  reason: 'overdue' | 'high_priority';
  priority: string | null;
  frequency: string | null;
  /** Whole days past the cadence (null when the outlet was never visited). */
  overdue_days: number | null;
  never_visited: boolean;
}

export interface AutoPlanDraft {
  user_id: string;
  plan_date: string;
  vehicle_type: string;
  stops: AutoPlanStop[];
  total_km: number;
  est_co2_kg: number;
  start_source: 'live_location' | 'base_location' | 'first_outlet';
  start: GeoPoint | null;
  /** Cadence/priority rows considered for this org. */
  considered: number;
  /** Due outlets skipped because another plan for this date already has them. */
  skipped_already_planned: number;
  /** Due outlets skipped for missing store coordinates. */
  skipped_no_geo: number;
  /** The target FE's existing plan ids on this date (assign would replace). */
  existing_plan_ids: string[];
}

export interface AutoPlanOptions {
  orgId: string;
  userId: string;        // the FE the plan is designed for
  planDate: string;      // IST date (yyyy-mm-dd)
  maxOutlets?: number;   // default 15, clamped 1..50
  vehicleType?: string;
}

const round = (n: number, dp: number): number => {
  const m = Math.pow(10, dp);
  return Math.round((Number(n) || 0) * m) / m;
};

export async function buildAutoPlanDraft(opts: AutoPlanOptions): Promise<AutoPlanDraft> {
  const { orgId, userId, planDate } = opts;
  const maxOutlets = Math.min(Math.max(Number(opts.maxOutlets) || 15, 1), 50);
  const vehicleType = normalizeVehicleType(opts.vehicleType || DEFAULT_VEHICLE_TYPE);

  // 1. Cadence/priority rows for the org. NOTE: outlet_visit_frequency has no
  //    FK to stores, so PostgREST can't embed — fetch stores separately.
  const { data: freqRows } = await supabase
    .from('outlet_visit_frequency')
    .select('store_id, frequency, priority, last_visited_at, is_active')
    .eq('org_id', orgId);
  const active = (freqRows || []).filter((f: any) => f.is_active !== false && f.store_id);

  const storeIds = active.map((f: any) => f.store_id);
  const storeById = new Map<string, any>();
  if (storeIds.length) {
    const { data: stores } = await supabase
      .from('stores')
      .select('id, name, store_code, lat, lng, is_active')
      .eq('org_id', orgId)
      .in('id', storeIds);
    (stores || []).forEach((s: any) => { if (s.is_active !== false) storeById.set(s.id, s); });
  }

  // 2. Outlets already planned for this date (any FE) — don't double-book.
  const { data: dayPlans } = await supabase
    .from('route_plans')
    .select('id, user_id')
    .eq('org_id', orgId)
    .eq('plan_date', planDate);
  const dayPlanIds = (dayPlans || []).map((p: any) => p.id);
  const existingPlanIds = (dayPlans || []).filter((p: any) => p.user_id === userId).map((p: any) => p.id);
  const plannedStores = new Set<string>();
  if (dayPlanIds.length) {
    const { data: dayOutlets } = await supabase
      .from('route_plan_outlets')
      .select('store_id, route_plan_id')
      .in('route_plan_id', dayPlanIds);
    (dayOutlets || []).forEach((o: any) => { if (o.store_id) plannedStores.add(o.store_id); });
  }

  // 3. Which outlets are DUE on plan_date?
  const planDateMs = new Date(`${planDate}T23:59:59+05:30`).getTime();
  let skippedPlanned = 0;
  let skippedNoGeo = 0;
  type Candidate = AutoPlanStop & { score: number };
  const candidates: Candidate[] = [];

  for (const f of active as any[]) {
    const cadenceDays = FREQUENCY_DAYS[(f.frequency || '').toLowerCase()];
    const high = (f.priority || '').toLowerCase() === 'high';

    let overdue = false;
    let overdueDays: number | null = null;
    let neverVisited = false;
    if (cadenceDays != null) {
      if (!f.last_visited_at) {
        overdue = true;                 // has a cadence but never visited
        neverVisited = true;
      } else {
        const daysSince = (planDateMs - new Date(f.last_visited_at).getTime()) / DAY_MS;
        if (daysSince >= cadenceDays) {
          overdue = true;
          overdueDays = Math.max(0, Math.floor(daysSince - cadenceDays));
        }
      }
    }
    if (!overdue && !high) continue;    // not due — leave it off the plan

    const store = storeById.get(f.store_id);
    if (!store) continue;               // inactive / missing store
    if (plannedStores.has(f.store_id)) { skippedPlanned++; continue; }
    if (typeof store.lat !== 'number' || typeof store.lng !== 'number') { skippedNoGeo++; continue; }

    // Rank: overdue + high first, then how badly overdue (never-visited counts
    // as maximally overdue), so the cap keeps the most urgent outlets.
    const urgency = neverVisited ? 3 : overdueDays != null && cadenceDays
      ? Math.min(overdueDays / cadenceDays, 3) : 0;
    const prioWeight = high ? 2 : (f.priority || '').toLowerCase() === 'normal' ? 1 : 0;
    candidates.push({
      store_id: f.store_id,
      store_name: store.name || store.store_code || 'Outlet',
      store_code: store.store_code ?? null,
      visit_order: 0,
      lat: store.lat,
      lng: store.lng,
      reason: overdue ? 'overdue' : 'high_priority',
      priority: f.priority ?? null,
      frequency: f.frequency ?? null,
      overdue_days: overdueDays,
      never_visited: neverVisited,
      score: (overdue ? 2 : 0) + prioWeight + urgency,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = candidates.slice(0, maxOutlets);

  // 4. Start point: FE live GPS → base location → first outlet.
  let start: GeoPoint | undefined;
  let startSource: AutoPlanDraft['start_source'] = 'first_outlet';
  const { data: fe } = await supabase
    .from('users')
    .select('last_latitude, last_longitude, base_lat, base_lng')
    .eq('id', userId)
    .maybeSingle();
  if (fe && typeof fe.last_latitude === 'number' && typeof fe.last_longitude === 'number') {
    start = { lat: fe.last_latitude, lng: fe.last_longitude };
    startSource = 'live_location';
  } else if (fe && typeof fe.base_lat === 'number' && typeof fe.base_lng === 'number') {
    start = { lat: fe.base_lat, lng: fe.base_lng };
    startSource = 'base_location';
  }

  // 5. Sequence geometrically; keep the urgency rank only as the input order.
  let stops: AutoPlanStop[] = [];
  let totalKm = 0;
  if (picked.length) {
    const points: OutletPoint[] = picked.map((c) => ({ id: c.store_id, lat: c.lat, lng: c.lng }));
    const res = await optimizeRoute(orgId, vehicleType, start, points);
    const byStore = new Map(picked.map((c) => [c.store_id, c]));
    stops = res.ordered.map((sid, i) => {
      const { score: _score, ...stop } = byStore.get(sid)!;
      return { ...stop, visit_order: i + 1 };
    });
    totalKm = res.optimized_km;
  }
  const factor = await resolveFactor(orgId, vehicleType);

  return {
    user_id: userId,
    plan_date: planDate,
    vehicle_type: vehicleType,
    stops,
    total_km: round(totalKm, 2),
    est_co2_kg: round(totalKm * factor, 3),
    start_source: startSource,
    start: start ?? null,
    considered: active.length,
    skipped_already_planned: skippedPlanned,
    skipped_no_geo: skippedNoGeo,
    existing_plan_ids: existingPlanIds,
  };
}
