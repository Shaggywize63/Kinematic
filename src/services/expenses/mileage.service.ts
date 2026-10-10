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
import { sumTrailKm } from './trail';

// The segment guards (gap / hop / speed) and the haversine live in ./trail so the day-travel
// service sums a trail with exactly the same rules.

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

  const sum = sumTrailKm((data as any[]) || []);
  return {
    distance_km: Math.round(sum.km * 100) / 100,
    points_used: sum.points_used, points_excluded: sum.points_excluded, segments_skipped: sum.segments_skipped,
    from: fromISO, to: toISO,
  };
}
