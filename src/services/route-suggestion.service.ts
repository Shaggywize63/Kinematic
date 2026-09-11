import { supabaseAdmin as supabase } from '../lib/supabase';
import { optimizeRoute, haversineKm, GeoPoint, OutletPoint } from './route-optimizer.service';
import { resolveFactor, normalizeVehicleType, DEFAULT_VEHICLE_TYPE } from './carbon.service';

/**
 * Smart route suggestion — builds an optimized, priority-weighted visit order
 * for a rep's day, starting from their CURRENT location, and (optionally) folds
 * in nearby open CRM leads.
 *
 * It layers three signals on top of the geometric optimizer
 * (nearest-neighbour + 2-opt over haversine — no external maps API):
 *   1. start point = the rep's live GPS (users.last_latitude/last_longitude),
 *      falling back to their base location, then to the first outlet.
 *   2. priority tiering from outlet_visit_frequency — outlets that are OVERDUE
 *      against their cadence, or flagged priority='high', are sequenced first
 *      (each tier still geometrically optimized). Degrades to pure-geometric
 *      when no frequency rows exist, so tenants without cadences are unchanged.
 *   3. remainingOnly drops stops already checked in, so a mid-day
 *      "re-optimize the rest of my route from here" works.
 *
 * Pure compute — it never writes. Callers (the FE one-tap suggest, the
 * optimize/apply persist, and the supervisor auto-plan) decide whether to save.
 */

// Cadence (days) implied by an outlet_visit_frequency.frequency text value.
const FREQUENCY_DAYS: Record<string, number> = {
  daily: 1, weekly: 7, fortnightly: 14, biweekly: 14, 'bi-weekly': 14,
  monthly: 30, quarterly: 90,
};
// Lead statuses worth folding into a beat (open / actionable).
const OPEN_LEAD_STATUSES = new Set(['new', 'qualified', 'working', 'nurturing']);

export type StartSource = 'explicit' | 'live_location' | 'base_location' | 'first_outlet';

export interface SuggestOptions {
  orgId: string;
  planUserId: string;
  date: string;                 // IST date (yyyy-mm-dd)
  start?: GeoPoint;             // explicit override (e.g. the device's fresh GPS)
  remainingOnly?: boolean;      // drop already-checked-in stops
  includeNearbyLeads?: boolean;
  nearbyRadiusKm?: number;      // default 2km
  nearbyLimit?: number;         // default 5
}

export interface SuggestedOutlet {
  outlet_id: string;            // route_plan_outlets.id
  store_id: string;
  visit_order: number;          // new 1-based order
  priority_reason: 'overdue' | 'high_priority' | null;
  lat: number;
  lng: number;
}
export interface PlanSuggestion {
  plan_id: string;
  vehicle_type: string;
  ordered: SuggestedOutlet[];
  original_km: number;
  optimized_km: number;
  saved_km: number;
  saved_co2_kg: number;
}
export interface NearbyLead {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distance_km: number;
  score: number | null;
  status: string | null;
  city: string | null;
}
export interface RouteSuggestion {
  date: string;
  start_source: StartSource;
  start: GeoPoint | null;
  plans: PlanSuggestion[];
  total_saved_km: number;
  nearby_leads: NearbyLead[];
}

const round = (n: number, dp: number): number => {
  const m = Math.pow(10, dp);
  return Math.round((Number(n) || 0) * m) / m;
};

function pathKm(start: GeoPoint, pts: GeoPoint[]): number {
  if (!pts.length) return 0;
  let sum = haversineKm(start, pts[0]);
  for (let i = 1; i < pts.length; i++) sum += haversineKm(pts[i - 1], pts[i]);
  return sum;
}

/** A route_plan_outlets row is "done" for the day once it has a check-in
 * timestamp or a terminal status — used by remainingOnly. Matches on the
 * status string loosely so it survives however the enum is spelled. */
function isDoneOutlet(o: { status?: string | null; checkin_at?: string | null }): boolean {
  if (o.checkin_at) return true;
  const s = (o.status || '').toLowerCase();
  return /visit|complet|done|skip|miss|cancel/.test(s);
}

export async function buildRouteSuggestion(opts: SuggestOptions): Promise<RouteSuggestion> {
  const { orgId, planUserId, date } = opts;
  const remainingOnly = opts.remainingOnly ?? false;
  const includeNearbyLeads = opts.includeNearbyLeads ?? false;
  const radiusKm = opts.nearbyRadiusKm ?? 2;
  const nearbyLimit = opts.nearbyLimit ?? 5;

  // 1. Load the rep's plan(s) for the date with store geo + per-outlet state.
  const { data: plans } = await supabase
    .from('route_plans')
    .select('id, vehicle_type, route_plan_outlets(id, store_id, visit_order, status, checkin_at, stores(lat, lng))')
    .eq('user_id', planUserId)
    .eq('plan_date', date);

  // 2. Resolve the start point.
  let start: GeoPoint | undefined = opts.start;
  let startSource: StartSource = 'explicit';
  if (!start) {
    const { data: u } = await supabase
      .from('users')
      .select('last_latitude, last_longitude, base_lat, base_lng')
      .eq('id', planUserId)
      .maybeSingle();
    if (u && typeof u.last_latitude === 'number' && typeof u.last_longitude === 'number') {
      start = { lat: u.last_latitude, lng: u.last_longitude };
      startSource = 'live_location';
    } else if (u && typeof u.base_lat === 'number' && typeof u.base_lng === 'number') {
      start = { lat: u.base_lat, lng: u.base_lng };
      startSource = 'base_location';
    } else {
      startSource = 'first_outlet';
    }
  }

  // 3. Priority signal: outlet_visit_frequency by store (cadence + priority).
  const { data: freqRows } = await supabase
    .from('outlet_visit_frequency')
    .select('store_id, frequency, priority, last_visited_at, is_active')
    .eq('org_id', orgId);
  const freqByStore = new Map<string, any>();
  (freqRows || []).forEach((f: any) => { if (f.is_active !== false) freqByStore.set(f.store_id, f); });

  const now = Date.now();
  const isOverdue = (f: any): boolean => {
    if (!f) return false;
    const days = FREQUENCY_DAYS[(f.frequency || '').toLowerCase()];
    if (days == null) return false;
    if (!f.last_visited_at) return true; // has a cadence but never visited → overdue
    return (now - new Date(f.last_visited_at).getTime()) / 86_400_000 >= days;
  };

  // 4. Per plan: tier by priority, optimize each tier from the running cursor.
  const planSuggestions: PlanSuggestion[] = [];
  const allStops: GeoPoint[] = [];

  for (const plan of (plans || []) as any[]) {
    const rows = (plan.route_plan_outlets || [])
      .map((o: any) => {
        const s = Array.isArray(o.stores) ? o.stores[0] : o.stores;
        return {
          id: String(o.id),
          store_id: o.store_id as string,
          visit_order: Number(o.visit_order) || 0,
          status: o.status as string | null,
          checkin_at: o.checkin_at as string | null,
          lat: s?.lat,
          lng: s?.lng,
        };
      })
      .filter((o: any) => typeof o.lat === 'number' && typeof o.lng === 'number');

    const usable = remainingOnly ? rows.filter((o: any) => !isDoneOutlet(o)) : rows;
    const vt = plan.vehicle_type || DEFAULT_VEHICLE_TYPE;

    if (usable.length === 0) {
      planSuggestions.push({ plan_id: plan.id, vehicle_type: vt, ordered: [], original_km: 0, optimized_km: 0, saved_km: 0, saved_co2_kg: 0 });
      continue;
    }

    // Effective start for this plan: the resolved start, else the first stop.
    const planStart: GeoPoint = start ?? { lat: usable[0].lat, lng: usable[0].lng };

    const byId = new Map<string, any>(usable.map((o: any) => [o.id, o]));
    const reason = new Map<string, 'overdue' | 'high_priority' | null>();
    const tierA: OutletPoint[] = [];
    const tierB: OutletPoint[] = [];
    for (const o of usable) {
      const f = freqByStore.get(o.store_id);
      const overdue = isOverdue(f);
      const high = (f?.priority || '').toLowerCase() === 'high';
      const pt: OutletPoint = { id: o.id, lat: o.lat, lng: o.lng };
      if (overdue || high) { tierA.push(pt); reason.set(o.id, overdue ? 'overdue' : 'high_priority'); }
      else { tierB.push(pt); reason.set(o.id, null); }
    }

    // Optimize the priority tier from the start, then the rest from where the
    // priority tier ends (so the whole path stays continuous).
    const resA = tierA.length ? await optimizeRoute(orgId, vt, planStart, tierA) : null;
    const orderedAIds = resA?.ordered ?? [];
    const lastA = orderedAIds.length ? byId.get(orderedAIds[orderedAIds.length - 1]) : null;
    const startB: GeoPoint = lastA ? { lat: lastA.lat, lng: lastA.lng } : planStart;
    const resB = tierB.length ? await optimizeRoute(orgId, vt, startB, tierB) : null;
    const orderedBIds = resB?.ordered ?? [];

    const combinedIds = [...orderedAIds, ...orderedBIds];
    const orderedOutlets: SuggestedOutlet[] = combinedIds.map((id, i) => {
      const o = byId.get(id);
      return { outlet_id: id, store_id: o.store_id, visit_order: i + 1, priority_reason: reason.get(id) ?? null, lat: o.lat, lng: o.lng };
    });

    // Distances: original = existing visit_order sequence; optimized = new order.
    const originalPts = usable.slice().sort((a: any, b: any) => a.visit_order - b.visit_order).map((o: any) => ({ lat: o.lat, lng: o.lng }));
    const optimizedPts = orderedOutlets.map((o) => ({ lat: o.lat, lng: o.lng }));
    const originalKm = pathKm(planStart, originalPts);
    const optimizedKm = pathKm(planStart, optimizedPts);
    const savedKm = Math.max(0, originalKm - optimizedKm);
    const factor = await resolveFactor(orgId, normalizeVehicleType(vt));

    orderedOutlets.forEach((o) => allStops.push({ lat: o.lat, lng: o.lng }));

    planSuggestions.push({
      plan_id: plan.id,
      vehicle_type: vt,
      ordered: orderedOutlets,
      original_km: round(originalKm, 2),
      optimized_km: round(optimizedKm, 2),
      saved_km: round(savedKm, 2),
      saved_co2_kg: round(savedKm * factor, 3),
    });
  }

  // 5. Nearby open leads owned by the rep, near any planned stop (or the start).
  let nearbyLeads: NearbyLead[] = [];
  if (includeNearbyLeads) {
    const anchors: GeoPoint[] = allStops.length ? allStops : (start ? [start] : []);
    if (anchors.length) {
      const { data: leads } = await supabase
        .from('crm_leads')
        .select('id, first_name, last_name, company, status, score, city, latitude, longitude')
        .eq('org_id', orgId)
        .eq('owner_id', planUserId)
        .is('deleted_at', null)
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .limit(500);
      nearbyLeads = ((leads || []) as any[])
        .filter((l) => l.is_converted !== true && OPEN_LEAD_STATUSES.has((l.status || '').toLowerCase()))
        .map((l) => {
          const p = { lat: Number(l.latitude), lng: Number(l.longitude) };
          let best = Infinity;
          for (const a of anchors) { const d = haversineKm(a, p); if (d < best) best = d; }
          const name = `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.company || 'Lead';
          return { id: l.id as string, name, lat: p.lat, lng: p.lng, distance_km: round(best, 2), score: l.score ?? null, status: l.status ?? null, city: l.city ?? null };
        })
        .filter((l) => l.distance_km <= radiusKm)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.distance_km - b.distance_km)
        .slice(0, nearbyLimit);
    }
  }

  const totalSaved = round(planSuggestions.reduce((s, p) => s + p.saved_km, 0), 2);
  return {
    date,
    start_source: startSource,
    start: start ?? null,
    plans: planSuggestions,
    total_saved_km: totalSaved,
    nearby_leads: nearbyLeads,
  };
}
