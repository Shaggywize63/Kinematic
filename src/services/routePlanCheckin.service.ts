import { supabaseAdmin } from '../lib/supabase';
import { haversineDistance } from '../lib/haversine';
import { dbToday } from '../utils';

/**
 * Mirror a field check-in onto the rep's matching planned route outlet so the
 * route_deviation feature has data to work with.
 *
 * Why this exists: mobile check-ins land in `visit_logs` (iOS `POST /visits`)
 * or `form_submissions` (Android form submit) — never in `route_plan_outlets`,
 * which is the ONE table the deviation scan / report / web view read
 * (`checkin_distance_m > geofence_radius_m` ⇒ off-route). So a rep can check in
 * all day and the Route Deviations view stays empty. This links the two: when a
 * check-in matches a planned outlet for the rep today, we copy the check-in onto
 * that outlet row and record how far the rep was from it (`checkin_distance_m`),
 * which is exactly what the deviation logic compares against the geofence.
 *
 * Best-effort and idempotent: it no-ops when there is no plan/outlet match or
 * the outlet is already checked in, and it NEVER throws into the caller — a
 * check-in must not fail because this mirror did.
 */
export async function mirrorCheckinToRoutePlan(params: {
  userId: string;
  storeId?: string | null;
  lat?: number | null;
  lng?: number | null;
}): Promise<void> {
  try {
    const { userId, storeId } = params;
    const lat = Number(params.lat);
    const lng = Number(params.lng);
    if (!userId || !storeId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    // The rep's route plan for today (IST). One plan per rep per day; take the
    // most recent if a tenant ever has more.
    const { data: plan } = await supabaseAdmin
      .from('route_plans')
      .select('id')
      .eq('user_id', userId)
      .eq('plan_date', dbToday())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!plan?.id) return;

    // The planned stop for this outlet that isn't already checked in — so a
    // second visit to the same outlet doesn't overwrite the first check-in.
    const { data: rpo } = await supabaseAdmin
      .from('route_plan_outlets')
      .select('id, stores(lat, lng)')
      .eq('route_plan_id', plan.id)
      .eq('store_id', storeId)
      .is('checkin_at', null)
      .limit(1)
      .maybeSingle();
    if (!rpo?.id) return;

    const store: any = Array.isArray((rpo as any).stores) ? (rpo as any).stores[0] : (rpo as any).stores;
    const sLat = Number(store?.lat);
    const sLng = Number(store?.lng);
    const distance = Number.isFinite(sLat) && Number.isFinite(sLng)
      ? Math.round(haversineDistance(lat, lng, sLat, sLng))
      : null;

    await supabaseAdmin
      .from('route_plan_outlets')
      .update({
        checkin_at: new Date().toISOString(),
        checkin_lat: lat,
        checkin_lng: lng,
        checkin_distance_m: distance,
      })
      .eq('id', rpo.id);
  } catch (e) {
    // Best-effort: never surface a mirror failure to the check-in caller.
    console.error('[route-plan check-in mirror] failed:', e);
  }
}
