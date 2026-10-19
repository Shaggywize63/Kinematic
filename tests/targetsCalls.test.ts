/**
 * Telecaller CALLS target (metric calls_made, period daily). The admin sets a
 * daily call-count goal (per role / per user / org default, same scoping as the
 * lead target) and a telecaller reads today's logged-call count against it.
 *
 * "Calls" are counted exactly as the Telecaller Performance report counts them:
 * crm_activities of type 'call' owned by the user (owner_id OR assigned_to),
 * dated in today's IST window — so the number stays in lock-step with the report.
 *
 * Service level (resolution + the query built) and route level (the real router,
 * with the manager guard and value cap exercised).
 */
import express from 'express';
import request from 'supertest';
import { RecordedChain, createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
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
const ADMIN = '33333333-3333-3333-3333-333333333333';

const admin = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' };
const rep = { id: REP, org_id: ORG, client_id: CLIENT, role: 'telecaller', org_role_id: ROLE };

// A calls_made / daily row (what the admin stores for the calls target).
const crow = (o: any = {}) => ({ id: 'c', user_id: null, org_role_id: null, hierarchy_level_id: null, client_id: CLIENT, metric: 'calls_made', period: 'daily', target_value: 50, ...o });
const opsOf = (c: RecordedChain, m: string) => c.ops.filter((o) => o.method === m).map((o) => o.args);
const insertsOf = (table: string) => __mock.chainsFor(table).flatMap((c) => opsOf(c, 'insert').map((a) => a[0] as any));

beforeEach(() => __mock.reset());

describe('myCallsTarget', () => {
  const run = async (rows: any[], me: any = { org_role_id: ROLE, hierarchy_level_id: LEVEL }, count = 7) => {
    __mock.reset();
    __mock.setDefault('users', { data: [me] });
    __mock.setDefault('crm_targets', { data: rows });
    __mock.setDefault('crm_activities', { data: null, count });
    return svc.myCallsTarget(ORG, REP, CLIENT);
  };

  it('answers { metric: calls_made, period: daily, target, achieved } and counts today\'s calls', async () => {
    const out = await run([crow({ target_value: 80 })], undefined, 12);
    expect(out).toEqual({ metric: 'calls_made', period: 'daily', target: 80, achieved: 12 });
    // Target rows filtered to the calls metric / daily period.
    expect(__mock.chainsFor('crm_targets')[0].eqs).toEqual({ org_id: ORG, metric: 'calls_made', period: 'daily' });
    // Calls counted as type=call in today's IST window, scoped by owner (not client).
    const a = __mock.chainsFor('crm_activities')[0];
    expect(a.eqs).toMatchObject({ org_id: ORG, type: 'call' });
    expect(a.eqs.client_id).toBeUndefined();
    expect(a.ops.some((o) => o.method === 'gte' && o.args[0] === 'activity_date')).toBe(true);
    expect(a.ops.some((o) => o.method === 'or' && String(o.args[0]).includes('owner_id') && String(o.args[0]).includes('assigned_to'))).toBe(true);
  });

  it('resolves user > role > level > default', async () => {
    const rows = [crow({ id: 'd', target_value: 10 }), crow({ id: 'l', hierarchy_level_id: LEVEL, target_value: 20 }),
      crow({ id: 'r', org_role_id: ROLE, target_value: 30 }), crow({ id: 'u', user_id: REP, target_value: 40 })];
    expect((await run(rows)).target).toBe(40);
    expect((await run(rows.slice(0, 3))).target).toBe(30);
    expect((await run(rows.slice(0, 2))).target).toBe(20);
    expect((await run(rows.slice(0, 1))).target).toBe(10);
    expect((await run([])).target).toBe(0);
  });

  it('prefers a client-specific row to an org-wide one, and ignores another client\'s', async () => {
    expect((await run([crow({ client_id: null, target_value: 90 }), crow({ client_id: CLIENT, target_value: 60 })])).target).toBe(60);
    expect((await run([crow({ client_id: '99999999-9999-9999-9999-999999999999', target_value: 90 })])).target).toBe(0);
  });
});

// ── the real routes ──────────────────────────────────────────────────────────
describe('/crm/targets/calls routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  const as = (u: object) => ({ 'x-test-user': JSON.stringify(u) });

  it('GET /targets/calls/me wraps { metric, period: daily, target, achieved } in the envelope', async () => {
    __mock.setDefault('users', { data: [{ org_role_id: ROLE, hierarchy_level_id: null }] });
    __mock.setDefault('crm_targets', { data: [crow({ org_role_id: ROLE, target_value: 75 })] });
    __mock.setDefault('crm_activities', { data: null, count: 9 });
    const res = await request(app).get('/crm/targets/calls/me').set(as(rep));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { metric: 'calls_made', period: 'daily', target: 75, achieved: 9 } });
  });

  it('GET /targets/calls lists default / per_level / per_user for a manager', async () => {
    __mock.setDefault('crm_targets', { data: [crow({ target_value: 50 }), crow({ user_id: REP, target_value: 80 })] });
    const res = await request(app).get('/crm/targets/calls').set(as(admin));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { default_target: 50, per_level: [], per_user: [{ user_id: REP, target_value: 80 }] } });
    expect(__mock.chainsFor('crm_targets')[0].eqs).toMatchObject({ metric: 'calls_made', period: 'daily' });
  });

  it('GET /targets/calls is for managers only', async () => {
    expect((await request(app).get('/crm/targets/calls').set(as(rep))).status).toBe(403);
  });

  it('PUT /targets/calls stores a floored calls_made / daily row', async () => {
    __mock.setDefault('crm_targets', { data: [{ id: 'new', target_value: 0 }] });
    __mock.queue('crm_targets', { data: [] });
    const res = await request(app).put('/crm/targets/calls').set(as(admin)).send({ user_id: REP, target_value: 80.6 });
    expect(res.status).toBe(200);
    expect(insertsOf('crm_targets')[0]).toMatchObject({ metric: 'calls_made', period: 'daily', user_id: REP, target_value: 80, client_id: CLIENT });
  });

  it('PUT /targets/calls rejects a negative, non-numeric, or over-cap value with 400', async () => {
    for (const bad of [-1, 'abc', svc.MAX_CALLS_TARGET + 1]) {
      const res = await request(app).put('/crm/targets/calls').set(as(admin)).send({ all: true, target_value: bad });
      expect(res.status).toBe(400);
    }
  });

  it('PUT /targets/calls is for managers only', async () => {
    expect((await request(app).put('/crm/targets/calls').set(as(rep)).send({ all: true, target_value: 10 })).status).toBe(403);
  });
});
