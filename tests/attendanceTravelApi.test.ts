/**
 * GET /api/v1/attendance/travel over HTTP: the real attendance router driven against the chainable Supabase
 * double. Covers the response shape, the default date / user, validation, who may look at whose travel
 * (a rep only themself; a manager inside their org / client scope) and that the queries it builds are
 * pinned to the right user and org. The maths itself is tests/travel.test.ts.
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
const REP = '22222222-2222-4222-8222-222222222222';
const REP2 = '33333333-3333-4333-8333-333333333333';
const MGR = '11111111-1111-4111-8111-111111111111';
const DATE = '2026-10-09';

const ist = (hhmm: string) => new Date(Date.parse(`${DATE}T${hhmm}:00+05:30`)).toISOString();
const setUser = (u: Record<string, unknown>) => { (global as any).__testUser = u; };
const rep = { id: REP, org_id: ORG, role: 'field_executive', client_id: CA, name: 'Asha', email: 'asha@client.test' };
const manager = { id: MGR, org_id: ORG, role: 'admin', client_id: CA, name: 'Meera', email: 'meera@client.test' };
const orgAdmin = { id: MGR, org_id: ORG, role: 'admin', client_id: null, name: 'Org Admin', email: 'oa@client.test' };

const ATT = {
  id: 'att-1', status: 'checked_out', checkin_at: ist('09:30'), checkout_at: ist('12:00'),
  checkin_lat: 13.0, checkin_lng: 80.2, checkout_lat: 13.09, checkout_lng: 80.2,
};
const trailRows = [
  { lat: 13.01, lng: 80.2, captured_at: ist('09:40'), is_mock: false, is_suspect: false },
  { lat: 13.02, lng: 80.2, captured_at: ist('09:50'), is_mock: false, is_suspect: false },
  { lat: 13.06, lng: 80.2, captured_at: ist('11:30'), is_mock: false, is_suspect: false },
  { lat: 13.07, lng: 80.2, captured_at: ist('11:40'), is_mock: false, is_suspect: false },
  { lat: 13.08, lng: 80.2, captured_at: ist('11:50'), is_mock: false, is_suspect: false },
];
const FORM_VISIT = {
  id: 'sub-f1', check_in_at: ist('10:00'), check_out_at: ist('11:00'),
  check_in_gps: '13.03,80.2', check_out_gps: '13.05,80.2', builder_forms: { title: 'Customer Visit' },
};

const chainsOn = (table: string) => __mock.chainsFor(table);

beforeEach(() => {
  __mock.reset();
  clearClientFlagCache();
  __mock.setDefault('clients', { data: { id: CA, org_id: ORG, owner_org_id: null, settings: {} } });
  __mock.setDefault('attendance', (chain) => ({ data: chain.eqs.date === DATE ? [ATT] : [] }));
  __mock.setDefault('work_activity', { data: trailRows });
  __mock.setDefault('form_submissions', { data: [FORM_VISIT] });
  __mock.setDefault('builder_submissions', { data: [] });
  __mock.setDefault('users', { data: { id: REP2 } });
  setUser(rep);
});

describe('GET /attendance/travel', () => {
  it('defaults to today (IST) and to the caller; no attendance is a 200 with zeros, and no other table is read', async () => {
    const res = await request(app).get('/attendance/travel');
    expect(res.status).toBe(200);
    const today = istDateOf(Date.now());
    expect(res.body.data).toEqual({
      date: today, user_id: REP, attendance_id: null, started_at: null, ended_at: null, in_progress: false,
      total_km: 0, method: 'none', legs: [], stops: [], points_used: 0, points_excluded: 0,
    });
    expect(chainsOn('attendance')[0].eqs).toMatchObject({ user_id: REP, date: today });
    expect(chainsOn('work_activity')).toHaveLength(0);
    expect(chainsOn('form_submissions')).toHaveLength(0);
    expect(chainsOn('builder_submissions')).toHaveLength(0);
  });

  it('returns the contract shape for a day with a visit: legs, stops, totals', async () => {
    const res = await request(app).get(`/attendance/travel?date=${DATE}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(res.body.success).toBe(true);
    expect(d).toMatchObject({
      date: DATE, user_id: REP, attendance_id: 'att-1', started_at: ist('09:30'), ended_at: ist('12:00'),
      in_progress: false, method: 'gps_trail',
    });
    expect(d.legs.map((l: any) => [l.index, l.from.kind, l.to.kind, l.method])).toEqual([
      [0, 'checkin', 'form_checkin', 'gps_trail'],
      [1, 'form_checkout', 'checkout', 'gps_trail'],
    ]);
    expect(d.legs[0].to).toMatchObject({ label: 'Customer Visit', at: ist('10:00'), lat: 13.03, lng: 80.2 });
    expect(d.stops).toEqual([{ submission_id: 'sub-f1', label: 'Customer Visit', check_in_at: ist('10:00'), check_out_at: ist('11:00'), minutes: 60 }]);
    expect(d.total_km).toBe(Math.round((d.legs[0].km + d.legs[1].km) * 100) / 100);
    expect(d.total_km).toBeGreaterThan(5);
    expect(typeof d.points_used).toBe('number');
    expect(typeof d.points_excluded).toBe('number');
  });

  it('reads both submission tables for the user and pins the GPS trail to the org', async () => {
    await request(app).get(`/attendance/travel?date=${DATE}`);
    for (const table of ['form_submissions', 'builder_submissions']) {
      const c = chainsOn(table)[0];
      expect(c.eqs).toMatchObject({ user_id: REP });
      expect(c.ops.some((o) => o.method === 'not' && o.args[0] === 'check_out_at')).toBe(true);
    }
    expect(chainsOn('work_activity')[0].eqs).toMatchObject({ user_id: REP, org_id: ORG });
  });

  it('merges visits from builder_submissions too (location_lat / location_lng fallback)', async () => {
    __mock.setDefault('form_submissions', { data: [] });
    __mock.setDefault('builder_submissions', {
      data: [{ id: 'sub-b1', check_in_at: ist('10:00'), check_out_at: ist('11:00'), location_lat: 13.04, location_lng: 80.2, builder_forms: { title: 'Site Audit' } }],
    });
    const res = await request(app).get(`/attendance/travel?date=${DATE}`);
    expect(res.body.data.stops).toEqual([{ submission_id: 'sub-b1', label: 'Site Audit', check_in_at: ist('10:00'), check_out_at: ist('11:00'), minutes: 60 }]);
  });

  it('a failing submissions read does not fail the travel read', async () => {
    __mock.setDefault('form_submissions', { data: null, error: { message: 'column "check_in_gps" does not exist' } });
    const res = await request(app).get(`/attendance/travel?date=${DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stops).toEqual([]);
    expect(res.body.data.legs).toHaveLength(1);
  });

  it('rejects a malformed date or user_id with 400', async () => {
    for (const q of ['date=2026-13-45', 'date=09-10-2026', 'date=yesterday', 'user_id=not-a-uuid']) {
      const res = await request(app).get(`/attendance/travel?${q}`);
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('is routed to the travel handler (not swallowed by a parameterised route)', async () => {
    const res = await request(app).get(`/attendance/travel?date=${DATE}`);
    expect(res.status).not.toBe(404);
    expect(res.body.data).toHaveProperty('legs');
  });

  it('a demo user gets an empty result and no database reads', async () => {
    setUser({ ...rep, org_id: DEMO_ORG_ID });
    const res = await request(app).get(`/attendance/travel?date=${DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ attendance_id: null, total_km: 0, method: 'none' });
    expect(chainsOn('attendance')).toHaveLength(0);
  });
});

describe('whose travel may be read', () => {
  it('a rep may pass their own user_id', async () => {
    const res = await request(app).get(`/attendance/travel?date=${DATE}&user_id=${REP}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user_id).toBe(REP);
  });

  it('a rep gets 403 for anyone else and nothing is read', async () => {
    const res = await request(app).get(`/attendance/travel?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(403);
    expect(chainsOn('attendance')).toHaveLength(0);
    expect(chainsOn('work_activity')).toHaveLength(0);
  });

  it('a manager reads a team member inside their org and client', async () => {
    setUser(manager);
    const res = await request(app).get(`/attendance/travel?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user_id).toBe(REP2);
    const lookup = chainsOn('users')[0];
    expect(lookup.eqs).toMatchObject({ id: REP2, org_id: ORG, client_id: CA });
    expect(chainsOn('attendance')[0].eqs).toMatchObject({ user_id: REP2, date: DATE });
    expect(chainsOn('work_activity')[0].eqs).toMatchObject({ user_id: REP2, org_id: ORG });
  });

  it('a manager asking for someone outside their scope gets 404 and no data is read', async () => {
    setUser(manager);
    __mock.setDefault('users', { data: [] });
    const res = await request(app).get(`/attendance/travel?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(404);
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('a manager without a client in the JWT may not borrow another org\'s client via X-Client-Id', async () => {
    setUser(orgAdmin);
    __mock.setDefault('clients', { data: { id: CX, org_id: OTHER_ORG, owner_org_id: OTHER_ORG, settings: {} } });
    const res = await request(app).get(`/attendance/travel?date=${DATE}&user_id=${REP2}`).set('X-Client-Id', CX);
    expect(res.status).toBe(404);
    expect(chainsOn('attendance')).toHaveLength(0);
  });

  it('an org-level manager with no client picked is held to their own org', async () => {
    setUser(orgAdmin);
    const res = await request(app).get(`/attendance/travel?date=${DATE}&user_id=${REP2}`);
    expect(res.status).toBe(200);
    expect(chainsOn('users')[0].eqs).toMatchObject({ id: REP2, org_id: ORG });
    expect(chainsOn('work_activity')[0].eqs).toMatchObject({ org_id: ORG });
  });
});
