/**
 * The Live Trailing map froze on Harisha (Rajkamal): 2,471 heartbeats in one day, 169 distinct seconds,
 * 24 distinct coordinates — the same fix stored 10+ times a second by an old Android build. The trail
 * endpoint now collapses those repeats (the same rule as the write-side heartbeat guard) so the map and
 * the CSV get real pings.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { collapseDuplicatePings } from '../src/lib/trailThin';
import { getUserLocationTrail } from '../src/controllers/location-trail.controller';

const supa = () => (global as any).__supa;

const T0 = Date.parse('2026-10-08T04:30:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const hb = (sec: number, lat = 12.7296, lng = 75.9534, activity_type = 'HEARTBEAT') =>
  ({ lat, lng, captured_at: at(sec), activity_type, battery_percentage: 55 });

describe('collapseDuplicatePings', () => {
  it('collapses a burst of identical fixes in the same second to one', () => {
    const burst = Array.from({ length: 12 }, () => hb(0));
    expect(collapseDuplicatePings(burst)).toHaveLength(1);
  });

  it('keeps a stationary rep\'s next ping once the window has passed (one point per window)', () => {
    const rows = [hb(0), hb(5), hb(19), hb(21), hb(30), hb(45)];
    // anchor 0 -> 5/19 dropped -> 21 kept (new anchor) -> 30 dropped -> 45 kept (>= 20 s after 21)
    expect(collapseDuplicatePings(rows).map((r) => r.captured_at)).toEqual([at(0), at(21), at(45)]);
  });

  it('never drops a ping where the rep actually moved, even a second later', () => {
    const rows = [hb(0, 12.7296), hb(1, 12.7297), hb(2, 12.7298)];
    expect(collapseDuplicatePings(rows)).toHaveLength(3);
  });

  it('a duplicate interleaved with a move is judged against the last KEPT ping', () => {
    const rows = [hb(0, 1, 1), hb(1, 2, 2), hb(2, 2, 2), hb(3, 1, 1)];
    // (1,1) again at +3 s is not a repeat of the immediately preceding kept fix (2,2), so it stays.
    expect(collapseDuplicatePings(rows).map((r) => [r.lat, r.lng])).toEqual([[1, 1], [2, 2], [1, 1]]);
  });

  it('always keeps check-in / check-out / form-submit rows, even on the same coordinates as a heartbeat', () => {
    const rows = [hb(0), hb(1, 12.7296, 75.9534, 'CHECK_IN'), hb(2), hb(3, 12.7296, 75.9534, 'FORM_SUBMIT'), hb(4, 12.7296, 75.9534, 'CHECK_OUT')];
    expect(collapseDuplicatePings(rows).map((r) => r.activity_type)).toEqual(['HEARTBEAT', 'CHECK_IN', 'FORM_SUBMIT', 'CHECK_OUT']);
  });

  it('drops 0,0 ("no fix") and rows without coordinates', () => {
    const rows = [hb(0, 0, 0), hb(1, 0, 0, 'CHECK_IN'), { ...hb(2), lat: null }, { ...hb(3), lng: null }, hb(4)];
    const out = collapseDuplicatePings(rows);
    expect(out).toHaveLength(1);
    expect(out[0].captured_at).toBe(at(4));
  });

  it('keeps a real position on the equator or prime meridian (only exactly 0,0 is "no fix")', () => {
    expect(collapseDuplicatePings([hb(0, 0, 36.8), hb(40, 51.5, 0)])).toHaveLength(2);
  });

  it('keeps extra columns untouched and does not mutate its input', () => {
    const rows = [hb(0), hb(1)];
    const snapshot = JSON.stringify(rows);
    const out = collapseDuplicatePings(rows);
    expect(out[0]).toMatchObject({ battery_percentage: 55 });
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it('reproduces the production shape: ~2.4k rows over 24 coordinates collapse to a handful per coordinate', () => {
    const rows: ReturnType<typeof hb>[] = [];
    // 30 minute-slots; each slot repeats one of 24 coordinates ~80x within a few seconds.
    for (let slot = 0; slot < 30; slot++) {
      const lat = 12.7 + (slot % 24) * 0.001;
      for (let k = 0; k < 80; k++) rows.push(hb(slot * 60 + Math.floor(k / 20), lat, 75.95));
    }
    expect(rows).toHaveLength(2400);
    const out = collapseDuplicatePings(rows);
    expect(out.length).toBe(30); // one per minute-slot: the burst inside a slot is under 20 s
  });

  it('handles an empty list', () => {
    expect(collapseDuplicatePings([])).toEqual([]);
  });
});

describe('GET /users/:id/location-trail', () => {
  /** Calls the handler and resolves with the JSON body (asyncHandler doesn't return its promise). */
  const fetchTrail = () => new Promise<any>((resolve, reject) => {
    const res: any = { status: () => res, json: (b: unknown) => { resolve(b); return res; } };
    (getUserLocationTrail as any)(
      { user: { id: 'admin-1', org_id: 'org-1' }, params: { id: 'u-harisha' }, query: { date: '2026-10-08' } }, res, (e: unknown) => reject(e));
  });

  beforeEach(() => supa().reset());

  it('sends the dashboard the collapsed trail, not every stored duplicate', async () => {
    const stored = [
      ...Array.from({ length: 40 }, () => hb(0)),
      hb(1, 12.73, 75.96, 'CHECK_IN'),
      ...Array.from({ length: 40 }, () => hb(600, 12.74, 75.97)),
      hb(900, 0, 0),
    ];
    supa().setDefault('work_activity', { data: stored });
    const body = await fetchTrail();
    expect(body.success).toBe(true);
    expect(body.data.map((r: any) => [r.activity_type, r.lat, r.lng])).toEqual([
      ['HEARTBEAT', 12.7296, 75.9534],
      ['CHECK_IN', 12.73, 75.96],
      ['HEARTBEAT', 12.74, 75.97],
    ]);
  });

  it('still scopes the query to the caller\'s org and the requested user', async () => {
    supa().setDefault('work_activity', { data: [] });
    await fetchTrail();
    const eqs = supa().chainsFor('work_activity')[0].eqs;
    expect(eqs).toMatchObject({ org_id: 'org-1', user_id: 'u-harisha' });
  });
});
