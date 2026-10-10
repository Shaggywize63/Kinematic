/**
 * Halt detection — PURE logic, no I/O. Turns a person's time-ordered location pings into the places
 * they STOPPED, with how long. Used by the day-travel service (travel.service.ts), which feeds it the
 * shift's usable pings and reports the result as `halts`.
 *
 * Definition.
 *   - A RUN is a stretch of consecutive pings that all stay within HALT_RADIUS_M (100 m) of the run's
 *     FIRST ping. A run ends at the first ping that is farther away, and also whenever two consecutive
 *     pings are more than HALT_MAX_GAP_MS (20 min) apart — no data is not a halt, so a phone that went
 *     quiet never "stops" for hours. The ping that ended a run starts the next one.
 *   - A run needs at least two pings to have a duration. Two such runs at the same place (centroids
 *     within 100 m) that are separated by less than HALT_MERGE_GAP_MS (5 min) MERGE into one stop: a
 *     single drifting fix or a short stroll outside must not split one stop in two. Whatever pings sit
 *     in that short separation (a drifted fix, the stroll) are absorbed into the merge.
 *   - A merged run is a HALT when its first-to-last ping span is at least `minMinutes`
 *     (default 10, clamped 3..120).
 *   - A halt whose time range lies more than 50 % inside customer visits (form check-in..check-out) is
 *     dropped: that time is already reported as the visit. Visits that overlap each other count once.
 *
 * Notes on the choices the definition leaves open:
 *   - A halt's `start_at` / `end_at` are its first and last ping (not "when the phone started to rest"):
 *     the server only knows what the pings say. `minutes` is the rounded span.
 *   - lat/lng is the centroid (mean) of the halt's pings; `points` is how many pings that is. Pings
 *     absorbed by a merge (see above) are inside the time range but are not counted or averaged.
 *   - Merging looks only at the 5 minutes right before a run begins, so it can absorb a short blip run
 *     in between, never an earlier halt that ended more than 5 minutes before.
 *   - Callers decide which pings are usable (not mock / suspect, inside the shift window); this module
 *     only sorts and reads `ms`, `lat`, `lng`. No geocoding: a place name is the client's job.
 */
import { haversineKm } from './expenses/trail';

/** Pings farther than this from the run's first ping end the run. */
export const HALT_RADIUS_M = 100;
/** A run that goes this long without a ping ends (no data = no halt). */
export const HALT_MAX_GAP_MS = 20 * 60_000;
/** Two runs at the same place closer together than this are one stop. */
export const HALT_MERGE_GAP_MS = 5 * 60_000;
/** A halt more than this share inside visits is suppressed. */
export const HALT_VISIT_OVERLAP_SHARE = 0.5;

export const HALT_MIN_MINUTES_DEFAULT = 10;
export const HALT_MIN_MINUTES_MIN = 3;
export const HALT_MIN_MINUTES_MAX = 120;

/** One location ping. */
export interface HaltPing {
  /** Epoch ms. */
  ms: number;
  lat: number;
  lng: number;
}

/** A customer visit's time span (epoch ms). */
export interface HaltVisitSpan {
  inMs: number;
  outMs: number;
}

export interface Halt {
  index: number;
  start_at: string;
  end_at: string;
  minutes: number;
  /** Centroid of the halt's pings. */
  lat: number;
  lng: number;
  points: number;
}

export interface DetectHaltsOptions {
  /** Minimum first-to-last span, in minutes. Out-of-range values are clamped to 3..120; default 10. */
  minMinutes?: number;
}

/** A requested minimum, as a whole number of minutes inside 3..120 (default 10 for anything unusable). */
export function clampMinHaltMinutes(v: unknown): number {
  const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return HALT_MIN_MINUTES_DEFAULT;
  return Math.min(HALT_MIN_MINUTES_MAX, Math.max(HALT_MIN_MINUTES_MIN, Math.round(n)));
}

const distM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number =>
  haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

interface Candidate {
  pings: HaltPing[];
  firstMs: number;
  lastMs: number;
  lat: number;
  lng: number;
}

function candidateOf(pings: HaltPing[]): Candidate {
  let lat = 0;
  let lng = 0;
  for (const p of pings) { lat += p.lat; lng += p.lng; }
  return { pings, firstMs: pings[0].ms, lastMs: pings[pings.length - 1].ms, lat: lat / pings.length, lng: lng / pings.length };
}

/**
 * Drop an isolated stray fix: a ping that is outside HALT_RADIUS_M of BOTH its neighbours while those two are
 * within HALT_RADIUS_M of each other (and no more than HALT_MAX_GAP_MS apart, so dropping it opens no hole the
 * gap rule would refuse). One drifted GPS fix then no longer cuts a long stay in two - with 10-minute
 * heartbeats that cut used to leave a 20-minute hole between the halves. Only isolated single fixes go: a
 * real move (two or more pings away) is never touched, so nothing is hidden between two stays.
 */
function dropStrayFixes(pings: HaltPing[]): HaltPing[] {
  const kept: HaltPing[] = [];
  for (let i = 0; i < pings.length; i++) {
    const prev = kept[kept.length - 1];
    const cur = pings[i];
    const next = pings[i + 1];
    if (prev && next
      && next.ms - prev.ms <= HALT_MAX_GAP_MS
      && distM(prev, next) <= HALT_RADIUS_M
      && distM(prev, cur) > HALT_RADIUS_M
      && distM(cur, next) > HALT_RADIUS_M) continue;
    kept.push(cur);
  }
  return kept;
}

/** Consecutive runs within HALT_RADIUS_M of their first ping, cut at gaps over HALT_MAX_GAP_MS. */
function splitRuns(pings: HaltPing[]): HaltPing[][] {
  const runs: HaltPing[][] = [];
  let i = 0;
  while (i < pings.length) {
    const first = pings[i];
    let j = i + 1;
    while (j < pings.length && pings[j].ms - pings[j - 1].ms <= HALT_MAX_GAP_MS && distM(first, pings[j]) <= HALT_RADIUS_M) j++;
    runs.push(pings.slice(i, j));
    i = j;
  }
  return runs;
}

/** Total length of `[start, end]` that lies inside the union of `spans`. */
function overlapMs(start: number, end: number, spans: ReadonlyArray<HaltVisitSpan>): number {
  const clipped = spans
    .map((s) => ({ a: Math.max(start, Math.min(s.inMs, s.outMs)), b: Math.min(end, Math.max(s.inMs, s.outMs)) }))
    .filter((s) => s.b > s.a)
    .sort((x, y) => x.a - y.a);
  let total = 0;
  let curA = 0;
  let curB = -Infinity;
  for (const s of clipped) {
    if (s.a > curB) {
      if (curB > curA) total += curB - curA;
      curA = s.a;
      curB = s.b;
    } else if (s.b > curB) {
      curB = s.b;
    }
  }
  if (curB > curA) total += curB - curA;
  return total;
}

/**
 * The halts in `pings` (any order; non-finite entries are ignored). `visits` are the customer visits
 * of the same period — halts that are mostly inside one are left out. Index is the halt's position in
 * time order after suppression.
 */
export function detectHalts(
  pings: ReadonlyArray<HaltPing>,
  visits: ReadonlyArray<HaltVisitSpan> = [],
  opts: DetectHaltsOptions = {},
): Halt[] {
  const minMs = clampMinHaltMinutes(opts.minMinutes) * 60_000;
  const sorted = pings
    .filter((p) => p && Number.isFinite(p.ms) && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .sort((a, b) => a.ms - b.ms);
  if (sorted.length < 2) return [];

  // Runs with at least two pings are the only ones that can have a duration.
  const stationary = splitRuns(dropStrayFixes(sorted)).filter((r) => r.length >= 2).map(candidateOf);

  // Merge a run into an earlier one at the same place that ended less than HALT_MERGE_GAP_MS before it began.
  const merged: Candidate[] = [];
  for (const run of stationary) {
    let into = -1;
    for (let k = merged.length - 1; k >= 0; k--) {
      if (run.firstMs - merged[k].lastMs >= HALT_MERGE_GAP_MS) break;     // sorted: earlier ones are even farther back
      if (distM(merged[k], run) <= HALT_RADIUS_M) { into = k; break; }
    }
    if (into < 0) { merged.push(run); continue; }
    const combined = candidateOf([...merged[into].pings, ...run.pings]);
    merged.length = into;                                                  // drops the blips absorbed in between
    merged.push(combined);
  }

  const halts: Halt[] = [];
  for (const c of merged) {
    const span = c.lastMs - c.firstMs;
    if (span < minMs) continue;
    if (overlapMs(c.firstMs, c.lastMs, visits) / span > HALT_VISIT_OVERLAP_SHARE) continue;
    halts.push({
      index: halts.length,
      start_at: new Date(c.firstMs).toISOString(),
      end_at: new Date(c.lastMs).toISOString(),
      minutes: Math.round(span / 60_000),
      lat: round6(c.lat),
      lng: round6(c.lng),
      points: c.pings.length,
    });
  }
  return halts;
}
