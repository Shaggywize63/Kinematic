/**
 * PATCH /users/status — the location heartbeat.
 *  - A phone with leaked location listeners sends the SAME fix ~10x in one second; only one row may be stored.
 *  - 0,0 ("no fix", sent for login events) must never overwrite a rep's real last position.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { updateUserStatus } from '../src/controllers/misc.controller';
import { isDuplicateHeartbeat, isNullIsland, resetHeartbeatGuard, DUPLICATE_WINDOW_MS } from '../src/lib/heartbeatGuard';

const supa = () => (global as any).__supa;
const USER = { id: 'u-murthy', org_id: 'org-1', client_id: null as string | null, role: 'sub_admin' };

/** Calls the handler and resolves with the JSON body (asyncHandler doesn't return its promise). */
const beat = (body: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
  const res: any = { status: () => res, json: (b: unknown) => { resolve(b); return res; }, end: () => { resolve('ended'); return res; } };
  (updateUserStatus as any)({ user: USER, body }, res, (e: unknown) => reject(e));
});
const rows = (table: string, method: string) =>
  supa().chainsFor(table).flatMap((c: any) => c.ops.filter((o: any) => o.method === method).map((o: any) => o.args[0]));

beforeEach(() => { supa().reset(); resetHeartbeatGuard(); jest.restoreAllMocks(); });

describe('heartbeatGuard (unit)', () => {
  it('drops an identical fix inside the window, keeps a moved or a later one', () => {
    expect(isDuplicateHeartbeat('u1', 12.7, 75.9, 1_000_000)).toBe(false);
    expect(isDuplicateHeartbeat('u1', 12.7, 75.9, 1_000_500)).toBe(true);
    expect(isDuplicateHeartbeat('u1', 12.7001, 75.9, 1_000_900)).toBe(false);                       // moved
    expect(isDuplicateHeartbeat('u1', 12.7001, 75.9, 1_000_900 + DUPLICATE_WINDOW_MS + 1)).toBe(false); // same spot, much later
    expect(isDuplicateHeartbeat('u2', 12.7, 75.9, 1_000_600)).toBe(false);                          // other user
  });
  it('a stuck phone still gets one row per window (duplicates do not extend it)', () => {
    expect(isDuplicateHeartbeat('u1', 1, 2, 0)).toBe(false);
    expect(isDuplicateHeartbeat('u1', 1, 2, 15_000)).toBe(true);
    expect(isDuplicateHeartbeat('u1', 1, 2, DUPLICATE_WINDOW_MS + 1)).toBe(false);
  });
  it('knows Null Island', () => {
    expect(isNullIsland(0, 0)).toBe(true);
    expect(isNullIsland(0, 75.9)).toBe(false);
    expect(isNullIsland(12.7, 0)).toBe(false);
  });
});

describe('PATCH /users/status', () => {
  it('stores ONE row for a burst of 10 identical heartbeats in the same second', async () => {
    const body = { latitude: 12.72962, longitude: 75.9534, battery: 56, activity_type: 'HEARTBEAT' };
    await Promise.all(Array.from({ length: 10 }, () => beat(body)));
    expect(rows('work_activity', 'insert')).toHaveLength(1);
    expect(rows('users', 'update')).toHaveLength(1);
  });

  it('answers every duplicate with success so the app does not retry', async () => {
    const body = { latitude: 12.7, longitude: 75.9 };
    const first = await beat(body);
    const second = await beat(body);
    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true });
  });

  it('keeps every heartbeat of a moving rep', async () => {
    await beat({ latitude: 12.7000, longitude: 75.9000 });
    await beat({ latitude: 12.7010, longitude: 75.9010 });
    await beat({ latitude: 12.7020, longitude: 75.9020 });
    expect(rows('work_activity', 'insert')).toHaveLength(3);
  });

  it('keeps the same spot again once the window has passed', async () => {
    const t0 = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await beat({ latitude: 12.7, longitude: 75.9 });
    jest.spyOn(Date, 'now').mockReturnValue(t0 + DUPLICATE_WINDOW_MS + 5);
    await beat({ latitude: 12.7, longitude: 75.9 });
    expect(rows('work_activity', 'insert')).toHaveLength(2);
  });

  it('only de-duplicates HEARTBEATs: check-in / form-submit events at the same spot are all kept', async () => {
    await beat({ latitude: 12.7, longitude: 75.9, activity_type: 'CHECK_IN' });
    await beat({ latitude: 12.7, longitude: 75.9, activity_type: 'FORM_SUBMIT' });
    expect(rows('work_activity', 'insert')).toHaveLength(2);
  });

  it('a 0,0 login event syncs battery but never overwrites the last position or "last seen"', async () => {
    await beat({ latitude: 0, longitude: 0, battery: 41, activity_type: 'LOGIN', device_model: 'moto g85 5G' });
    const [patch] = rows('users', 'update');
    expect(patch).toMatchObject({ battery_percentage: 41, device_model: 'moto g85 5G' });
    expect(patch).not.toHaveProperty('last_latitude');
    expect(patch).not.toHaveProperty('last_longitude');
    expect(patch).not.toHaveProperty('last_location_updated_at');
    expect(patch).not.toHaveProperty('location_status');
  });

  it('a real fix still updates the position, time and status', async () => {
    await beat({ latitude: 12.7, longitude: 75.9, battery: 66, location_precise: true });
    const [patch] = rows('users', 'update');
    expect(patch).toMatchObject({ last_latitude: 12.7, last_longitude: 75.9, battery_percentage: 66, location_status: 'on', location_precise: true });
    expect(typeof patch.last_location_updated_at).toBe('string');
  });
});
