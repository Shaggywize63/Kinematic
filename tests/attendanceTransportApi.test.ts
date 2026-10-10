/**
 * Mode of transport over HTTP (opt-in rule `track_transport_mode`): the real attendance router against the
 * chainable Supabase double. Covers GET /attendance/rules (`transport_modes`), POST /attendance/checkin with
 * `transport_mode`, PATCH /attendance/transport-mode, `transport_label` on records, and — the guarantee this
 * feature hangs on — that `attendance.transport_mode` is written ONLY when the client's rule is on AND the
 * request supplies it, and is never part of a generic select/insert list (the same code serves a database
 * that has no such column).
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { ...(global as any).__testUser };
    next();
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const attendanceRouter = require('../src/routes/attendance.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/middleware/errorHandler') as { errorHandler: express.ErrorRequestHandler };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearClientFlagCache } = require('../src/lib/clientFlags') as { clearClientFlagCache: (id?: string | null) => void };
import { istDateOf } from '../src/services/attendanceRules.service';
import { DEMO_ORG_ID } from '../src/utils/demoData';

const app = express();
app.use(express.json());
app.use('/attendance', attendanceRouter);
app.use(errorHandler);

const ORG = '00000000-0000-4000-8000-0000000000aa';
const CA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // track_transport_mode ON (and nothing else)
const CB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // legacy client: no attendance_rules at all
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // configured, but the transport rule is OFF
const REP = '22222222-2222-4222-8222-222222222222';
const REP2 = '33333333-3333-4333-8333-333333333333';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const GEO = { latitude: 18.52, longitude: 73.85 };
const TODAY = istDateOf(Date.now()) as string;

const setUser = (u: Record<string, unknown>) => { (global as any).__testUser = u; };
const repOf = (client: string | null, over: Record<string, unknown> = {}) =>
  ({ id: REP, org_id: ORG, role: 'field_executive', client_id: client, name: 'Asha', email: 'asha@client.test', ...over });

let CLIENTS: Record<string, { id: string; org_id: string; owner_org_id?: string | null; settings: Record<string, unknown> }>;
let policyRules: Record<string, unknown>;                  // the `rules` of the one org-wide expense policy
let policyFetchFails = false;
let missingColumn = false;                                  // simulate a database without attendance.transport_mode

const POLICY_WITH_VEHICLES = { vehicle_rates: [{ id: 'own_bike', label: 'Own Bike', rate_per_km: 4 }, { id: 'own_car', label: 'Own Car', rate_per_km: 9 }] };

const chainsOn = (table: string) => __mock.chainsFor(table);
const upserts = () => chainsOn('attendance').filter((c) => c.ops.some((o) => o.method === 'upsert'));
const updates = () => chainsOn('attendance').filter((c) => c.ops.some((o) => o.method === 'update'));
const payload = (chain: { ops: Array<{ method: string; args: unknown[] }> }, method: string) =>
  chain.ops.find((o) => o.method === method)!.args[0] as Record<string, any>;
/** Every expense-policy resolution reads `expense_policies` (the live policies), so this counts the lookups. */
const policyReads = () => chainsOn('expense_policies').length;

const COLUMN_ERROR = 'column "transport_mode" of relation "attendance" does not exist';

function stubAttendance() {
  __mock.setDefault('attendance', (chain) => {
    const up = chain.ops.find((o) => o.method === 'upsert');
    if (up) {
      const row = up.args[0] as Record<string, unknown>;
      if (missingColumn && 'transport_mode' in row) return { data: null, error: { message: COLUMN_ERROR } };
      return { data: { id: 'att-new', breaks: [], ...row } };
    }
    return { data: [] };                                    // no existing row today
  });
}

beforeEach(() => {
  __mock.reset();
  clearClientFlagCache();
  policyFetchFails = false;
  missingColumn = false;
  policyRules = POLICY_WITH_VEHICLES;
  CLIENTS = {
    [CA]: { id: CA, org_id: ORG, owner_org_id: null, settings: { attendance_rules: { track_transport_mode: true } } },
    [CB]: { id: CB, org_id: ORG, owner_org_id: null, settings: {} },
    [CC]: { id: CC, org_id: ORG, owner_org_id: null, settings: { attendance_rules: { selfie_required: false, shift_start: '10:00' } } },
  };
  __mock.setDefault('clients', (chain) => {
    const row = CLIENTS[String(chain.eqs.id)];
    if (!row) return { data: null };
    const sel = String(chain.ops.find((o) => o.method === 'select')?.args[0] ?? '');
    return { data: sel === 'settings' ? { settings: row.settings } : row };
  });
  // The expense policy that governs everyone (schema probe = the query with no org filter).
  __mock.setDefault('expense_policies', (chain) => {
    if (!chain.eqs.org_id) return { data: [] };
    if (policyFetchFails) return { data: null, error: { message: 'policy store is down' } };
    return {
      data: [{
        id: 'pol-1', name: 'Field policy', is_active: true, priority: 10, currency: 'INR', client_id: null,
        applies_to: { everyone: true, roles: [], org_role_ids: [], user_ids: [] }, rules: policyRules,
      }],
    };
  });
  __mock.setDefault('users', { data: [{ id: REP, role: 'field_executive', org_role_id: null }, { id: REP2, role: 'field_executive', org_role_id: null }] });
  stubAttendance();
  setUser(repOf(CA));
});

describe('GET /attendance/rules -> transport_modes', () => {
  it('rule ON: the policy vehicles first (vehicle:true), then public transport and other', async () => {
    const res = await request(app).get('/attendance/rules');
    expect(res.status).toBe(200);
    expect(res.body.data.rules.track_transport_mode).toBe(true);
    expect(res.body.data.transport_modes).toEqual([
      { id: 'own_bike', label: 'Own Bike', vehicle: true },
      { id: 'own_car', label: 'Own Car', vehicle: true },
      { id: 'public_transport', label: 'Public transport', vehicle: false },
      { id: 'other', label: 'Other', vehicle: false },
    ]);
  });

  it('rule ON, policy without vehicle rates: two_wheeler and car + the two fixed ones', async () => {
    policyRules = {};
    const res = await request(app).get('/attendance/rules');
    expect(res.body.data.transport_modes).toEqual([
      { id: 'two_wheeler', label: 'Two-wheeler', vehicle: true },
      { id: 'car', label: 'Car', vehicle: true },
      { id: 'public_transport', label: 'Public transport', vehicle: false },
      { id: 'other', label: 'Other', vehicle: false },
    ]);
  });

  it('rule ON but the policy cannot be read: still 200, with the default modes', async () => {
    policyFetchFails = true;
    const res = await request(app).get('/attendance/rules');
    expect(res.status).toBe(200);
    expect(res.body.data.transport_modes.map((m: any) => m.id)).toEqual(['two_wheeler', 'car', 'public_transport', 'other']);
  });

  it.each([['a legacy client', CB], ['a configured client with the rule off', CC]])(
    'rule OFF (%s): transport_modes is [] and no policy is read', async (_l, client) => {
      setUser(repOf(client));
      const res = await request(app).get('/attendance/rules');
      expect(res.status).toBe(200);
      expect(res.body.data.rules.track_transport_mode).toBe(false);
      expect(res.body.data.transport_modes).toEqual([]);
      expect(chainsOn('expense_policies')).toHaveLength(0);
      expect(chainsOn('users')).toHaveLength(0);
    });
});

describe('POST /attendance/checkin with transport_mode', () => {
  it('rule ON + a valid policy vehicle: stored, and the record carries transport_label', async () => {
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'own_bike' });
    expect(res.status).toBe(201);
    expect(payload(upserts()[0], 'upsert').transport_mode).toBe('own_bike');
    expect(res.body.data).toMatchObject({ transport_mode: 'own_bike', transport_label: 'Own Bike' });
  });

  it.each([['public_transport', 'Public transport'], ['other', 'Other']])('rule ON + %s: stored with its fixed label', async (id, label) => {
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: id });
    expect(res.status).toBe(201);
    expect(payload(upserts()[0], 'upsert').transport_mode).toBe(id);
    expect(res.body.data).toMatchObject({ transport_mode: id, transport_label: label });
  });

  it('rule ON + an id the policy does not offer: 400 and NOTHING is written', async () => {
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'helicopter' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown transport_mode "helicopter"/);
    expect(upserts()).toHaveLength(0);
  });

  it('the defaults (two_wheeler) are not accepted when the policy lists its own vehicles', async () => {
    expect((await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'two_wheeler' })).status).toBe(400);
    expect(upserts()).toHaveLength(0);
  });

  it.each([['upper case', 'Own_Bike'], ['spaces', 'own bike'], ['41 chars', 'a'.repeat(41)], ['a number', 7], ['an object', { id: 'car' }], ['an array', ['car']]])(
    'rule ON + a malformed value (%s): 400, nothing written', async (_l, v) => {
      const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: v });
      expect(res.status).toBe(400);
      expect(upserts()).toHaveLength(0);
    });

  it('rule ON + no transport_mode (older app build, or the rep skipped it): the check-in works and the column is not touched', async () => {
    const res = await request(app).post('/attendance/checkin').send(GEO);
    expect(res.status).toBe(201);
    expect('transport_mode' in payload(upserts()[0], 'upsert')).toBe(false);
    expect('transport_label' in res.body.data).toBe(false);
    expect(policyReads()).toBe(0);
  });

  it.each([['null', null], ['an empty string', '']])('rule ON + transport_mode %s counts as not sent', async (_l, v) => {
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: v });
    expect(res.status).toBe(201);
    expect('transport_mode' in payload(upserts()[0], 'upsert')).toBe(false);
  });

  it('the offline path carries it too (captured_at + Idempotency-Key): same body, same validation', async () => {
    CLIENTS[CA].settings = { attendance_rules: { track_transport_mode: true, allow_offline_checkin: true } };
    clearClientFlagCache();
    const captured = new Date(Date.now() - 20 * 60_000).toISOString();
    const res = await request(app).post(`/attendance/checkin?date=${istDateOf(captured)}`).set('Idempotency-Key', 'offline-1')
      .send({ ...GEO, captured_at: captured, transport_mode: 'own_car' });
    expect(res.status).toBe(201);
    expect(payload(upserts()[0], 'upsert')).toMatchObject({ checkin_at: captured, transport_mode: 'own_car' });
  });

  it('if the expense policy cannot be read the well-formed id is accepted (a punch is never lost to a policy blip)', async () => {
    policyFetchFails = true;
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'own_bike' });
    expect(res.status).toBe(201);
    expect(payload(upserts()[0], 'upsert').transport_mode).toBe('own_bike');
  });

  it('a project WITHOUT the column: the rule is on, the column is missing -> the check-in still succeeds, without the mode', async () => {
    missingColumn = true;
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'own_bike' });
    expect(res.status).toBe(201);
    expect(upserts()).toHaveLength(2);
    expect('transport_mode' in payload(upserts()[0], 'upsert')).toBe(true);
    expect('transport_mode' in payload(upserts()[1], 'upsert')).toBe(false);
    expect(res.body.data.id).toBe('att-new');
    expect('transport_label' in res.body.data).toBe(false);
  });

  it('any OTHER save error is not retried or hidden', async () => {
    __mock.setDefault('attendance', (chain) =>
      chain.ops.some((o) => o.method === 'upsert') ? { data: null, error: { message: 'permission denied for table attendance' } } : { data: [] });
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'own_bike' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('permission denied for table attendance');
    expect(upserts()).toHaveLength(1);
  });

  it('a replay (the day already has a record) returns it untouched and writes nothing', async () => {
    __mock.setDefault('attendance', { data: { id: 'att-old', user_id: REP, client_id: CA, org_id: ORG, status: 'checked_in', checkin_at: new Date().toISOString(), transport_mode: 'own_bike', breaks: [] } });
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'own_car' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'att-old', transport_mode: 'own_bike', transport_label: 'Own Bike' });
    expect(upserts()).toHaveLength(0);
  });
});

describe('the column is NEVER written (or looked at) when the rule is off', () => {
  // The exact keys a plain check-in has always written: nothing may be added for clients without the rule.
  const LEGACY_KEYS = ['checkin_at', 'checkin_distance_m', 'checkin_lat', 'checkin_lng', 'checkin_selfie_url', 'client_id', 'date', 'org_id', 'status', 'user_id', 'zone_id', 'activity_id'];

  it.each([['a legacy client (no attendance_rules)', CB], ['a configured client with the rule off', CC], ['a user with no client', null]])(
    'check-in for %s ignores a sent transport_mode: not written, not validated, no policy read', async (_l, client) => {
      setUser(repOf(client));
      const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'own_bike' });
      expect(res.status).toBe(201);
      const row = payload(upserts()[0], 'upsert');
      expect('transport_mode' in row).toBe(false);
      expect(Object.keys(row).sort()).toEqual([...LEGACY_KEYS].sort());
      expect(policyReads()).toBe(0);
      expect('transport_label' in res.body.data).toBe(false);
    });

  it('...even an invalid one is simply ignored (it is not their feature)', async () => {
    setUser(repOf(CB));
    const res = await request(app).post('/attendance/checkin').send({ ...GEO, transport_mode: 'NOT VALID!!' });
    expect(res.status).toBe(201);
    expect('transport_mode' in payload(upserts()[0], 'upsert')).toBe(false);
  });

  it('a legacy client\'s check-in select / check-out update / break writes never mention transport_mode', async () => {
    setUser(repOf(CB));
    await request(app).post('/attendance/checkin').send(GEO);
    const open = { id: 'att-open', user_id: REP, client_id: CB, date: TODAY, status: 'checked_in', checkin_at: new Date(Date.now() - 3_600_000).toISOString(), break_minutes: 0 };
    __mock.setDefault('attendance', (chain) => chain.ops.some((o) => o.method === 'update') ? { data: { ...open, breaks: [] } } : { data: [open] });
    await request(app).post('/attendance/checkout').send(GEO);
    const everything = JSON.stringify(chainsOn('attendance').map((c) => c.ops));
    expect(everything).not.toContain('transport');
  });

  it('the travel service reads attendance by an explicit column list that does not include transport_mode', async () => {
    setUser(repOf(CB));
    __mock.setDefault('attendance', { data: [] });
    await request(app).get(`/attendance/travel?date=${TODAY}`);
    const selects = chainsOn('attendance').flatMap((c) => c.ops.filter((o) => o.method === 'select').map((o) => String(o.args[0])));
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).not.toMatch(/transport_mode|\*/);
  });

  it('PATCH /transport-mode for a client with the rule off is a 400 and writes nothing', async () => {
    for (const client of [CB, CC]) {
      __mock.chains.length = 0;
      setUser(repOf(client));
      const res = await request(app).patch('/attendance/transport-mode').send({ mode: 'car' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, details: { code: 'TRANSPORT_MODE_DISABLED' } });
      expect(updates()).toHaveLength(0);
      expect(chainsOn('attendance')).toHaveLength(0);
    }
  });
});

describe('PATCH /attendance/transport-mode', () => {
  const ROW = { id: 'att-1', user_id: REP, org_id: ORG, client_id: CA, date: TODAY, status: 'checked_in', checkin_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), break_minutes: 0, transport_mode: 'other' };
  let found: Record<string, unknown> | null;
  let updateError: string | null;

  beforeEach(() => {
    found = ROW;
    updateError = null;
    __mock.setDefault('attendance', (chain) => {
      const upd = chain.ops.find((o) => o.method === 'update');
      if (upd) return updateError ? { data: null, error: { message: updateError } } : { data: { ...ROW, ...(upd.args[0] as object), breaks: [] } };
      return { data: found ? [found] : [] };
    });
  });

  it('updates the caller\'s own row for today (IST) and returns the attendance row with its label', async () => {
    const res = await request(app).patch('/attendance/transport-mode').send({ mode: 'own_car' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: 'att-1', transport_mode: 'own_car', transport_label: 'Own Car' });
    const find = chainsOn('attendance')[0];
    expect(find.eqs).toMatchObject({ user_id: REP, date: TODAY });
    const [upd] = updates();
    expect(payload(upd, 'update')).toEqual({ transport_mode: 'own_car' });       // nothing else is touched
    expect(upd.eqs).toMatchObject({ id: 'att-1', user_id: REP });
  });

  it('takes an explicit date', async () => {
    const res = await request(app).patch('/attendance/transport-mode').send({ mode: 'public_transport', date: '2026-10-08' });
    expect(res.status).toBe(200);
    expect(chainsOn('attendance')[0].eqs).toMatchObject({ user_id: REP, date: '2026-10-08' });
    expect(res.body.data).toMatchObject({ transport_label: 'Public transport' });
  });

  it('works after check-out too (the rep can still correct it)', async () => {
    found = { ...ROW, status: 'checked_out', checkout_at: new Date().toISOString() };
    expect((await request(app).patch('/attendance/transport-mode').send({ mode: 'car' }).then((r) => r.status))).toBe(400);   // 'car' is not offered by this policy
    expect((await request(app).patch('/attendance/transport-mode').send({ mode: 'own_bike' })).status).toBe(200);
  });

  it('400 for an unknown or malformed mode, a missing mode, and a bad date - with no write', async () => {
    for (const body of [{ mode: 'helicopter' }, { mode: 'Own_Bike' }, { mode: 5 }, { mode: '' }, {}, { mode: null }, { mode: 'own_bike', date: '2026-13-45' }, { mode: 'own_bike', date: '08-10-2026' }, { mode: 'own_bike', date: 20261008 }]) {
      const res = await request(app).patch('/attendance/transport-mode').send(body as object);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(updates()).toHaveLength(0);
  });

  it('400 when there is no attendance row that day', async () => {
    found = null;
    const res = await request(app).patch('/attendance/transport-mode').send({ mode: 'own_bike' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No attendance found for/);
    expect(updates()).toHaveLength(0);
  });

  it('only ever touches the CALLER\'S row, whatever else the body says', async () => {
    const res = await request(app).patch('/attendance/transport-mode').send({ mode: 'own_bike', user_id: REP2, id: 'att-other', org_id: 'x' });
    expect(res.status).toBe(200);
    expect(chainsOn('attendance')[0].eqs.user_id).toBe(REP);
    expect(updates()[0].eqs).toMatchObject({ id: 'att-1', user_id: REP });
    expect(payload(updates()[0], 'update')).toEqual({ transport_mode: 'own_bike' });
  });

  it('a project without the column answers 400 with a plain message (not the database error)', async () => {
    updateError = COLUMN_ERROR;
    const res = await request(app).patch('/attendance/transport-mode').send({ mode: 'own_bike' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Mode of transport is not available on this project yet');
  });

  it('is its own route (not swallowed by /:id/override, and not a GET)', async () => {
    expect((await request(app).patch('/attendance/transport-mode').send({ mode: 'own_bike' })).status).toBe(200);
    expect((await request(app).get('/attendance/transport-mode')).status).toBe(404);
  });

  it('a demo user gets an acknowledgement and no database access', async () => {
    setUser(repOf(CA, { org_id: DEMO_ORG_ID }));
    const res = await request(app).patch('/attendance/transport-mode').send({ mode: 'car' });
    expect(res.status).toBe(200);
    expect(chainsOn('attendance')).toHaveLength(0);
  });
});

describe('transport_label on the records the controller already annotates', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'att-1', user_id: REP, org_id: ORG, client_id: CA, date: TODAY, status: 'checked_in',
    checkin_at: new Date(Date.now() - 3_600_000).toISOString(), total_hours: null, breaks: [], ...over,
  });

  it('GET /today: a vehicle mode is labelled from the user\'s policy', async () => {
    __mock.setDefault('attendance', { data: [row({ transport_mode: 'own_bike' })] });
    const res = await request(app).get('/attendance/today');
    expect(res.body.data).toMatchObject({ transport_mode: 'own_bike', transport_label: 'Own Bike' });
  });

  it('GET /today: a fixed mode is labelled with no policy read', async () => {
    __mock.setDefault('attendance', { data: [row({ transport_mode: 'public_transport' })] });
    const res = await request(app).get('/attendance/today');
    expect(res.body.data.transport_label).toBe('Public transport');
    expect(policyReads()).toBe(0);
  });

  it('a mode the policy no longer lists is shown made readable, not dropped', async () => {
    __mock.setDefault('attendance', { data: [row({ transport_mode: 'company_van' })] });
    const res = await request(app).get('/attendance/today');
    expect(res.body.data.transport_label).toBe('Company Van');
  });

  it('GET /today: no mode -> no transport_label key and no policy read (nothing changes for clients without the feature)', async () => {
    for (const r of [row(), row({ transport_mode: null })]) {
      __mock.chains.length = 0;
      __mock.setDefault('attendance', { data: [r] });
      const res = await request(app).get('/attendance/today');
      expect('transport_label' in res.body.data).toBe(false);
      expect(policyReads()).toBe(0);
    }
  });

  it('GET /history annotates every item', async () => {
    __mock.setDefault('attendance', { data: [row({ transport_mode: 'own_car' }), row({ id: 'att-2', transport_mode: 'other' }), row({ id: 'att-3' })], count: 3 });
    const res = await request(app).get('/attendance/history');
    const items: any[] = res.body.data.items ?? res.body.data;
    expect(items.map((i) => i.transport_label ?? null)).toEqual(['Own Car', 'Other', null]);
  });

  it('GET /team labels each person from their own client\'s policy lookup, once per client', async () => {
    setUser({ id: ADMIN, org_id: ORG, role: 'admin', client_id: CA, name: 'Admin', email: 'admin@client.test' });
    __mock.setDefault('attendance', { data: [
      row({ id: 'a1', user_id: REP, transport_mode: 'own_bike' }),
      row({ id: 'a2', user_id: REP2, transport_mode: 'own_car' }),
      row({ id: 'a3', user_id: ADMIN }),
    ] });
    const res = await request(app).get('/attendance/team?f=2026-10-01&t=2026-10-31');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => [r.id, r.transport_label ?? null])).toEqual([['a1', 'Own Bike'], ['a2', 'Own Car'], ['a3', null]]);
    expect(chainsOn('expense_policies').filter((c) => c.eqs.org_id)).toHaveLength(1);
  });
});
