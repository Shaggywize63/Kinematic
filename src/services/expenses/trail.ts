/**
 * Pure GPS-trail maths shared by the expense mileage suggestion (mileage.service.ts) and the
 * day-travel service (services/travel.service.ts). No I/O: callers pass the fixes in.
 *
 * A segment (the leg between two consecutive fixes) only counts as real driven distance when ALL
 * of these hold — otherwise the trail is lost and the segment is skipped rather than fabricated:
 *   - neither end is a spoof/suspect fix (mock-location detector) — such a fix is excluded outright;
 *   - the time gap is > 0 and ≤ MAX_GAP_MIN (a longer gap means the device stopped reporting);
 *   - the single hop is ≤ MAX_SEGMENT_KM (a farther consecutive fix is a jump/bad fix);
 *   - the implied speed is ≤ MAX_SPEED_KMH.
 *
 * Validated against real seeded trails: without the gap/hop guards a noisy day summed to thousands
 * of km; with them the same days land at realistic 8–25 km.
 */

const EARTH_KM = 6371;
export const MAX_SPEED_KMH = 150;   // faster than this between two fixes = teleport, not a drive
export const MAX_GAP_MIN = 15;      // gap beyond this = lost trail; don't infer distance across it
export const MAX_SEGMENT_KM = 20;   // a single consecutive-fix hop beyond this is a jump/bad fix

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** One location fix. `captured_at` may be an ISO string, epoch ms or a Date. */
export interface TrailFix {
  lat: unknown;
  lng: unknown;
  captured_at: string | number | Date;
  is_mock?: boolean | null;
  is_suspect?: boolean | null;
}

export interface TrailSum {
  /** Unrounded kilometres over the counted segments. */
  km: number;
  /** Valid (non-spoof) fixes considered. */
  points_used: number;
  /** Spoof/suspect fixes skipped. */
  points_excluded: number;
  /** Segments that counted toward `km`. */
  segments_counted: number;
  /** Segments dropped as a gap / jump / teleport (trail lost between the two fixes). */
  segments_skipped: number;
}

/** Sum the haversine distance over consecutive fixes (in the order given — callers sort by time). */
export function sumTrailKm(pts: ReadonlyArray<TrailFix>): TrailSum {
  let dist = 0, used = 0, excluded = 0, skipped = 0, counted = 0;
  let prev: TrailFix | null = null;
  for (const p of pts) {
    if (p.is_mock || p.is_suspect) { excluded++; continue; }
    if (prev) {
      const seg = haversineKm(Number(prev.lat), Number(prev.lng), Number(p.lat), Number(p.lng));
      const dtMin = (new Date(p.captured_at).getTime() - new Date(prev.captured_at).getTime()) / 60_000;
      const speed = dtMin > 0 ? seg / (dtMin / 60) : Infinity;
      if (dtMin > 0 && dtMin <= MAX_GAP_MIN && seg <= MAX_SEGMENT_KM && speed <= MAX_SPEED_KMH) {
        dist += seg;
        counted++;
      } else {
        skipped++;
      }
    }
    prev = p;
    used++;
  }
  return { km: dist, points_used: used, points_excluded: excluded, segments_counted: counted, segments_skipped: skipped };
}
