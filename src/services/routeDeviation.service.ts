/**
 * Route-deviation alerts (module: route_deviation).
 *
 * A visit is "off-route" when the rep checked in further from the planned
 * outlet than its geofence allowed (checkin_distance_m > geofence_radius_m —
 * both persisted at check-in, so this is exact). This scan finds recent
 * off-route visits that haven't been alerted yet, notifies the rep's supervisor
 * (notifications row → FCM/APNs via the push-dispatch cron), and stamps
 * deviation_alerted_at so a rerun never double-notifies.
 *
 * Strictly opt-in: only clients that have been GRANTED the route_deviation
 * module (via v_client_enabled_modules — which excludes universal/expired) are
 * scanned. With no grants the scan is a no-op, so production is unchanged until
 * a client is switched on at onboarding.
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';

async function supervisorOf(user_id: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('users').select('supervisor_id').eq('id', user_id).maybeSingle();
  return (data as any)?.supervisor_id ?? null;
}

export async function runRouteDeviationScan(opts: { lookbackHours?: number } = {}): Promise<{ clients: number; scanned: number; alerts: number }> {
  const lookbackHours = Math.min(240, Math.max(1, opts.lookbackHours ?? 24));

  // 1. Clients explicitly granted the module (off by default → usually empty).
  const { data: grants } = await supabaseAdmin
    .from('v_client_enabled_modules')
    .select('client_id')
    .eq('module_id', 'route_deviation');
  const clientIds = Array.from(new Set((grants || []).map((g: any) => g.client_id).filter(Boolean)));
  if (!clientIds.length) return { clients: 0, scanned: 0, alerts: 0 };

  const sinceIso = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();

  // 2. Recent, not-yet-alerted check-ins for those clients' plans.
  const { data: outlets, error } = await supabaseAdmin
    .from('route_plan_outlets')
    .select('id, checkin_at, checkin_distance_m, geofence_radius_m, stores(name), route_plans!inner(user_id, org_id, client_id, territory_label)')
    .in('route_plans.client_id', clientIds)
    .gte('checkin_at', sinceIso)
    .not('checkin_at', 'is', null)
    .not('checkin_distance_m', 'is', null)
    .is('deviation_alerted_at', null);
  if (error) { logger.warn(`[route-deviation] scan query failed: ${error.message}`); return { clients: clientIds.length, scanned: 0, alerts: 0 }; }

  const rows = (outlets || []) as any[];
  // Cache rep names to avoid a lookup per row.
  const repNames = new Map<string, string>();
  let alerts = 0;

  for (const o of rows) {
    const rp = Array.isArray(o.route_plans) ? o.route_plans[0] : o.route_plans;
    const store = Array.isArray(o.stores) ? o.stores[0] : o.stores;
    const geofence = Number(o.geofence_radius_m) || 100;
    const dist = Number(o.checkin_distance_m) || 0;
    if (dist <= geofence) continue; // in-geofence → not a deviation

    let repName = repNames.get(rp.user_id);
    if (repName === undefined) {
      const { data: rep } = await supabaseAdmin.from('users').select('name').eq('id', rp.user_id).maybeSingle();
      repName = (rep as any)?.name || 'A rep';
      repNames.set(rp.user_id, repName);
    }

    const supervisor = await supervisorOf(rp.user_id);
    if (supervisor) {
      try {
        await supabaseAdmin.from('notifications').insert({
          org_id: rp.org_id,
          user_id: supervisor,
          type: 'route_deviation',
          title: 'Off-route visit',
          body: `${repName} checked in ${(dist / 1000).toFixed(2)} km from ${store?.name || 'a planned outlet'}${rp.territory_label ? ` (${rp.territory_label})` : ''}.`,
          data: { type: 'route_deviation', outlet_id: String(o.id), distance_m: String(Math.round(dist)) },
        });
      } catch (e: any) {
        logger.warn(`[route-deviation] notify failed for outlet ${o.id}: ${e?.message || e}`);
      }
    }
    // Mark alerted even if there's no supervisor, so we don't re-scan it forever.
    await supabaseAdmin.from('route_plan_outlets').update({ deviation_alerted_at: new Date().toISOString() }).eq('id', o.id);
    alerts++;
  }

  logger.info(`[route-deviation] scan: ${clientIds.length} client(s), ${rows.length} checked, ${alerts} alert(s)`);
  return { clients: clientIds.length, scanned: rows.length, alerts };
}
