/**
 * Which position the Live Trailing map should show for a rep, and WHERE it came
 * from — so the dashboard can say "Live GPS" vs "Check-in point" vs "Zone
 * meeting point (no GPS yet)" instead of drawing every pin as if it were the
 * rep's current location.
 *
 * Precedence (unchanged from the original inline logic):
 *   1. last heartbeat fix, if captured within the last 24h        → 'live'
 *   2. today's attendance check-in coordinates                    → 'checkin'
 *   3. the zone's meeting point                                   → 'zone'
 * Latitude and longitude fall through independently, as before; the source
 * follows whichever supplied the latitude.
 */
export type LocationSource = 'live' | 'checkin' | 'zone';

export interface LivePosition {
  lat: number | null;
  lng: number | null;
  /** Null when no position is known at all. */
  source: LocationSource | null;
  /** When the shown position was captured: the ping time for 'live', the
   *  check-in time for 'checkin', null for the zone fallback (not a capture). */
  captured_at: string | null;
}

export const LIVE_FIX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface LiveUser {
  last_latitude?: number | null;
  last_longitude?: number | null;
  last_location_updated_at?: string | null;
}
interface CheckinRec { checkin_lat?: number | null; checkin_lng?: number | null; checkin_at?: string | null }
interface Zone { meeting_lat?: number | null; meeting_lng?: number | null }

export function resolveLivePosition(
  user: LiveUser,
  rec?: CheckinRec | null,
  zone?: Zone | null,
  now: number = Date.now(),
): LivePosition {
  const hasLive = user.last_latitude != null && user.last_longitude != null
    && !!user.last_location_updated_at
    && now - new Date(user.last_location_updated_at).getTime() < LIVE_FIX_MAX_AGE_MS;

  const lat = hasLive ? user.last_latitude! : (rec?.checkin_lat ?? zone?.meeting_lat ?? null);
  const lng = hasLive ? user.last_longitude! : (rec?.checkin_lng ?? zone?.meeting_lng ?? null);

  let source: LocationSource | null = null;
  let captured_at: string | null = null;
  if (lat != null && lng != null) {
    if (hasLive) { source = 'live'; captured_at = user.last_location_updated_at ?? null; }
    else if (rec?.checkin_lat != null) { source = 'checkin'; captured_at = rec.checkin_at ?? null; }
    else { source = 'zone'; }
  }
  return { lat, lng, source, captured_at };
}
