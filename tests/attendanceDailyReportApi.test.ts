/**
 * GET /api/v1/attendance/daily-report and /daily-report/team over HTTP: the real attendance router against the
 * chainable Supabase double. Covers the response shapes, defaults and validation, who may look at whose day
 * (a rep only themself; a manager inside the org / picked client / supervisor subtree - the team attendance
 * list's scoping), that the queries are pinned to the right user and org, and the team table's rules (managers
 * only, people without a shift skipped, 300 cap). The maths itself is tests/travel.test.ts, the assembly is
 * tests/dailyReport.test.ts.
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
const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb';
const CA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CX = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // belongs to ANOTHER org
const CS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';   // supervisor-scope opted in
const REP = '22222222-2222-4222-8222-222222222222';
const REP2 = '33333333-3333-4333-8333-333333333333';
const REP3 = '44444444-4444-4444-8444-444444444444';
const MGR = '11111111-1111-4111-8111-111111111111';
const DATE = '2026-10-09';

const ist = (hhmm: string) => new Date(Date.parse(`${DATE}T${hhmm}:00+05:30`)).toISOString();
const setUser = (u: Record<string, unknown>) => { (global as any).__testUser = u; };
const rep = { id: REP, org_id: ORG, role: 'field_executive', client_id: CA, name: 'Asha (token)', email: 'asha@client.test' };
const manager = { id: MGR, org_id: ORG, role: 'admin', client_id: CA, name: 'Meera', email: 'meera@client.test' };
const orgAdmin = { id: MGR, org_id: ORG, role: 'admin', client_id: null, name: 'Org Admin', email: 'oa@client.test' };
const superAdmin = { id: MGR, org_id: ORG, role: 'super_admin', client_id: null, name: 'Root', email: 'root@client.test' };

const P = (k: number): [number, number] => [13.0 + 0.01 * k, 80.2];
const ATT = (over: Record<string, unknown> = {}) => ({
  id: 'att-1', user_id: REP, org_id: ORG, client_id: CA, date: DATE, status: 'checked_out',
  checkin_at: ist('09:30'), checkout_at: ist('18:00'), total_hours: 8.5, break_minutes: 0, transport_mode: null,
  checkin_lat: P(0)[0], checkin_lng: P(0)[1], checkout_lat: P(0)[0], checkout_lng: P(0)[1],
  ...over,
});
const fix = (hhmm: string, p: [number, number]) => ({ lat: p[0], lng: p[1], captured_at: ist(hhmm), is_mock: false, is_suspect: false, activity_type: 'HEARTBEAT' });
// A 30-minute stop at P(2) (09:50-10:20), a customer visit at P(4) 11:00-11:20, then home.
const TRAIL = [
  fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(2)), fix('10:10', P(2)), fix('10:20', P(2)),
  fix('10:40', P(3)), fix('11:00', P(4)), fix('11:10', P(4)), fix('11:20', P(4)), fix('11:40', P(5)),
];
const VISIT = { id: 'sub-1', check_in_at: ist('11:00'), check_out_at: ist('11:20'), check_in_gps: `${P(4)[0]},${P(4)[1]}`, check_out_gps: `${P(4)[0]},${P(4)[1]}`, builder_forms: { title: 'Customer Visit' } };

const chainsOn = (table: string) => __mock.chainsFor(table);
let CLIENTS: Record<string, { id: string; org_id: string; owner_org_id?: string | null; settings: Record<string, unknown> }>;
let userRows: Record<string, Record<string, unknown>>;

beforeEach(() => {
  __mock.reset();
  clearClientFlagCache();
  CLIENTS = {
    [CA]: { id: CA, org_id: ORG, owner_org_id: null, settings: {} },
    [CX]: { id: CX, org_id: OTHER_ORG, owner_org_id: OTHER_ORG, settings: {} },
    [CS]: { id: CS, org_id: ORG, owner_org_id: null, settings: { uses_supervisor_scope: true } },
  };
  userRows = {
    [REP]: { id: REP, name: 'Asha', employee_id: 'EF-001', role: 'field_executive', client_id: CA },
    [REP2]: { id: REP2, name: 'Bala', employee_id: 'EF-002', role: 'field_executive', client_id: CA },
    [REP3]: { id: REP3, name: 'Chitra', employee_id: 'EF-003', role: 'field_executive', client_id: CA },
  };
  __mock.setDefault('clients', (chain) => {
    const row = CLIENTS[String(chain.eqs.id)];
    if (!row) return { data: null };
    const sel = String(chain.ops.find((o) => o.method === 'select')?.args[0] ?? '');
    return { data: sel === 'settings' ? { settings: row.settings } : row };
  });
  __mock.setDefault('users', (chain) => ({ data: userRows[String(chain.eqs.id)] ?? [] }));
  __mock.setDefault('attendance', (chain) => ({ data: chain.eqs.date === DATE ? [ATT({ user_id: chain.eqs.user_id ?? REP })] : [] }));
  __mock.setDefault('work_activity', { data: TRAIL });
  __mock.setDefault('form_submissions', { data: [VISIT] });
  __mock.setDefault('builder_submissions', { data: [] });
  setUser(rep);
});

describe('GET /attendance/daily-report', () => {
  it('defaults to today (IST) and the caller; a day without attendance is a 200 with empty arrays and attendance_id null', async () => {
    const res = await request(app).get('/attendance/daily-report');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      date: istDateOf(Date.now()),
      user: { id: REP, name: 'Asha', employee_id: 'EF-001', role: 'field_executive' },
      shift: { attendance_id: null, checkin_at: null, checkout_at: null, total_hours: null, in_progress: false },
      transport: { mode: null, label: null },
      travel: { total_km: 0, method: 'none', legs: [] },
      visits: [], halts: [],
      route: { points: [], thinned: false },
      summary: { visits: 0, visit_minutes: 0, halts: 0, halt_minutes: 0, total_km: 0 },
    });
    expect(chainsOn('attendance')[0].eqs).toMatchObject({ user_id: REP, date: istDateOf(Date.now()) });
    expect(chainsOn('work_activity')).toHaveLength(0);
    expect(chainsOn('form_submissions')).toHaveLength(0);
  });

  it('returns the contract shape for a real day: shift, transport, travel, visits, halts, route, summary', async () => {
    __mock.setDefault('attendance', { data: [ATT({ transport_mode: 'public_transport' })] });
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Object.keys(d)).toEqual(['date', 'user', 'shift', 'transport', 'travel', 'visits', 'halts', 'route', 'summary']);
    expect(d.date).toBe(DATE);
    expect(d.user).toEqual({ id: REP, name: 'Asha', employee_id: 'EF-001', role: 'field_executive' });
    expect(d.shift).toEqual({ attendance_id: 'att-1', checkin_at: ist('09:30'), checkout_at: ist('18:00'), total_hours: 8.5, in_progress: false });
    expect(d.transport).toEqual({ mode: 'public_transport', label: 'Public transport' });
    expect(d.travel.method).toBe('mixed');           // the legs with 2+ fixes ride the trail; the one with a single fix falls back to the straight line
    expect(d.travel.legs).toHaveLength(2);
    expect(d.travel.total_km).toBeGreaterThan(0);
    expect(d.visits).toEqual([{ submission_id: 'sub-1', label: 'Customer Visit', arrival_at: ist('11:00'), departure_at: ist('11:20'), minutes: 20, lat: P(4)[0], lng: P(4)[1] }]);
    expect(d.halts).toHaveLength(1);
    expect(d.halts[0]).toMatchObject({ index: 0, start_at: ist('09:50'), end_at: ist('10:20'), minutes: 30, lat: P(2)[0], lng: P(2)[1] });
    expect(d.route.thinned).toBe(false);
    expect(d.route.points[0]).toEqual({ lat: P(0)[0], lng: P(0)[1], at: ist('09:30') });
    expect(d.route.points[d.route.points.length - 1]).toMatchObject({ at: ist('18:00') });
    expect(d.summary).toEqual({ visits: 1, visit_minutes: 20, halts: 1, halt_minutes: 30, total_km: d.travel.total_km });
  });

  it('is the same computation as GET /travel (km, halts, stops agree)', async () => {
    const report = (await request(app).get(`/attendance/daily-report?date=${DATE}`)).body.data;
    const travel = (await request(app).get(`/attendance/travel?date=${DATE}`)).body.data;
    expect(report.travel.total_km).toBe(travel.total_km);
    expect(report.travel.legs).toEqual(travel.legs);
    expect(report.halts).toEqual(travel.halts);
    expect(report.visits.map((v: any) => v.submission_id)).toEqual(travel.stops.map((s: any) => s.submission_id));
  });

  it('reads the whole attendance row (so total_hours / transport_mode come along) and pins the GPS trail to the org', async () => {
    await request(app).get(`/attendance/daily-report?date=${DATE}`);
    const sel = chainsOn('attendance')[0].ops.find((o) => o.method === 'select')!.args[0];
    expect(sel).toBe('*');
    expect(chainsOn('attendance')).toHaveLength(1);
    expect(chainsOn('work_activity')[0].eqs).toMatchObject({ user_id: REP, org_id: ORG });
    for (const table of ['form_submissions', 'builder_submissions']) expect(chainsOn(table)[0].eqs).toMatchObject({ user_id: REP });
  });

  it('labels a vehicle mode from the person\'s expense policy', async () => {
    __mock.setDefault('attendance', { data: [ATT({ transport_mode: 'own_bike' })] });
    __mock.setDefault('expense_policies', (chain) => chain.eqs.org_id
      ? { data: [{ id: 'p1', name: 'Field', is_active: true, priority: 1, currency: 'INR', client_id: null, applies_to: { everyone: true, roles: [], org_role_ids: [], user_ids: [] }, rules: { vehicle_rates: [{ id: 'own_bike', label: 'Two-wheeler (bike)', rate_per_km: 4 }] } }] }
      : { data: [] });
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}`);
    expect(res.body.data.transport).toEqual({ mode: 'own_bike', label: 'Two-wheeler (bike)' });
  });

  it('a fixed mode needs no policy read', async () => {
    __mock.setDefault('attendance', { data: [ATT({ transport_mode: 'other' })] });
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}`);
    expect(res.body.data.transport).toEqual({ mode: 'other', label: 'Other' });
    expect(chainsOn('expense_policies')).toHaveLength(0);
  });

  it('honours min_halt_minutes (clamped 3..120)', async () => {
    const tight = await request(app).get(`/attendance/daily-report?date=${DATE}&min_halt_minutes=45`);
    expect(tight.body.data.halts).toEqual([]);
    const loose = await request(app).get(`/attendance/daily-report?date=${DATE}&min_halt_minutes=1`);   // clamped to 3
    expect(loose.body.data.halts.length).toBeGreaterThanOrEqual(1);
    const travel = await request(app).get(`/attendance/travel?date=${DATE}&min_halt_minutes=45`);
    expect(travel.body.data.halts).toEqual([]);
  });

  it('rejects a malformed date, user_id or min_halt_minutes with 400 and reads nothing', async () => {
    for (const q of ['date=2026-13-45', 'date=09-10-2026', 'date=yesterday', 'user_id=not-a-uuid', 'min_halt_minutes=abc', 'min_halt_minutes=10&min_halt_minutes=20']) {
      const res = await request(app).get(`/attendance/daily-report?${q}`);
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('is routed to its handler (not swallowed by a parameterised route)', async () => {
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}`);
    expect(res.status).not.toBe(404);
    expect(res.body.data).toHaveProperty('route');
  });

  it('a demo user gets an empty report and no database reads', async () => {
    setUser({ ...rep, org_id: DEMO_ORG_ID });
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.data.shift.attendance_id).toBeNull();
    expect(chainsOn('attendance')).toHaveLength(0);
    expect(chainsOn('users')).toHaveLength(0);
  });
});

describe('whose day may be read', () => {
  it('a rep may pass their own user_id', async () => {
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(REP);
  });

  it('a rep gets 403 for anyone else and nothing is read', async () => {
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(403);
    expect(chainsOn('attendance')).toHaveLength(0);
    expect(chainsOn('work_activity')).toHaveLength(0);
  });

  it('a manager reads a team member inside their org and client', async () => {
    setUser(manager);
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual({ id: REP2, name: 'Bala', employee_id: 'EF-002', role: 'field_executive' });
    expect(chainsOn('users')[0].eqs).toMatchObject({ id: REP2, org_id: ORG, client_id: CA });
    expect(chainsOn('attendance')[0].eqs).toMatchObject({ user_id: REP2, date: DATE });
    expect(chainsOn('work_activity')[0].eqs).toMatchObject({ user_id: REP2, org_id: ORG });
  });

  it('a manager asking for someone outside their scope gets 404 and no data is read', async () => {
    setUser(manager);
    userRows = {};
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(404);
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('a manager without a client in the JWT may not borrow another org\'s client via X-Client-Id', async () => {
    setUser(orgAdmin);
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP2}`).set('X-Client-Id', CX);
    expect(res.status).toBe(404);
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('an org-level manager with no client picked is held to their own org', async () => {
    setUser(orgAdmin);
    const res = await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(200);
    expect(chainsOn('users')[0].eqs).toMatchObject({ id: REP2, org_id: ORG });
    expect('client_id' in chainsOn('users')[0].eqs).toBe(false);
    expect(chainsOn('work_activity')[0].eqs).toMatchObject({ org_id: ORG });
  });

  it('applies the supervisor-hierarchy scope exactly like the team list', async () => {
    setUser({ ...manager, client_id: CS, org_role_data_scope: 'own' });
    userRows = { [MGR]: { id: MGR, name: 'Meera', employee_id: 'EF-100', role: 'admin', client_id: CS } };
    await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP2}`);
    const lookup = chainsOn('users')[0];
    expect(lookup.ops.some((o) => o.method === 'in' && o.args[0] === 'id' && JSON.stringify(o.args[1]) === JSON.stringify([MGR]))).toBe(true);
  });
});

describe('GET /attendance/daily-report/team', () => {
  const teamRows = () => [
    ATT({ id: 'a-bala', user_id: REP2, users: { name: 'Bala', employee_id: 'EF-002', role: 'field_executive' }, transport_mode: 'public_transport', total_hours: 7 }),
    ATT({ id: 'a-asha', user_id: REP, users: { name: 'Asha', employee_id: 'EF-001', role: 'field_executive' } }),
    ATT({ id: 'a-open', user_id: REP3, users: [{ name: 'Chitra', employee_id: 'EF-003', role: 'field_executive' }], status: 'checked_in', checkout_at: null, total_hours: null }),
  ];

  beforeEach(() => {
    setUser(manager);
    __mock.setDefault('attendance', (chain) => {
      if (chain.eqs.date !== DATE) return { data: [] };
      return { data: chain.eqs.user_id ? teamRows().filter((r) => r.user_id === chain.eqs.user_id) : teamRows() };    // team query, or one person's
    });
    // Only Asha has the visit and the trail: everyone else is a quiet day.
    __mock.setDefault('work_activity', (chain) => ({ data: chain.eqs.user_id === REP ? TRAIL : [] }));
    __mock.setDefault('form_submissions', (chain) => ({ data: chain.eqs.user_id === REP ? [VISIT] : [] }));
  });

  it('is for managers only (a rep gets 403 and nothing is read)', async () => {
    setUser(rep);
    const res = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(res.status).toBe(403);
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('returns { date, rows } - one row per person with a shift, sorted by name, with the contract fields', async () => {
    const res = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data)).toEqual(['date', 'rows']);
    expect(res.body.data.date).toBe(DATE);
    const rows = res.body.data.rows;
    expect(rows.map((r: any) => r.name)).toEqual(['Asha', 'Bala', 'Chitra']);
    expect(Object.keys(rows[0])).toEqual(['user_id', 'name', 'employee_id', 'checkin_at', 'checkout_at', 'total_hours', 'mode', 'label', 'total_km', 'visits', 'visit_minutes', 'halts', 'halt_minutes']);
    expect(rows[0]).toMatchObject({
      user_id: REP, name: 'Asha', employee_id: 'EF-001', checkin_at: ist('09:30'), checkout_at: ist('18:00'), total_hours: 8.5,
      mode: null, label: null, visits: 1, visit_minutes: 20, halts: 1, halt_minutes: 30,
    });
    expect(rows[0].total_km).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ user_id: REP2, mode: 'public_transport', label: 'Public transport', total_hours: 7, visits: 0, halts: 0, total_km: expect.any(Number) });
    expect(rows[2]).toMatchObject({ user_id: REP3, name: 'Chitra', checkout_at: null });    // the joined users row may be an array
  });

  it('shows the same numbers as each person\'s own daily report', async () => {
    const team = (await request(app).get(`/attendance/daily-report/team?date=${DATE}`)).body.data.rows.find((r: any) => r.user_id === REP);
    const single = (await request(app).get(`/attendance/daily-report?date=${DATE}&user_id=${REP}`)).body.data;
    expect(team).toMatchObject({ total_km: single.travel.total_km, ...single.summary, total_hours: single.shift.total_hours });
  });

  it('scopes the attendance query like the team list: this date, the caller\'s org and client, only people who checked in, capped at 300', async () => {
    await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    const q = chainsOn('attendance')[0];
    expect(q.eqs).toMatchObject({ date: DATE, org_id: ORG, client_id: CA });
    expect(q.ops.some((o) => o.method === 'not' && o.args[0] === 'checkin_at' && o.args[1] === 'is' && o.args[2] === null)).toBe(true);
    expect(q.ops.find((o) => o.method === 'limit')!.args[0]).toBe(300);
    expect(String(q.ops.find((o) => o.method === 'select')!.args[0])).toContain('users:user_id(');
  });

  it('only people the query returned are computed, and their visits / trail are pinned to the user and org', async () => {
    await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(chainsOn('attendance')).toHaveLength(1);                   // no per-person attendance query
    const trailUsers = chainsOn('work_activity').map((c) => c.eqs.user_id).sort();
    expect(trailUsers).toEqual([REP, REP2, REP3].sort());
    for (const c of chainsOn('work_activity')) expect(c.eqs.org_id).toBe(ORG);
  });

  it('lists one row per person even if the table returned a duplicate', async () => {
    __mock.setDefault('attendance', { data: [...teamRows(), ATT({ id: 'a-dup', user_id: REP, users: { name: 'Asha', employee_id: 'EF-001', role: 'x' } })] });
    const res = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(res.body.data.rows.filter((r: any) => r.user_id === REP)).toHaveLength(1);
  });

  it('applies the supervisor-hierarchy scope: only the caller\'s subtree', async () => {
    setUser({ ...manager, client_id: CS, org_role_data_scope: 'own' });
    await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    const q = chainsOn('attendance')[0];
    expect(q.ops.some((o) => o.method === 'in' && o.args[0] === 'user_id' && JSON.stringify(o.args[1]) === JSON.stringify([MGR]))).toBe(true);
    expect(q.eqs).toMatchObject({ org_id: ORG, client_id: CS });
  });

  it('an org-level manager with no client picked is held to their own org (no client filter)', async () => {
    setUser(orgAdmin);
    await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    const q = chainsOn('attendance')[0];
    expect(q.eqs.org_id).toBe(ORG);
    expect('client_id' in q.eqs).toBe(false);
  });

  it('a platform super-admin with no client picked is also held to their own org (never a cross-org team)', async () => {
    setUser(superAdmin);
    await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    const q = chainsOn('attendance')[0];
    expect(q.eqs.org_id).toBe(ORG);
    expect(chainsOn('work_activity').every((c) => c.eqs.org_id === ORG)).toBe(true);
  });

  it('a client picked with X-Client-Id must belong to the caller\'s org (404 otherwise, nothing read); their own client is served', async () => {
    setUser(orgAdmin);
    const bad = await request(app).get(`/attendance/daily-report/team?date=${DATE}`).set('X-Client-Id', CX);
    expect(bad.status).toBe(404);
    expect(chainsOn('attendance')).toHaveLength(0);
    const good = await request(app).get(`/attendance/daily-report/team?date=${DATE}`).set('X-Client-Id', CA);
    expect(good.status).toBe(200);
    expect(chainsOn('attendance')[0].eqs).toMatchObject({ org_id: ORG, client_id: CA });
  });

  it('defaults to today (IST)', async () => {
    const res = await request(app).get('/attendance/daily-report/team');
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe(istDateOf(Date.now()));
    expect(chainsOn('attendance')[0].eqs.date).toBe(istDateOf(Date.now()));
  });

  it('a day nobody checked in is an empty list, not an error', async () => {
    __mock.setDefault('attendance', { data: [] });
    const res = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ date: DATE, rows: [] });
    expect(chainsOn('work_activity')).toHaveLength(0);
  });

  it('labels vehicle modes from policies in one lookup', async () => {
    __mock.setDefault('attendance', { data: [ATT({ id: 'a1', user_id: REP, transport_mode: 'own_bike', users: { name: 'Asha', employee_id: 'E1', role: 'x' } }), ATT({ id: 'a2', user_id: REP2, transport_mode: 'own_bike', users: { name: 'Bala', employee_id: 'E2', role: 'x' } })] });
    __mock.setDefault('expense_policies', (chain) => chain.eqs.org_id
      ? { data: [{ id: 'p1', name: 'Field', is_active: true, priority: 1, currency: 'INR', client_id: null, applies_to: { everyone: true, roles: [], org_role_ids: [], user_ids: [] }, rules: { vehicle_rates: [{ id: 'own_bike', label: 'Own Bike', rate_per_km: 4 }] } }] }
      : { data: [] });
    __mock.setDefault('users', (chain) => ({ data: chain.eqs.id ? (userRows[String(chain.eqs.id)] ?? []) : [{ id: REP, role: 'x', org_role_id: null }, { id: REP2, role: 'x', org_role_id: null }] }));
    const res = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(res.body.data.rows.map((r: any) => [r.mode, r.label])).toEqual([['own_bike', 'Own Bike'], ['own_bike', 'Own Bike']]);
    expect(chainsOn('expense_policies').filter((c) => c.eqs.org_id)).toHaveLength(1);
  });

  it('rejects a malformed date or min_halt_minutes with 400 before reading anything', async () => {
    for (const q of ['date=2026-02-30', 'date=today', 'min_halt_minutes=x']) {
      const res = await request(app).get(`/attendance/daily-report/team?${q}`);
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('honours min_halt_minutes for every row', async () => {
    const tight = await request(app).get(`/attendance/daily-report/team?date=${DATE}&min_halt_minutes=45`);
    expect(tight.body.data.rows.every((r: any) => r.halts === 0)).toBe(true);
    const loose = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(loose.body.data.rows.find((r: any) => r.user_id === REP).halts).toBe(1);
  });

  it('a demo user gets { date, rows: [] } and no database reads', async () => {
    setUser({ ...manager, org_id: DEMO_ORG_ID });
    const res = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ date: DATE, rows: [] });
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('is not shadowed by the single-person route, and the single route is not a team route', async () => {
    const team = await request(app).get(`/attendance/daily-report/team?date=${DATE}`);
    expect(team.body.data).toHaveProperty('rows');
    const single = await request(app).get(`/attendance/daily-report?date=${DATE}`);
    expect(single.body.data).not.toHaveProperty('rows');
  });
});
