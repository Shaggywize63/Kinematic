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

/**
 * Stationary-jitter floor. A consumer GPS fix is only accurate to ~5–40 m, so two *distinct* fixes
 * taken minutes apart while the rep stood still differ by that much — pure noise, not travel. At the
 * field ping cadence (~10 min) any real movement between two fixes is hundreds of metres to km, so a
 * sub-floor hop spread over a non-trivial gap is jitter and must NOT accumulate: a day of waiting at
 * one outlet was adding a fake kilometre or two. We drop the hop's distance only when BOTH hold — the
 * hop is below [MIN_MOVE_KM] AND the two fixes are at least [JITTER_MIN_GAP_MIN] apart — so a DENSE
 * real trail (consecutive fixes seconds apart, each a short but genuine step of a drive) is untouched,
 * and so is every hop long enough to be real movement. Dropping jitter only ever lowers the total, so
 * the expense-mileage suggestion stays conservative (never over-reimburses).
 */
export const MIN_MOVE_KM = 0.05;        // 50 m — below this, over a real gap, is GPS noise not travel
export const JITTER_MIN_GAP_MIN = 1.5;  // only treat a sub-floor hop as jitter once fixes are this far apart in time

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
  /** Segments dropped as stationary GPS jitter (sub-floor move over a real time gap). */
  segments_stationary: number;
}

export interface SumTrailOptions {
  /**
   * Longest gap (minutes) between two consecutive fixes that still counts as one
   * driven segment. The default (`MAX_GAP_MIN`) is tuned for ~10-min field cadence
   * and is what the expense-mileage suggestion uses — a longer gap there means the
   * device stopped reporting, so the segment is not counted (conservative: never
   * over-reimburse). The daily travel report passes `Infinity` instead: on a sparse
   * trail (fixes far apart in time) the straight line between two real,
   * plausible-speed fixes is a sound LOWER bound on the distance travelled, and
   * dropping it to zero made the report read ~0 km for trips the map clearly draws.
   * The single-hop (`MAX_SEGMENT_KM`) and speed (`MAX_SPEED_KMH`) guards still reject
   * teleports and bad fixes regardless of this value, so relaxing the gap can only
   * move the total up toward the truth, never above the trail's polyline length.
   */
  maxGapMin?: number;
  /**
   * Stationary-jitter floor in km (default [MIN_MOVE_KM]). A hop shorter than this,
   * spread over at least [JITTER_MIN_GAP_MIN], is treated as GPS noise and dropped.
   * Pass `0` to disable (e.g. for a deliberately dense trail where short real steps
   * matter). See [MIN_MOVE_KM].
   */
  minMoveKm?: number;
}

/** Sum the haversine distance over consecutive fixes (in the order given — callers sort by time). */
export function sumTrailKm(pts: ReadonlyArray<TrailFix>, opts: SumTrailOptions = {}): TrailSum {
  const maxGapMin = opts.maxGapMin ?? MAX_GAP_MIN;
  const minMoveKm = opts.minMoveKm ?? MIN_MOVE_KM;
  let dist = 0, used = 0, excluded = 0, skipped = 0, counted = 0, stationary = 0;
  let prev: TrailFix | null = null;
  for (const p of pts) {
    if (p.is_mock || p.is_suspect) { excluded++; continue; }
    if (prev) {
      const seg = haversineKm(Number(prev.lat), Number(prev.lng), Number(p.lat), Number(p.lng));
      const dtMin = (new Date(p.captured_at).getTime() - new Date(prev.captured_at).getTime()) / 60_000;
      const speed = dtMin > 0 ? seg / (dtMin / 60) : Infinity;
      if (dtMin > 0 && dtMin <= maxGapMin && seg <= MAX_SEGMENT_KM && speed <= MAX_SPEED_KMH) {
        // Stationary GPS jitter: a sub-floor move spread over a real gap is noise, not travel.
        // Dense real trails (fixes < JITTER_MIN_GAP_MIN apart) keep their short, genuine steps.
        if (seg < minMoveKm && dtMin >= JITTER_MIN_GAP_MIN) {
          stationary++;
        } else {
          dist += seg;
          counted++;
        }
      } else {
        skipped++;
      }
    }
    prev = p;
    used++;
  }
  return { km: dist, points_used: used, points_excluded: excluded, segments_counted: counted, segments_skipped: skipped, segments_stationary: stationary };
}
