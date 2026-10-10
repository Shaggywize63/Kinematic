/**
 * Attendance rules over HTTP: the real attendance + org-settings routers (and the ffm punctuality handler) driven
 * against the chainable Supabase double. Covers the endpoints, the client-scope / tenancy rules, the jsonb merge
 * that must keep every other `clients.settings` key, the `late` key (only for configured clients), the summary
 * endpoint's scoping, and offline `captured_at` on check-in / check-out.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// Authenticated as whoever the test sets; role gates (requireRole / requireSupervisorOrAbove) stay REAL.
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
const orgSettingsRouter = require('../src/routes/org-settings.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/middleware/errorHandler') as { errorHandler: express.ErrorRequestHandler };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearClientFlagCache } = require('../src/lib/clientFlags') as { clearClientFlagCache: (id?: string | null) => void };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { attendancePunctuality } = require('../src/controllers/analytics/ffm-analytics.controller') as { attendancePunctuality: (req: any, res: any, next: any) => void };
import { istDateOf, computeLate } from '../src/services/attendanceRules.service';

const app = express();
app.use(express.json());
app.use('/attendance', attendanceRouter);
app.use('/org-settings', orgSettingsRouter);
app.use(errorHandler);

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
const CA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // configured client (rules + offline allowed)
const CB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // unconfigured (legacy) client
const CX = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // a client owned by ANOTHER org
const CO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';   // a client whose owner_org_id is our org
const CS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';   // client with supervisor-scope on
const ADMIN = '11111111-1111-4111-8111-111111111111';
const REP = '22222222-2222-4222-8222-222222222222';
const REP2 = '33333333-3333-4333-8333-333333333333';
const MGR_IDLE = '44444444-4444-4444-8444-444444444444';
const MGR_PUNCHED = '55555555-5555-4555-8555-555555555555';

const ist = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00+05:30`)).toISOString();

const RULES_A = { shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0], allow_offline_checkin: true };
let CLIENTS: Record<string, { id: string; org_id: string; owner_org_id?: string | null; settings: Record<string, unknown> | null }>;

const setUser = (u: Record<string, unknown>) => { (global as any).__testUser = u; };
const adminA = { id: ADMIN, org_id: ORG, role: 'admin', client_id: CA, name: 'Admin', email: 'admin@client.test' };
const orgAdmin = { id: ADMIN, org_id: ORG, role: 'admin', client_id: null, name: 'Org Admin', email: 'oa@client.test' };
const repA = { id: REP, org_id: ORG, role: 'field_executive', client_id: CA, name: 'Asha', email: 'asha@client.test' };
const repB = { id: REP, org_id: ORG, role: 'field_executive', client_id: CB, name: 'Asha', email: 'asha@client.test' };

const updatesOf = (table: string) => __mock.chainsFor(table).filter((c) => c.ops.some((o) => o.method === 'update'));
const payloadOf = (chain: { ops: Array<{ method: string; args: unknown[] }> }, method: string) =>
  chain.ops.find((o) => o.method === method)!.args[0] as Record<string, any>;

beforeEach(() => {
  __mock.reset();
  clearClientFlagCache();
  CLIENTS = {
    [CA]: { id: CA, org_id: ORG, owner_org_id: null, settings: { uses_supervisor_scope: false, app_ui: { tabs: ['home'] }, attendance_rules: { ...RULES_A } } },
    [CB]: { id: CB, org_id: ORG, owner_org_id: null, settings: { app_ui: { tabs: ['home'] } } },
    [CX]: { id: CX, org_id: OTHER_ORG, owner_org_id: OTHER_ORG, settings: {} },
    [CO]: { id: CO, org_id: OTHER_ORG, owner_org_id: ORG, settings: null },
    [CS]: { id: CS, org_id: ORG, owner_org_id: null, settings: { uses_supervisor_scope: true } },
  };
  // clients: select by id, update writes back (so a second PATCH sees the first).
  __mock.setDefault('clients', (chain) => {
    const id = String(chain.eqs.id);
    if (chain.ops.some((o) => o.method === 'update')) {
      const patch = payloadOf(chain, 'update');
      if (CLIENTS[id] && patch.settings) CLIENTS[id].settings = patch.settings;
      return { data: null };
    }
    const row = CLIENTS[id];
    if (!row) return { data: null };
    const sel = String(chain.ops.find((o) => o.method === 'select')?.args[0] ?? '');
    return { data: sel === 'settings' ? { settings: row.settings } : row };
  });
  setUser(adminA);
});

describe('PATCH/GET /org-settings/attendance-rules', () => {
  it('is admin-gated like the other org-settings routes', async () => {
    setUser(repA);
    expect((await request(app).get('/org-settings/attendance-rules')).status).toBe(403);
    expect((await request(app).patch('/org-settings/attendance-rules').send({ grace_minutes: 5 })).status).toBe(403);
    expect(updatesOf('clients')).toHaveLength(0);
  });

  it('GET returns the resolved rules, defaults and bounds for a configured client', async () => {
    const res = await request(app).get('/org-settings/attendance-rules');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      configured: true,
      rules: RULES_A,
      defaults: { shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0], allow_offline_checkin: false },
      bounds: { grace_minutes: { min: 0, max: 120 } },
    });
  });

  it('GET reports configured:false (with the defaults) for a client that has none', async () => {
    setUser({ ...adminA, client_id: CB });
    const res = await request(app).get('/org-settings/attendance-rules');
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.rules).toEqual(res.body.data.defaults);
  });

  it('answers 400 "Select a client first" when no client is in scope', async () => {
    setUser(orgAdmin);
    const get = await request(app).get('/org-settings/attendance-rules');
    expect(get.status).toBe(400);
    expect(get.body.error).toBe('Select a client first');
    const patch = await request(app).patch('/org-settings/attendance-rules').send({ grace_minutes: 5 });
    expect(patch.status).toBe(400);
    expect(patch.body.error).toBe('Select a client first');
    expect(updatesOf('clients')).toHaveLength(0);
  });

  it('PATCH merges into attendance_rules and keeps every OTHER settings key', async () => {
    setUser({ ...adminA, client_id: CB });
    const res = await request(app).patch('/org-settings/attendance-rules').send({ shift_start: '10:00', weekly_off: [6, 0] });
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(true);
    expect(res.body.data.rules).toEqual({ shift_start: '10:00', shift_end: '18:00', grace_minutes: 15, weekly_off: [0, 6], allow_offline_checkin: false });

    const [upd] = updatesOf('clients');
    expect(upd.eqs.id).toBe(CB);
    expect(payloadOf(upd, 'update').settings).toEqual({
      app_ui: { tabs: ['home'] },
      attendance_rules: { shift_start: '10:00', weekly_off: [0, 6] },
    });
  });

  it('PATCH keeps previously-saved rule keys (subset updates accumulate)', async () => {
    const res = await request(app).patch('/org-settings/attendance-rules').send({ grace_minutes: 5, allow_offline_checkin: false });
    expect(res.status).toBe(200);
    const [upd] = updatesOf('clients');
    expect(payloadOf(upd, 'update').settings).toEqual({
      uses_supervisor_scope: false,
      app_ui: { tabs: ['home'] },
      attendance_rules: { ...RULES_A, grace_minutes: 5, allow_offline_checkin: false },
    });
    const again = await request(app).get('/org-settings/attendance-rules');
    expect(again.body.data.rules).toMatchObject({ grace_minutes: 5, shift_start: '09:30', allow_offline_checkin: false });
  });

  it('PATCH rejects invalid values with 400 and writes NOTHING', async () => {
    for (const body of [{ grace_minutes: 500 }, { shift_start: '9:30' }, { weekly_off: [9] }, { allow_offline_checkin: 'yes' }, { shift_start: '10:00', grace_minutes: -3 }, {}, { bogus: 1 }]) {
      const res = await request(app).patch('/org-settings/attendance-rules').send(body);
      expect(res.status).toBe(400);
    }
    expect(updatesOf('clients')).toHaveLength(0);
  });

  it('PATCH clears the settings cache so the apps see the change at once', async () => {
    setUser(repA);
    expect((await request(app).get('/attendance/rules')).body.data.rules.grace_minutes).toBe(15);   // primes the cache
    setUser(adminA);
    await request(app).patch('/org-settings/attendance-rules').send({ grace_minutes: 40 });
    setUser(repA);
    expect((await request(app).get('/attendance/rules')).body.data.rules.grace_minutes).toBe(40);
  });

  describe('org admins picking a client with X-Client-Id', () => {
    beforeEach(() => setUser(orgAdmin));

    it('works for a client in the caller\'s org', async () => {
      const res = await request(app).patch('/org-settings/attendance-rules').set('X-Client-Id', CB).send({ grace_minutes: 10 });
      expect(res.status).toBe(200);
      expect(updatesOf('clients')[0].eqs.id).toBe(CB);
    });

    it('works for a client the caller\'s org OWNS (org-per-client)', async () => {
      const res = await request(app).patch('/org-settings/attendance-rules').set('X-Client-Id', CO).send({ grace_minutes: 10 });
      expect(res.status).toBe(200);
      expect(payloadOf(updatesOf('clients')[0], 'update').settings).toEqual({ attendance_rules: { grace_minutes: 10 } });
    });

    it('is a 404 for another org\'s client (no cross-tenant read or write)', async () => {
      const patch = await request(app).patch('/org-settings/attendance-rules').set('X-Client-Id', CX).send({ grace_minutes: 10 });
      expect(patch.status).toBe(404);
      expect((await request(app).get('/org-settings/attendance-rules').set('X-Client-Id', CX)).status).toBe(404);
      expect(updatesOf('clients')).toHaveLength(0);
    });

    it('lets the platform super_admin reach any client', async () => {
      setUser({ ...orgAdmin, role: 'super_admin' });
      expect((await request(app).get('/org-settings/attendance-rules').set('X-Client-Id', CX)).status).toBe(200);
    });

    it('is a 404 for an unknown client and 400 for a malformed header', async () => {
      expect((await request(app).get('/org-settings/attendance-rules').set('X-Client-Id', 'ffffffff-ffff-4fff-8fff-ffffffffffff')).status).toBe(404);
      const bad = await request(app).get('/org-settings/attendance-rules').set('X-Client-Id', 'not-a-uuid');
      expect(bad.status).toBe(400);
    });

    it('a client-pinned admin cannot escape via the header', async () => {
      setUser(adminA);
      const res = await request(app).get('/org-settings/attendance-rules').set('X-Client-Id', CB);
      expect(res.status).toBe(200);
      expect(res.body.data.configured).toBe(true);          // still client A's rules
    });
  });
});

describe('GET /attendance/rules (any authenticated user)', () => {
  it('returns the resolved rules for the caller\'s client — no admin-only extras', async () => {
    setUser(repA);
    const res = await request(app).get('/attendance/rules');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ configured: true, rules: RULES_A });
  });

  it('reports configured:false with defaults for a legacy client', async () => {
    setUser(repB);
    const res = await request(app).get('/attendance/rules');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      configured: false,
      rules: { shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0], allow_offline_checkin: false },
    });
  });

  it('is not an error for a user with no client in scope (unconfigured defaults)', async () => {
    setUser(orgAdmin);
    const res = await request(app).get('/attendance/rules');
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
  });

  it('is routed to the rules handler, not swallowed by a parameterised route', async () => {
    setUser(repA);
    const res = await request(app).get('/attendance/rules');
    expect(res.body.data).toHaveProperty('rules');
    expect(res.status).not.toBe(404);
  });
});

describe('`late` on attendance records', () => {
  const todayRow = (over: Record<string, unknown> = {}) => ({
    id: 'att-1', user_id: REP, client_id: CA, date: '2026-10-09', status: 'checked_in',
    checkin_at: ist('2026-10-09', '10:00'), checkout_at: null, total_hours: null, breaks: [], ...over,
  });

  it('GET /today adds late for a configured client', async () => {
    setUser(repA);
    __mock.setDefault('attendance', { data: [todayRow()] });
    const res = await request(app).get('/attendance/today');
    expect(res.status).toBe(200);
    expect(res.body.data.late).toEqual({ is_late: true, minutes_late: 30 });
  });

  it('GET /today: exactly shift_start+grace is on time (is_late false, 0 minutes)', async () => {
    setUser(repA);
    __mock.setDefault('attendance', { data: [todayRow({ checkin_at: ist('2026-10-09', '09:45') })] });
    const res = await request(app).get('/attendance/today');
    expect(res.body.data.late).toEqual({ is_late: false, minutes_late: 0 });
  });

  it('GET /today OMITS the key for a legacy (unconfigured) client', async () => {
    setUser(repB);
    __mock.setDefault('attendance', { data: [todayRow({ client_id: CB })] });
    const res = await request(app).get('/attendance/today');
    expect(res.status).toBe(200);
    expect(res.body.data.checkin_at).toBeTruthy();
    expect('late' in res.body.data).toBe(false);
  });

  it('omits the key on a record with no check-in (e.g. a leave placeholder)', async () => {
    setUser(repA);
    __mock.setDefault('attendance', { data: [todayRow({ status: 'on_leave', checkin_at: null })] });
    const res = await request(app).get('/attendance/today');
    expect('late' in res.body.data).toBe(false);
  });

  it('falls back to the caller\'s client for a row that has no client_id', async () => {
    setUser(repA);
    __mock.setDefault('attendance', { data: [todayRow({ client_id: null })] });
    const res = await request(app).get('/attendance/today');
    expect(res.body.data.late).toEqual({ is_late: true, minutes_late: 30 });
  });

  it('GET /today with no record at all is still null', async () => {
    setUser(repA);
    __mock.setDefault('attendance', { data: [] });
    const res = await request(app).get('/attendance/today');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('GET /history annotates every item (both the items[] and the legacy data[] shapes)', async () => {
    setUser(repA);
    __mock.setDefault('attendance', {
      data: [todayRow({ id: 'a1' }), todayRow({ id: 'a2', date: '2026-10-08', checkin_at: ist('2026-10-08', '09:00') }), todayRow({ id: 'a3', checkin_at: null, status: 'absent' })],
      count: 3,
    });
    const res = await request(app).get('/attendance/history');
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items[0].late).toEqual({ is_late: true, minutes_late: 30 });
    expect(items[1].late).toEqual({ is_late: false, minutes_late: 0 });
    expect('late' in items[2]).toBe(false);
    expect(res.body.data.data[0].late).toEqual({ is_late: true, minutes_late: 30 });   // same objects
  });

  it('GET /team applies each row\'s OWN client rules (a mixed-client list)', async () => {
    setUser(adminA);
    __mock.setDefault('attendance', {
      data: [
        todayRow({ id: 'a1', client_id: CA }),
        todayRow({ id: 'a2', client_id: CB, user_id: REP2 }),
        todayRow({ id: 'a3', client_id: CA, user_id: REP2, checkin_at: null, status: 'absent' }),
      ],
    });
    const res = await request(app).get('/attendance/team?from=2026-10-09&to=2026-10-09');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((r: any) => [r.id, r]));
    expect(byId.a1.late).toEqual({ is_late: true, minutes_late: 30 });
    expect('late' in byId.a2).toBe(false);          // legacy client row
    expect('late' in byId.a3).toBe(false);          // no check-in
  });
});

describe('POST /attendance/checkin and /checkout with captured_at (offline capture)', () => {
  const GEO = { latitude: 18.52, longitude: 73.85 };
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const istDay = (iso: string) => istDateOf(iso)!;

  /** attendance: lookups find nothing; the upsert echoes its payload back as the saved row. */
  function stubCheckin() {
    __mock.setDefault('attendance', (chain) => {
      const up = chain.ops.find((o) => o.method === 'upsert');
      if (up) return { data: { id: 'att-new', breaks: [], ...(up.args[0] as object) } };
      return { data: [] };
    });
  }
  const savedCheckinAt = () => {
    const up = __mock.chainsFor('attendance').find((c) => c.ops.some((o) => o.method === 'upsert'))!;
    return payloadOf(up, 'upsert').checkin_at as string;
  };
  const closeToNow = (iso: string) => Math.abs(Date.parse(iso) - Date.now()) < 15_000;
  const usersLivePositionWrites = () => updatesOf('users');

  beforeEach(() => { setUser(repA); stubCheckin(); });

  it('honours captured_at when the client allows it, an Idempotency-Key is sent and the IST date matches', async () => {
    const captured = minutesAgo(20);
    const res = await request(app).post(`/attendance/checkin?date=${istDay(captured)}`)
      .set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(res.status).toBe(201);
    expect(savedCheckinAt()).toBe(captured);
    expect(res.body.data.checkin_at).toBe(captured);
  });

  it('a backdated (offline-synced) check-in does NOT overwrite the rep\'s live position', async () => {
    const captured = minutesAgo(20);
    await request(app).post(`/attendance/checkin?date=${istDay(captured)}`).set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(usersLivePositionWrites()).toHaveLength(0);
  });

  it('a fresh captured_at (within minutes) still refreshes the live position', async () => {
    const captured = minutesAgo(1);
    await request(app).post(`/attendance/checkin?date=${istDay(captured)}`).set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(savedCheckinAt()).toBe(captured);
    expect(usersLivePositionWrites()).toHaveLength(1);
  });

  it('stamps late info from the captured time (what the stored checkin_at says)', async () => {
    const captured = minutesAgo(20);
    const res = await request(app).post(`/attendance/checkin?date=${istDay(captured)}`).set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(res.body.data.late).toEqual(computeLate(captured, RULES_A));
  });

  it('IGNORES captured_at without an Idempotency-Key (server time is used)', async () => {
    const captured = minutesAgo(20);
    const res = await request(app).post(`/attendance/checkin?date=${istDay(captured)}`).send({ ...GEO, captured_at: captured });
    expect(res.status).toBe(201);
    expect(closeToNow(savedCheckinAt())).toBe(true);
    expect(savedCheckinAt()).not.toBe(captured);
  });

  it('IGNORES captured_at for a client that has not allowed offline check-in', async () => {
    setUser(repB);
    const captured = minutesAgo(20);
    const res = await request(app).post(`/attendance/checkin?date=${istDay(captured)}`).set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(res.status).toBe(201);
    expect(closeToNow(savedCheckinAt())).toBe(true);
    expect('late' in res.body.data).toBe(false);          // and a legacy client still gets no late key
  });

  it('IGNORES captured_at when the rule is explicitly false', async () => {
    CLIENTS[CA].settings = { attendance_rules: { ...RULES_A, allow_offline_checkin: false } };
    clearClientFlagCache();
    const captured = minutesAgo(20);
    await request(app).post(`/attendance/checkin?date=${istDay(captured)}`).set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(closeToNow(savedCheckinAt())).toBe(true);
  });

  it.each([
    ['in the future', () => new Date(Date.now() + 10 * 60_000).toISOString()],
    ['older than 36 h', () => minutesAgo(37 * 60)],
    ['not a timestamp', () => 'half past nine'],
    ['without a zone', () => '2026-10-09T10:00:00'],
  ])('IGNORES a captured_at that is %s', async (_label, make) => {
    const captured = make();
    const res = await request(app).post(`/attendance/checkin?date=${istDay(new Date().toISOString())}`).set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(res.status).toBe(201);
    expect(closeToNow(savedCheckinAt())).toBe(true);
  });

  it('IGNORES captured_at whose IST date differs from the attendance date being written', async () => {
    const captured = minutesAgo(30 * 60);                       // 30 h ago: always a different IST day than today
    const res = await request(app).post('/attendance/checkin').set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(res.status).toBe(201);
    expect(closeToNow(savedCheckinAt())).toBe(true);            // no ?date -> today
  });

  it('honours a previous-day captured_at when the app writes that day (?date=)', async () => {
    const captured = minutesAgo(30 * 60);
    const res = await request(app).post(`/attendance/checkin?date=${istDay(captured)}`).set('Idempotency-Key', 'key-1').send({ ...GEO, captured_at: captured });
    expect(res.status).toBe(201);
    expect(savedCheckinAt()).toBe(captured);
  });

  it('is unchanged for a plain check-in (no captured_at): server time, no behaviour change', async () => {
    const res = await request(app).post('/attendance/checkin').send(GEO);
    expect(res.status).toBe(201);
    expect(closeToNow(savedCheckinAt())).toBe(true);
    expect(usersLivePositionWrites()).toHaveLength(1);
  });

  describe('check-out', () => {
    const checkinAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const open = { id: 'att-open', user_id: REP, client_id: CA, date: istDateOf(Date.now()), status: 'checked_in', checkin_at: checkinAt, break_minutes: 0 };

    function stubCheckout() {
      __mock.setDefault('attendance', (chain) => {
        const up = chain.ops.find((o) => o.method === 'update');
        if (up) return { data: { ...open, breaks: [], ...(up.args[0] as object) } };
        return { data: [open] };
      });
    }
    const savedCheckoutAt = () => payloadOf(updatesOf('attendance')[0], 'update').checkout_at as string;

    beforeEach(stubCheckout);

    it('honours captured_at and computes hours from it', async () => {
      const captured = minutesAgo(10);
      const res = await request(app).post('/attendance/checkout').set('Idempotency-Key', 'k-out').send({ ...GEO, captured_at: captured });
      expect(res.status).toBe(200);
      expect(savedCheckoutAt()).toBe(captured);
      const minutes = Math.round((Date.parse(captured) - Date.parse(checkinAt)) / 60_000);
      expect(payloadOf(updatesOf('attendance')[0], 'update').working_minutes).toBe(minutes);
      expect(updatesOf('users')).toHaveLength(0);                  // 10 min back is "backdated": the live position is not blanked
    });

    it('IGNORES a captured_at that is earlier than the check-in', async () => {
      const captured = minutesAgo(4 * 60);
      await request(app).post('/attendance/checkout').set('Idempotency-Key', 'k-out').send({ ...GEO, captured_at: captured });
      expect(closeToNow(savedCheckoutAt())).toBe(true);
    });

    it('IGNORES captured_at without an Idempotency-Key or for a legacy client', async () => {
      await request(app).post('/attendance/checkout').send({ ...GEO, captured_at: minutesAgo(10) });
      expect(closeToNow(savedCheckoutAt())).toBe(true);
      __mock.reset();
      stubCheckout();
      setUser(repB);
      await request(app).post('/attendance/checkout').set('Idempotency-Key', 'k-out').send({ ...GEO, captured_at: minutesAgo(10) });
      expect(closeToNow(savedCheckoutAt())).toBe(true);
    });

    it('a plain check-out is unchanged (server time, live position cleared)', async () => {
      const res = await request(app).post('/attendance/checkout').send(GEO);
      expect(res.status).toBe(200);
      expect(closeToNow(savedCheckoutAt())).toBe(true);
      expect(updatesOf('users')).toHaveLength(1);
    });
  });
});

describe('GET /attendance/summary', () => {
  const Q = 'from=2026-09-01&to=2026-09-14';        // wholly in the past -> independent of "today"
  const user = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) =>
    ({ id, name, role, client_id: CA, created_at: '2026-01-01T00:00:00Z', org_role: null, ...extra });
  const att = (user_id: string, date: string, status: string, hhmm?: string) => ({ user_id, date, status, checkin_at: hhmm ? ist(date, hhmm) : null });

  beforeEach(() => {
    __mock.setDefault('users', {
      data: [
        user(REP, 'Asha', 'field_executive'),
        user(REP2, 'Bala', 'executive'),
        user(MGR_IDLE, 'Idle Manager', 'admin'),
        user(MGR_PUNCHED, 'Manager Punch', 'sub_admin'),
      ],
    });
    __mock.setDefault('attendance', {
      data: [
        att(REP, '2026-09-01', 'checked_out', '09:30'),
        att(REP, '2026-09-02', 'checked_out', '09:50'),
        att(MGR_PUNCHED, '2026-09-01', 'checked_out', '09:00'),
      ],
    });
    __mock.setDefault('leave_requests', {
      data: [{ user_id: REP2, from_date: '2026-09-02', to_date: '2026-09-03', half_day_start: false, half_day_end: false }],
    });
  });

  it('returns the contract shape for a manager: team rows, field reps + anyone who punched', async () => {
    const res = await request(app).get(`/attendance/summary?${Q}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      from: '2026-09-01', to: '2026-09-14', working_days: 12,
      rows: [
        { user_id: REP, name: 'Asha', working_days: 12, present: 2, late: 1, half_day: 0, on_leave: 0, absent: 10 },
        { user_id: REP2, name: 'Bala', working_days: 12, present: 0, late: 0, half_day: 0, on_leave: 2, absent: 10 },
        { user_id: MGR_PUNCHED, name: 'Manager Punch', working_days: 12, present: 1, late: 0, half_day: 0, on_leave: 0, absent: 11 },
      ],
    });
    expect(res.body.data.rows.map((r: any) => r.user_id)).not.toContain(MGR_IDLE);
  });

  it('scopes the roster like the team list: caller\'s org + client, active, not deleted', async () => {
    await request(app).get(`/attendance/summary?${Q}`);
    const usersChain = __mock.chainsFor('users')[0];
    expect(usersChain.eqs).toMatchObject({ org_id: ORG, client_id: CA, is_active: true });
    expect(usersChain.ops.some((o) => o.method === 'is' && o.args[0] === 'deleted_at' && o.args[1] === null)).toBe(true);
  });

  it('reads leave from approved leave_requests overlapping the range, for the roster only', async () => {
    await request(app).get(`/attendance/summary?${Q}`);
    const leave = __mock.chainsFor('leave_requests')[0];
    expect(leave.eqs.status).toBe('approved');
    expect(leave.ops.some((o) => o.method === 'in' && o.args[0] === 'user_id')).toBe(true);
    expect(leave.ops.some((o) => o.method === 'lte' && o.args[0] === 'from_date')).toBe(true);
    expect(leave.ops.some((o) => o.method === 'gte' && o.args[0] === 'to_date' && o.args[1] === '2026-09-01')).toBe(true);
  });

  it('uses the client\'s weekly_off', async () => {
    CLIENTS[CA].settings = { attendance_rules: { weekly_off: [0, 6] } };
    clearClientFlagCache();
    const res = await request(app).get(`/attendance/summary?${Q}`);
    expect(res.body.data.working_days).toBe(10);
    expect(res.body.data.rows[0].working_days).toBe(10);
  });

  it('a rep only ever gets themself', async () => {
    setUser(repA);
    __mock.setDefault('users', { data: [user(REP, 'Asha', 'field_executive')] });
    const res = await request(app).get(`/attendance/summary?${Q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].user_id).toBe(REP);
    expect(__mock.chainsFor('users')[0].eqs.id).toBe(REP);
  });

  it('a rep may pass their own user_id but not someone else\'s', async () => {
    setUser(repA);
    __mock.setDefault('users', { data: [user(REP, 'Asha', 'field_executive')] });
    expect((await request(app).get(`/attendance/summary?${Q}&user_id=${REP}`)).status).toBe(200);
    expect((await request(app).get(`/attendance/summary?${Q}&user_id=${REP2}`)).status).toBe(403);
  });

  it('a manager can narrow to one user', async () => {
    __mock.setDefault('users', { data: [user(REP, 'Asha', 'field_executive')] });
    const res = await request(app).get(`/attendance/summary?${Q}&user_id=${REP}`);
    expect(res.status).toBe(200);
    expect(__mock.chainsFor('users')[0].eqs.id).toBe(REP);
    expect(res.body.data.rows).toHaveLength(1);
  });

  it('applies the supervisor-hierarchy scope exactly like the team list', async () => {
    // client CS opted in; the caller is a team-scope manager -> only their subtree (here: themself)
    setUser({ ...adminA, client_id: CS, org_role_data_scope: 'own' });
    await request(app).get(`/attendance/summary?${Q}`);
    const usersChain = __mock.chainsFor('users')[0];
    expect(usersChain.ops.some((o) => o.method === 'in' && o.args[0] === 'id' && JSON.stringify(o.args[1]) === JSON.stringify([ADMIN]))).toBe(true);
  });

  it('validates the range and user_id (400)', async () => {
    for (const qs of [
      '', 'from=2026-09-01', 'to=2026-09-30', 'from=2026-9-1&to=2026-09-30', 'from=2026-09-30&to=2026-09-01',
      'from=2026-07-01&to=2026-09-01',                       // 63 days
      `${Q}&user_id=not-a-uuid`,
    ]) {
      const res = await request(app).get(`/attendance/summary?${qs}`);
      expect(res.status).toBe(400);
    }
    expect((await request(app).get('/attendance/summary?from=2026-07-01&to=2026-08-31')).status).toBe(200);   // 62 days
  });

  it('refuses a picked client that belongs to another org (404), but serves the caller\'s own', async () => {
    setUser(orgAdmin);
    expect((await request(app).get(`/attendance/summary?${Q}`).set('X-Client-Id', CX)).status).toBe(404);
    expect((await request(app).get(`/attendance/summary?${Q}`).set('X-Client-Id', CA)).status).toBe(200);
  });

  it('paginates attendance reads past PostgREST\'s 1000-row page', async () => {
    const page = Array.from({ length: 1000 }, (_v, i) => att(REP, '2026-09-01', 'checked_out', '09:00'));
    __mock.queue('attendance', { data: page });
    __mock.queue('attendance', { data: [att(REP, '2026-09-02', 'checked_out', '09:00')] });
    const res = await request(app).get(`/attendance/summary?${Q}`);
    expect(res.status).toBe(200);
    const ranges = __mock.chainsFor('attendance').map((c) => c.ops.find((o) => o.method === 'range')?.args);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(res.body.data.rows.find((r: any) => r.user_id === REP).present).toBe(2);      // 09-01 and 09-02 (dupes collapse)
  });
});

describe('ffm attendance-punctuality uses the client rules when configured', () => {
  const run = async () => {
    const out = await new Promise<any>((resolve, reject) => {
      const res: any = { status: () => res, json: (b: any) => resolve(b) };
      attendancePunctuality({ user: { id: ADMIN, org_id: ORG, role: 'admin', client_id: null } }, res, reject);
    });
    return Object.fromEntries(out.data.map((r: any) => [r.fe_id, r]));
  };
  const row = (user_id: string, client_id: string | null, status: string, hhmm?: string) => ({ user_id, client_id, status, checkin_at: hhmm ? ist('2026-10-05', hhmm) : null });

  beforeEach(() => {
    __mock.setDefault('users', { data: [{ id: REP, name: 'Asha' }, { id: REP2, name: 'Bala' }] });
  });

  it('configured client: late = after shift_start + grace; legacy client: before 10:00 IST is on time', async () => {
    CLIENTS[CA].settings = { attendance_rules: { shift_start: '10:00', grace_minutes: 30 } };      // late after 10:30
    __mock.setDefault('attendance', {
      data: [
        row(REP, CA, 'checked_out', '10:20'),     // on time under CA's rules (legacy would say late)
        row(REP, CA, 'checked_out', '10:31'),     // late
        row(REP2, CB, 'checked_out', '09:59'),    // legacy on time
        row(REP2, CB, 'checked_out', '10:10'),    // legacy late
        row(REP2, CB, 'absent'),
      ],
    });
    const out = await run();
    expect(out[REP]).toMatchObject({ on_time: 1, late: 1, absent: 0 });
    expect(out[REP2]).toMatchObject({ on_time: 1, late: 1, absent: 1 });
  });

  it('with no client configured the result is exactly the legacy 10:00 IST split', async () => {
    __mock.setDefault('attendance', {
      data: [row(REP, CB, 'checked_out', '09:59'), row(REP, CB, 'checked_out', '10:00'), row(REP, null, 'checked_out', '09:00'), row(REP2, CB, 'checked_out', '11:00')],
    });
    const out = await run();
    expect(out[REP]).toMatchObject({ on_time: 2, late: 1, absent: 0 });
    expect(out[REP2]).toMatchObject({ on_time: 0, late: 1, absent: 0 });
  });
});
