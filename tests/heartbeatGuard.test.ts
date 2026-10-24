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
import { requiresOpenShift, shouldLogOffShift, resetOffShiftLog } from '../src/lib/liveTracking';

const supa = () => (global as any).__supa;
const USER = { id: 'u-murthy', org_id: 'org-1', client_id: null as string | null, role: 'sub_admin' };

/** Calls the handler and resolves with the JSON body (asyncHandler doesn't return its promise). */
const beat = (body: Record<string, unknown>, user: Record<string, unknown> = USER) => new Promise<any>((resolve, reject) => {
  const res: any = { status: () => res, json: (b: unknown) => { resolve(b); return res; }, end: () => { resolve('ended'); return res; } };
  (updateUserStatus as any)({ user, body }, res, (e: unknown) => reject(e));
});
const rows = (table: string, method: string) =>
  supa().chainsFor(table).flatMap((c: any) => c.ops.filter((o: any) => o.method === method).map((o: any) => o.args[0]));

// Location is tracked only between check-in and check-out: by default the rep under test has an OPEN shift.
const OPEN_SHIFT = { data: { id: 'att-open' } };
beforeEach(() => {
  supa().reset(); resetHeartbeatGuard(); resetOffShiftLog(); jest.restoreAllMocks();
  delete process.env.TRACK_ONLY_ON_SHIFT;
  supa().setDefault('attendance', OPEN_SHIFT);
});

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

describe('location is tracked only between check-in and check-out', () => {
  const NO_SHIFT = { data: null };

  it('before check-in: battery / device sync only — no position, no "last seen", no trail row', async () => {
    supa().setDefault('attendance', NO_SHIFT);
    const res = await beat({ latitude: 12.7, longitude: 75.9, battery: 52, device_model: 'moto g85 5G' });
    expect(res).toMatchObject({ success: true });
    const [patch] = rows('users', 'update');
    expect(patch).toMatchObject({ battery_percentage: 52, device_model: 'moto g85 5G' });
    expect(patch).not.toHaveProperty('last_latitude');
    expect(patch).not.toHaveProperty('last_longitude');
    expect(patch).not.toHaveProperty('last_location_updated_at');
    expect(rows('work_activity', 'insert')).toHaveLength(0);
    expect(supa().chainsFor('work_activity')).toHaveLength(0);   // not even the previous-fix lookup
  });

  it('after check-out (no open shift left): the same — nothing is stored', async () => {
    supa().setDefault('attendance', NO_SHIFT);
    await beat({ latitude: 12.71, longitude: 75.91, activity_type: 'HEARTBEAT' });
    await beat({ latitude: 12.72, longitude: 75.92, activity_type: 'FORM_SUBMIT' });
    expect(rows('work_activity', 'insert')).toHaveLength(0);
    for (const patch of rows('users', 'update')) expect(patch).not.toHaveProperty('last_latitude');
  });

  it('asks only for an OPEN shift of this user from yesterday on (an overnight shift stays tracked)', async () => {
    await beat({ latitude: 12.7, longitude: 75.9 });
    const q = supa().chainsFor('attendance')[0];
    expect(q.eqs.user_id).toBe(USER.id);
    expect(q.ops.map((o: any) => o.method)).toEqual(expect.arrayContaining(['gte', 'not', 'is']));
    expect(q.ops.find((o: any) => o.method === 'gte').args[0]).toBe('date');
    expect(q.ops.find((o: any) => o.method === 'is').args).toEqual(['checkout_at', null]);
    expect(q.ops.find((o: any) => o.method === 'not').args).toEqual(['checkin_at', 'is', null]);
  });

  it('with an open shift it stores the position and links the trail row to that shift', async () => {
    await beat({ latitude: 12.7, longitude: 75.9, battery: 66 });
    expect(rows('work_activity', 'insert')[0]).toMatchObject({ attendance_id: 'att-open', lat: 12.7, lng: 75.9 });
    expect(rows('users', 'update')[0]).toMatchObject({ last_latitude: 12.7, last_longitude: 75.9 });
  });

  it('a client whose complete module list has no attendance has no check-in to key on: still tracked', async () => {
    supa().setDefault('attendance', NO_SHIFT);
    const crmOnly = { ...USER, client_id: 'c-1', entitlements_strict: true, enabled_modules: ['crm_leads'] };
    await beat({ latitude: 12.7, longitude: 75.9 }, crmOnly);
    expect(rows('work_activity', 'insert')).toHaveLength(1);
    const withAttendance = { ...crmOnly, enabled_modules: ['crm_leads', 'attendance'] };
    supa().reset(); supa().setDefault('attendance', NO_SHIFT); resetHeartbeatGuard();
    await beat({ latitude: 13.1, longitude: 76.1 }, withAttendance);
    expect(rows('work_activity', 'insert')).toHaveLength(0);
  });

  it('TRACK_ONLY_ON_SHIFT=off restores the old any-ping rule', async () => {
    process.env.TRACK_ONLY_ON_SHIFT = 'off';
    supa().setDefault('attendance', NO_SHIFT);
    await beat({ latitude: 12.7, longitude: 75.9 });
    expect(rows('work_activity', 'insert')).toHaveLength(1);
  });

  it('requiresOpenShift / shouldLogOffShift (unit)', () => {
    expect(requiresOpenShift(undefined)).toBe(false);
    expect(requiresOpenShift({})).toBe(true);                                                         // legacy (non-strict) list
    expect(requiresOpenShift({ entitlements_strict: true, enabled_modules: [] })).toBe(false);
    expect(requiresOpenShift({ entitlements_strict: true, enabled_modules: ['attendance'] })).toBe(true);
    expect(shouldLogOffShift('u1', 0)).toBe(true);
    expect(shouldLogOffShift('u1', 59 * 60_000)).toBe(false);                                         // once an hour per user
    expect(shouldLogOffShift('u1', 61 * 60_000)).toBe(true);
    expect(shouldLogOffShift('u2', 1)).toBe(true);
  });
});
