/**
 * Tidies a day's location trail before it is sent to the dashboard.
 *
 * Phones running an older Android build registered one more location listener on every app open /
 * login / check-in, so a single fix was sent 10+ times in the same second. Those rows are already in
 * work_activity (Rajkamal: one rep had 2,471 heartbeats today but only 169 distinct seconds and 24
 * distinct coordinates). The heartbeat guard now stops new ones; this stops the old ones from reaching
 * the Live Trailing map, which draws a marker per ping and froze the browser tab.
 *
 *  - A HEARTBEAT that repeats the previous kept HEARTBEAT's exact fix within DUPLICATE_WINDOW_MS is
 *    dropped (same rule as the write-side guard). A rep who stays put still gets a point every window,
 *    and a rep who moved is never touched.
 *  - CHECK_IN / CHECK_OUT / FORM_SUBMIT rows are attendance and visit evidence — always kept.
 *  - 0,0 ("no fix") is not a position; drawing it would pull the map to the Gulf of Guinea.
 */
import { DUPLICATE_WINDOW_MS, isNullIsland } from './heartbeatGuard';

export interface TrailRow {
  lat: number | null;
  lng: number | null;
  captured_at: string;
  activity_type?: string | null;
}

/** `rows` must be ordered by captured_at ascending (the controller's query is). Input is not mutated. */
export function collapseDuplicatePings<T extends TrailRow>(rows: T[]): T[] {
  const out: T[] = [];
  let anchor: { at: number; lat: number; lng: number } | null = null;
  for (const r of rows) {
    const lat = Number(r.lat);
    const lng = Number(r.lng);
    if (r.lat == null || r.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || isNullIsland(lat, lng)) continue;
    if (r.activity_type === 'HEARTBEAT') {
      const at = Date.parse(r.captured_at);
      if (anchor && at - anchor.at < DUPLICATE_WINDOW_MS && lat === anchor.lat && lng === anchor.lng) continue;
      // A duplicate never moves the anchor, so a stuck phone still yields one point per window.
      anchor = { at, lat, lng };
    }
    out.push(r);
  }
  return out;
}
