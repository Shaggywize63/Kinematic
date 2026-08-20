/**
 * Auto-mileage from the rep's GPS trail (work_activity). Sums the haversine
 * distance between consecutive location fixes for a user over a time window.
 * This is the odometer the rep never has to read.
 *
 * A segment (the leg between two consecutive fixes) only counts as real driven
 * distance when ALL of these hold — otherwise we've lost the trail and honestly
 * skip the leg rather than fabricate distance across a gap:
 *   - the earlier fix is not a spoof/suspect fix (mock-location detector);
 *   - the time gap is ≤ MAX_GAP_MIN — a longer gap means the device stopped
 *     reporting (app killed, no signal) and we can't know the route taken;
 *   - the single hop is ≤ MAX_SEGMENT_KM — at field cadence (~10 min) a
 *     consecutive fix that far apart is a jump/bad fix, not a drive;
 *   - the implied speed is ≤ MAX_SPEED_KMH.
 *
 * Validated against real seeded trails: without the gap/hop guards a noisy day
 * summed to thousands of km (far-flung fixes whose wide time gaps kept implied
 * speed under the limit); with them the same days land at realistic 8–25 km.
 */
import { supabaseAdmin } from '../../lib/supabase';

const EARTH_KM = 6371;
const MAX_SPEED_KMH = 150;   // faster than this between two fixes = teleport, not a drive
const MAX_GAP_MIN = 15;      // gap beyond this = lost trail; don't infer distance across it
const MAX_SEGMENT_KM = 20;   // a single consecutive-fix hop beyond this is a jump/bad fix

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface MileageResult {
  distance_km: number;
  points_used: number;       // valid (non-spoof) fixes considered
  points_excluded: number;   // spoof/suspect fixes skipped
  segments_skipped: number;  // legs dropped as a gap/jump (trail lost between them)
  from: string;
  to: string;
}

export async function mileageFromTrail(orgId: string, userId: string, fromISO: string, toISO: string): Promise<MileageResult> {
  const { data } = await supabaseAdmin.from('work_activity')
    .select('lat,lng,captured_at,is_mock,is_suspect')
    .eq('org_id', orgId).eq('user_id', userId)
    .gte('captured_at', fromISO).lte('captured_at', toISO)
    .not('lat', 'is', null).not('lng', 'is', null)
    .order('captured_at', { ascending: true })
    .limit(10000);

  const pts = (data as any[]) || [];
  let dist = 0, used = 0, excluded = 0, skipped = 0;
  let prev: any = null;
  for (const p of pts) {
    if (p.is_mock || p.is_suspect) { excluded++; continue; }
    if (prev) {
      const seg = haversineKm(Number(prev.lat), Number(prev.lng), Number(p.lat), Number(p.lng));
      const dtMin = (new Date(p.captured_at).getTime() - new Date(prev.captured_at).getTime()) / 60_000;
      const speed = dtMin > 0 ? seg / (dtMin / 60) : Infinity;
      if (dtMin > 0 && dtMin <= MAX_GAP_MIN && seg <= MAX_SEGMENT_KM && speed <= MAX_SPEED_KMH) {
        dist += seg;
      } else {
        skipped++;
      }
    }
    prev = p;
    used++;
  }
  return {
    distance_km: Math.round(dist * 100) / 100,
    points_used: used, points_excluded: excluded, segments_skipped: skipped,
    from: fromISO, to: toISO,
  };
}
