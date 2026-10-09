/**
 * The existing per-FE lead targets (metric leads_created, period daily) — characterised so that adding
 * the Sales / Collection rupee targets provably leaves every request WITHOUT a `type` exactly as it was:
 * same queries, same stored rows, same response shapes, same (lack of) validation.
 *
 * Service level (the queries built and the numbers returned) and route level (the real /crm/targets router).
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock, RecordedChain } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// requireAuth is replaced (the caller comes from a header); requireRole stays REAL so the manager guard is exercised.
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers['x-test-user'] ?? '{}'));
    next();
  },
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as svc from '../src/services/crm/targets.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '55555555-5555-5555-5555-555555555555';
const ROLE = '66666666-6666-6666-6666-666666666666';
const LEVEL = '77777777-7777-7777-7777-777777777777';
const REP = '11111111-1111-1111-1111-111111111111';
const REP2 = '12121212-1212-1212-1212-121212121212';
const ADMIN = '33333333-3333-3333-3333-333333333333';

const admin = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' };
const rep = { id: REP, org_id: ORG, client_id: CLIENT, role: 'executive', org_role_id: ROLE, org_role_data_scope: 'own' };

const trow = (o: any = {}) => ({ id: 't', user_id: null, org_role_id: null, hierarchy_level_id: null, client_id: CLIENT, metric: 'leads_created', period: 'daily', target_value: 10, ...o });
const opsOf = (c: RecordedChain, m: string) => c.ops.filter((o) => o.method === m).map((o) => o.args);
const insertsOf = (table: string) => __mock.chainsFor(table).flatMap((c) => opsOf(c, 'insert').map((a) => a[0] as any));
const updatesOf = (table: string) => __mock.chainsFor(table).flatMap((c) => opsOf(c, 'update').map((a) => a[0] as any));

beforeEach(() => __mock.reset());

describe('listTargets', () => {
  it('returns the default, per-role and per-user targets from the leads_created / daily rows', async () => {
    __mock.setDefault('crm_targets', { data: [
      trow({ id: 'd', target_value: 5 }),
      trow({ id: 'r', org_role_id: ROLE, target_value: 8 }),
      trow({ id: 'u', user_id: REP, target_value: 12 }),
    ] });
    expect(await svc.listTargets(ORG, CLIENT)).toEqual({
      default_target: 5,
      per_level: [{ hierarchy_level_id: ROLE, target_value: 8 }],
      per_user: [{ user_id: REP, target_value: 12 }],
    });
    const c = __mock.chainsFor('crm_targets')[0];
    expect(c.eqs).toEqual({ org_id: ORG, metric: 'leads_created', period: 'daily', client_id: CLIENT });
  });
  it('has no default (0) and is not client-filtered when no client is picked', async () => {
    __mock.setDefault('crm_targets', { data: [] });
    expect(await svc.listTargets(ORG, null)).toEqual({ default_target: 0, per_level: [], per_user: [] });
    expect(__mock.chainsFor('crm_targets')[0].eqs.client_id).toBeUndefined();
  });
});

describe('setTarget', () => {
  it('inserts a leads_created / daily row, flooring and clamping the value', async () => {
    __mock.setDefault('crm_targets', { data: [{ id: 'new' }] });
    __mock.queue('crm_targets', { data: [] });                                  // nothing there yet -> insert
    await svc.setTarget(ORG, CLIENT, { user_id: REP, target_value: 7.9 }, ADMIN);
    expect(insertsOf('crm_targets')[0]).toEqual({
      org_id: ORG, client_id: CLIENT, user_id: REP, org_role_id: null, hierarchy_level_id: null,
      metric: 'leads_created', period: 'daily', target_value: 7, created_by: ADMIN,
    });
    const find = __mock.chainsFor('crm_targets')[0];
    expect(find.eqs).toMatchObject({ org_id: ORG, metric: 'leads_created', period: 'daily', client_id: CLIENT, user_id: REP });
  });
  it('treats an incoming hierarchy_level_id as a role id, and clamps a negative / non-numeric value to 0', async () => {
    __mock.queue('crm_targets', { data: [] });
    __mock.setDefault('crm_targets', { data: [{ id: 'new' }] });
    await svc.setTarget(ORG, CLIENT, { hierarchy_level_id: LEVEL, target_value: -4 }, ADMIN);
    expect(insertsOf('crm_targets')[0]).toMatchObject({ org_role_id: LEVEL, hierarchy_level_id: null, user_id: null, target_value: 0 });
    __mock.reset();
    __mock.queue('crm_targets', { data: [] });
    __mock.setDefault('crm_targets', { data: [{ id: 'new' }] });
    await svc.setTarget(ORG, CLIENT, { target_value: Number('abc') }, ADMIN);
    expect(insertsOf('crm_targets')[0].target_value).toBe(0);
  });
  it('updates the existing row in place', async () => {
    __mock.setDefault('crm_targets', { data: [{ id: 'existing' }] });
    await svc.setTarget(ORG, CLIENT, { target_value: 20 }, ADMIN);
    expect(updatesOf('crm_targets')[0]).toMatchObject({ target_value: 20, updated_by: ADMIN });
    expect(insertsOf('crm_targets')).toHaveLength(0);
    expect(__mock.chainsFor('crm_targets').flatMap((c) => c.ops).some((o) => o.method === 'eq' && o.args[0] === 'id' && o.args[1] === 'existing')).toBe(true);
  });
});

describe('myTargetToday', () => {
  const run = async (rows: any[], me: any = { org_role_id: ROLE, hierarchy_level_id: LEVEL }, count = 3) => {
    __mock.reset();
    __mock.setDefault('users', { data: [me] });
    __mock.setDefault('crm_targets', { data: rows });
    __mock.setDefault('crm_leads', { data: null, count });
    return svc.myTargetToday(ORG, REP, CLIENT);
  };
  it('answers { metric, period: weekly, target, achieved } and counts the caller\'s leads this week', async () => {
    const out = await run([trow({ target_value: 5 })], undefined, 4);
    expect(out).toEqual({ metric: 'leads_created', period: 'weekly', target: 5, achieved: 4 });
    const c = __mock.chainsFor('crm_leads')[0];
    expect(c.eqs).toMatchObject({ org_id: ORG, created_by: REP, client_id: CLIENT });
    expect(c.ops.some((o) => o.method === 'gte' && o.args[0] === 'created_at')).toBe(true);
    expect(__mock.chainsFor('crm_targets')[0].eqs).toEqual({ org_id: ORG, metric: 'leads_created', period: 'daily' });
  });
  it('resolves user > role > level > default', async () => {
    const rows = [trow({ id: 'd', target_value: 1 }), trow({ id: 'l', hierarchy_level_id: LEVEL, target_value: 2 }),
      trow({ id: 'r', org_role_id: ROLE, target_value: 3 }), trow({ id: 'u', user_id: REP, target_value: 4 })];
    expect((await run(rows)).target).toBe(4);
    expect((await run(rows.slice(0, 3))).target).toBe(3);
    expect((await run(rows.slice(0, 2))).target).toBe(2);
    expect((await run(rows.slice(0, 1))).target).toBe(1);
    expect((await run([])).target).toBe(0);
  });
  it('prefers a client-specific row to an org-wide one of the same scope, and ignores another client\'s', async () => {
    expect((await run([trow({ client_id: null, target_value: 9 }), trow({ client_id: CLIENT, target_value: 6 })])).target).toBe(6);
    expect((await run([trow({ client_id: '99999999-9999-9999-9999-999999999999', target_value: 9 })])).target).toBe(0);
  });
});

describe('targetsLeaderboard', () => {
  it('keeps its row fields and aggregate stats', async () => {
    __mock.setDefault('users', { data: [
      { id: REP, name: 'Asha', email: 'a@x.test', city: 'Pune', org_role_id: ROLE, hierarchy_level_id: null, role: 'executive' },
      { id: REP2, name: 'Bala', email: 'b@x.test', city: null, org_role_id: ROLE, hierarchy_level_id: null, role: 'executive' },
    ] });
    __mock.setDefault('crm_targets', { data: [trow({ target_value: 14 })] });
    __mock.setDefault('crm_leads', { data: [{ created_by: REP }, { created_by: REP }, { created_by: REP2 }] });
    __mock.setDefault('crm_settings', { data: [{ id: 's', config: {} }] });
    const out = await svc.targetsLeaderboard(ORG, CLIENT, 'week');
    expect(out.period).toBe('week');
    expect(out.role_id).toBeNull();
    expect(out.entries).toEqual([
      { user_id: REP, name: 'Asha', city: 'Pune', leads: 2, target: Math.round((14 / 7) * out.days), pct: Math.round((2 / Math.round((14 / 7) * out.days)) * 100) },
      { user_id: REP2, name: 'Bala', city: null, leads: 1, target: Math.round((14 / 7) * out.days), pct: Math.round((1 / Math.round((14 / 7) * out.days)) * 100) },
    ]);
    expect(Object.keys(out).sort()).toEqual(['days', 'entries', 'generated_at', 'period', 'role_id', 'stats']);
    expect(out.stats).toMatchObject({ participants: 2, total_leads: 3, top_performer: { name: 'Asha', leads: 2 }, lowest_performer: { name: 'Bala', leads: 1 } });
  });
});

// ── the real routes ──────────────────────────────────────────────────────────
describe('/crm/targets without a type', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  const as = (u: object) => ({ 'x-test-user': JSON.stringify(u) });

  it('GET /targets/me is { metric, period: weekly, target, achieved }', async () => {
    __mock.setDefault('users', { data: [{ org_role_id: ROLE, hierarchy_level_id: null }] });
    __mock.setDefault('crm_targets', { data: [trow({ org_role_id: ROLE, target_value: 6 })] });
    __mock.setDefault('crm_leads', { data: null, count: 2 });
    const res = await request(app).get('/crm/targets/me').set(as(rep));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { metric: 'leads_created', period: 'weekly', target: 6, achieved: 2 } });
  });

  it('GET /targets lists default / per_level / per_user for a manager', async () => {
    __mock.setDefault('crm_targets', { data: [trow({ target_value: 5 }), trow({ user_id: REP, target_value: 9 })] });
    const res = await request(app).get('/crm/targets').set(as(admin));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { default_target: 5, per_level: [], per_user: [{ user_id: REP, target_value: 9 }] } });
    expect(__mock.chainsFor('crm_targets')[0].eqs).toMatchObject({ metric: 'leads_created', period: 'daily' });
  });

  it('GET /targets is for managers only', async () => {
    expect((await request(app).get('/crm/targets').set(as(rep))).status).toBe(403);
  });

  it('PUT /targets stores leads_created / daily with today\'s lenient value handling', async () => {
    __mock.setDefault('crm_targets', { data: [{ id: 'new', target_value: 0 }] });
    __mock.queue('crm_targets', { data: [] });
    const res = await request(app).put('/crm/targets').set(as(admin)).send({ user_id: REP, target_value: 7.9 });
    expect(res.status).toBe(200);
    expect(insertsOf('crm_targets')[0]).toMatchObject({ metric: 'leads_created', period: 'daily', user_id: REP, target_value: 7, client_id: CLIENT });
  });

  it('PUT /targets: no cap, negatives and junk become 0, a string number is accepted — exactly as before', async () => {
    for (const [sent, stored] of [[2_000_000_000, 2_000_000_000], [-5, 0], ['abc', 0], ['12', 12]] as const) {
      __mock.reset();
      __mock.setDefault('crm_targets', { data: [{ id: 'new' }] });
      __mock.queue('crm_targets', { data: [] });
      const res = await request(app).put('/crm/targets').set(as(admin)).send({ all: true, target_value: sent });
      expect({ sent, status: res.status }).toEqual({ sent, status: 200 });
      expect(insertsOf('crm_targets')[0].target_value).toBe(stored);
    }
  });

  it('PUT /targets still requires target_value, and still refuses a frontline champion', async () => {
    const missing = await request(app).put('/crm/targets').set(as(admin)).send({ all: true });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toMatch(/target_value is required/);
    const champ = await request(app).put('/crm/targets').set(as({ ...admin, org_role_name: 'Consumer Champion', org_role_data_scope: 'own' })).send({ all: true, target_value: 3 });
    expect(champ.status).toBe(403);
  });

  it('GET /targets/levels and /leaderboard-role are unchanged', async () => {
    __mock.setDefault('org_roles', { data: [{ id: ROLE, name: 'Champion' }] });
    const levels = await request(app).get('/crm/targets/levels').set(as(admin));
    expect(levels.body).toEqual({ success: true, data: [{ id: ROLE, name: 'Champion' }] });
    __mock.setDefault('crm_settings', { data: [{ id: 's', config: { leaderboard_role_by_client: { [CLIENT]: ROLE } } }] });
    const lb = await request(app).get('/crm/targets/leaderboard-role').set(as(admin));
    expect(lb.body).toEqual({ success: true, data: { role_id: ROLE } });
  });

  it('GET /targets/leaderboard keeps its lead-count shape (period defaults to today; junk falls back to it)', async () => {
    __mock.setDefault('users', { data: [{ id: REP, name: 'Asha', email: null, city: null, org_role_id: ROLE, hierarchy_level_id: null, role: 'executive' }] });
    __mock.setDefault('crm_targets', { data: [trow({ target_value: 7 })] });
    __mock.setDefault('crm_leads', { data: [{ created_by: REP }] });
    __mock.setDefault('crm_settings', { data: [{ id: 's', config: {} }] });
    const res = await request(app).get('/crm/targets/leaderboard?period=bogus').set(as(rep));
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe('today');
    expect(res.body.data.entries).toEqual([{ user_id: REP, name: 'Asha', city: null, leads: 1, target: 1, pct: 100 }]);
    expect(Object.keys(res.body.data).sort()).toEqual(['days', 'entries', 'generated_at', 'period', 'role_id', 'stats']);
  });
});
