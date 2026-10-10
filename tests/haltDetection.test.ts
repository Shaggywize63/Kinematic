/**
 * Halt detection (services/haltDetection.ts) — the PURE rules: a run of consecutive pings within 100 m of
 * its FIRST ping spanning >= the minimum (default 10 min, clamp 3..120); runs at the same place less than
 * 5 min apart merge; a gap over 20 min ends a run (no data = no halt); a halt more than 50 % inside
 * customer visits is dropped. No database, no clock: pings are built from minute offsets.
 */
import {
  detectHalts, clampMinHaltMinutes, HALT_RADIUS_M, HALT_MAX_GAP_MS, HALT_MERGE_GAP_MS,
  type HaltPing, type HaltVisitSpan,
} from '../src/services/haltDetection';
import { haversineKm } from '../src/services/expenses/trail';

const T0 = Date.parse('2026-10-09T05:00:00.000Z');
const BASE = { lat: 13.0, lng: 80.2 };
/** ~metres north of BASE (1 degree of latitude is ~111.2 km). */
const north = (metres: number) => BASE.lat + metres / 111_195;

/** A ping `min` minutes after T0, `metres` north of BASE. */
const p = (min: number, metres = 0, lngOffset = 0): HaltPing => ({ ms: T0 + min * 60_000, lat: north(metres), lng: BASE.lng + lngOffset });
const span = (fromMin: number, toMin: number): HaltVisitSpan => ({ inMs: T0 + fromMin * 60_000, outMs: T0 + toMin * 60_000 });
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

describe('the constants are the contract\'s', () => {
  it('100 m, 20 min gap, 5 min merge', () => {
    expect(HALT_RADIUS_M).toBe(100);
    expect(HALT_MAX_GAP_MS).toBe(20 * 60_000);
    expect(HALT_MERGE_GAP_MS).toBe(5 * 60_000);
  });
});

describe('clampMinHaltMinutes', () => {
  it.each([
    [undefined, 10], [null, 10], ['', 10], ['abc', 10], [NaN, 10], [{}, 10],
    ['5', 5], [5, 5], [3, 3], [1, 3], [0, 3], [-4, 3], [120, 120], [500, 120], ['9999', 120], [7.6, 8], ['12', 12],
  ])('%p -> %p', (input, expected) => {
    expect(clampMinHaltMinutes(input)).toBe(expected);
  });
});

describe('a halt: pings that stay within 100 m of the run\'s first ping', () => {
  it('reports one halt for a rep who stays put, with start, end, minutes, centroid and ping count', () => {
    const pings = [p(0, 0), p(5, 20), p(10, 40), p(15, 10), p(20, 30), p(25, 0), p(30, 20)];
    const halts = detectHalts(pings);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ index: 0, start_at: iso(0), end_at: iso(30), minutes: 30, points: 7 });
    const meanLat = pings.reduce((s, x) => s + x.lat, 0) / pings.length;
    expect(Math.abs(halts[0].lat - meanLat)).toBeLessThan(1e-6);
    expect(halts[0].lng).toBeCloseTo(BASE.lng, 6);
  });

  it('measures from the FIRST ping, not from the previous one: slow drift ends the run once 100 m away', () => {
    // 30 m per step: pings 0..3 are 0/30/60/90 m from the first; the 4th (120 m) is outside, even though only 30 m from its neighbour.
    const halts = detectHalts([p(0, 0), p(5, 30), p(10, 60), p(15, 90), p(20, 120), p(25, 5000)]);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ start_at: iso(0), end_at: iso(15), minutes: 15, points: 4 });
  });

  it('a ping 101 m away ends the run, 99 m does not', () => {
    expect(haversineKm(BASE.lat, BASE.lng, north(99), BASE.lng) * 1000).toBeLessThan(HALT_RADIUS_M);
    expect(haversineKm(BASE.lat, BASE.lng, north(101), BASE.lng) * 1000).toBeGreaterThan(HALT_RADIUS_M);
    expect(detectHalts([p(0, 0), p(5, 99), p(10, 0)])).toHaveLength(1);
    expect(detectHalts([p(0, 0), p(5, 101), p(10, 0)])).toHaveLength(0);
  });

  it('a rep who keeps moving never halts, however many pings', () => {
    const pings = Array.from({ length: 40 }, (_v, i) => p(i * 3, i * 400));
    expect(detectHalts(pings)).toEqual([]);
  });

  it('the ping that left the area starts the next run (two stops back to back are two halts)', () => {
    const pings = [p(0, 0), p(6, 10), p(12, 5), p(18, 300), p(24, 310), p(30, 305)];
    const halts = detectHalts(pings);
    expect(halts.map((h) => [h.start_at, h.end_at, h.minutes])).toEqual([[iso(0), iso(12), 12], [iso(18), iso(30), 12]]);
    expect(halts.map((h) => h.index)).toEqual([0, 1]);
  });

  it('a single ping, no pings, or non-finite pings are never a halt', () => {
    expect(detectHalts([])).toEqual([]);
    expect(detectHalts([p(0)])).toEqual([]);
    expect(detectHalts([p(0), { ms: NaN, lat: BASE.lat, lng: BASE.lng }, { ms: T0 + 60 * 60_000, lat: NaN, lng: BASE.lng }])).toEqual([]);
  });

  it('sorts its input and does not mutate it', () => {
    const pings = [p(10, 5), p(0, 0), p(20, 8), p(5, 3), p(15, 1)];
    const copy = pings.map((x) => ({ ...x }));
    const halts = detectHalts(pings);
    expect(pings).toEqual(copy);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ start_at: iso(0), end_at: iso(20), minutes: 20 });
  });
});

describe('the minimum duration', () => {
  it('defaults to 10 minutes between the first and last ping', () => {
    expect(detectHalts([p(0), p(3), p(6), p(9)])).toEqual([]);                   // 9 min
    expect(detectHalts([p(0), p(5), p(10)])).toHaveLength(1);                    // exactly 10 min
    expect(detectHalts([p(0), p(5), p(9.99)])).toHaveLength(0);
  });

  it('honours minMinutes, clamped to 3..120', () => {
    const four = [p(0), p(2), p(4)];                                             // 4 min
    expect(detectHalts(four)).toEqual([]);
    expect(detectHalts(four, [], { minMinutes: 3 })).toHaveLength(1);
    expect(detectHalts([p(0), p(1), p(2)], [], { minMinutes: 1 })).toEqual([]);   // 1 is clamped up to 3: a 2-minute pause is not a halt
    const long = [p(0), p(15), p(30), p(45), p(60), p(75), p(90), p(105)];       // 105 min
    expect(detectHalts(long, [], { minMinutes: 500 })).toEqual([]);              // clamped to 120
    expect(detectHalts([...long, p(120)], [], { minMinutes: 500 })).toHaveLength(1);
  });

  it('a single ping has no duration, whatever the minimum', () => {
    expect(detectHalts([p(0), p(60, 5000)], [], { minMinutes: 3 })).toEqual([]);
  });
});

describe('the gap rule: no data is not a halt', () => {
  it('a gap of exactly 20 minutes is still one run', () => {
    const halts = detectHalts([p(0), p(20), p(40)]);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ minutes: 40, points: 3 });
  });

  it('a gap over 20 minutes ends the run, even at the very same spot', () => {
    // 0,10,20 then silence until 41, then 50,60: two stops of 20 and 19 minutes - never one 60-minute halt.
    const halts = detectHalts([p(0), p(10), p(20), p(41), p(50), p(60)]);
    expect(halts.map((h) => [h.start_at, h.end_at, h.minutes])).toEqual([[iso(0), iso(20), 20], [iso(41), iso(60), 19]]);
  });

  it('two pings an hour apart at the same place are not a halt', () => {
    expect(detectHalts([p(0), p(60)])).toEqual([]);
  });

  it('a phone that went quiet after a short stop yields no long halt', () => {
    expect(detectHalts([p(0), p(5), p(10), p(90, 5000)])).toHaveLength(1);       // only the 10 minutes that were observed
  });
});

describe('merging runs at the same place less than 5 minutes apart', () => {
  it('a drifted fix in the middle of one stop does not split it (and is not counted)', () => {
    // at X 0,5,10 · one fix 200 m away at 12 · back at X 14,19,24
    const halts = detectHalts([p(0), p(5), p(10), p(12, 200), p(14), p(19), p(24)]);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ start_at: iso(0), end_at: iso(24), minutes: 24, points: 6 });
  });

  it('merges runs that are each shorter than the minimum when together they make one', () => {
    // 5 min at X, a stray fix, 8 more min at X: 14 minutes at the shop.
    const halts = detectHalts([p(0), p(1), p(2), p(3), p(4), p(5, 250), p(6), p(8), p(10), p(14)]);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ start_at: iso(0), end_at: iso(14), minutes: 14 });
  });

  it('does NOT merge when the separation is 5 minutes or more', () => {
    const halts = detectHalts([p(0), p(5), p(10), p(12, 200), p(15), p(20), p(25)]);
    expect(halts.map((h) => [h.start_at, h.end_at])).toEqual([[iso(0), iso(10)], [iso(15), iso(25)]]);
  });

  it('does NOT merge runs at different places, however close in time', () => {
    const halts = detectHalts([p(0), p(5), p(10), p(12, 300), p(17, 305), p(22, 300)]);
    expect(halts.map((h) => [h.start_at, h.end_at])).toEqual([[iso(0), iso(10)], [iso(12), iso(22)]]);
  });

  it('only looks back 5 minutes: it never swallows an earlier halt at the same place', () => {
    // X 0-12, then Y 14-30, then X again 33-45 (more than 5 min after the first X halt ended)
    const halts = detectHalts([p(0), p(6), p(12), p(14, 400), p(22, 405), p(30, 400), p(33), p(39), p(45)]);
    expect(halts.map((h) => [h.start_at, h.end_at])).toEqual([[iso(0), iso(12)], [iso(14), iso(30)], [iso(33), iso(45)]]);
  });
});

describe('visit suppression: time already reported as a customer visit is not also a halt', () => {
  const halt30 = [p(0), p(10), p(20), p(30)];                                    // one 30-minute halt

  it('drops a halt more than 50 % inside a visit', () => {
    expect(detectHalts(halt30, [span(10, 40)])).toEqual([]);                     // 20/30 inside
    expect(detectHalts(halt30, [span(-5, 35)])).toEqual([]);                     // all of it
  });

  it('keeps a halt that is exactly 50 % inside, or less', () => {
    expect(detectHalts(halt30, [span(15, 45)])).toHaveLength(1);                 // 15/30 = 50 %: not "more than"
    expect(detectHalts(halt30, [span(20, 60)])).toHaveLength(1);                 // 10/30
    expect(detectHalts(halt30, [span(40, 80)])).toHaveLength(1);                 // no overlap
    expect(detectHalts(halt30, [])).toHaveLength(1);
  });

  it('counts overlapping visits once (their union), not twice', () => {
    // 0-10 and 5-15 cover 15 of 30 minutes (50 %); double-counting would wrongly say 20 (67 %).
    expect(detectHalts(halt30, [span(0, 10), span(5, 15)])).toHaveLength(1);
    // 0-20 and 10-25 cover 25 of 30.
    expect(detectHalts(halt30, [span(0, 20), span(10, 25)])).toEqual([]);
  });

  it('adds up separate visits inside one halt', () => {
    expect(detectHalts(halt30, [span(0, 8), span(12, 22)])).toEqual([]);          // 8 + 10 = 18/30
    expect(detectHalts(halt30, [span(0, 5), span(25, 30)])).toHaveLength(1);       // 10/30
  });

  it('suppresses only the halts that are visits: indices stay consecutive', () => {
    // three halts: 0-12 (kept), 20-40 (inside a visit), 60-75 (kept)
    const pings = [p(0), p(6), p(12), p(20, 300), p(30, 300), p(40, 300), p(60, 900), p(68, 900), p(75, 900)];
    const halts = detectHalts(pings, [span(18, 42)]);
    expect(halts.map((h) => [h.index, h.start_at])).toEqual([[0, iso(0)], [1, iso(60)]]);
  });

  it('tolerates a visit given backwards', () => {
    expect(detectHalts(halt30, [{ inMs: T0 + 40 * 60_000, outMs: T0 + 10 * 60_000 }])).toEqual([]);
  });
});
