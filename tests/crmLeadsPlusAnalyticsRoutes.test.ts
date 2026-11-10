/**
 * HTTP layer of the Lead Management "plus" analytics endpoints, through the real
 * CRM router: response envelope + shape on an empty org, the `crm_lead_analytics`
 * module gate (real rbac, not mocked), bad input -> 400, org / client scoping taken
 * from the authenticated user (never from a spoofed header), and the cache key
 * (it must carry every query parameter and the caller's scope signature).
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
  requireAuth: (req: any, _res: any, next: any) => { req.user = (global as any).__TEST_USER; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
// Everything is real except the two other gates the CRM router stacks in front: only
// `requireModuleAccess` (the crm_lead_analytics gate under test) must behave for real.
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));
// Pass-through cache that records every key, so the key contents can be asserted.
const mockKeys: string[] = [];
jest.mock('../src/utils/analyticsCache', () => ({
  cached: (key: string, _ttl: number, loader: () => Promise<unknown>) => { mockKeys.push(key); return loader(); },
  bust: async () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const AGRI = '55555555-5555-5555-5555-555555555555';
const PIPE = 'b1111111-1111-1111-1111-111111111111';
const ME = '33333333-3333-3333-3333-333333333333';

const app = express();
app.use(express.json());
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));

const withModule = { id: ME, org_id: ORG, role: 'admin', client_id: null, org_role_data_scope: 'all', enabled_modules: ['crm', 'crm_lead_analytics'], entitlements_strict: true };
const withoutModule = { ...withModule, enabled_modules: ['crm'] };

/** path -> keys the empty-org response must carry (all under `data`). */
const ENDPOINTS: Array<[string, string[]]> = [
  ['/crm/analytics/source-performance', ['rows', 'totals', 'from', 'to']],
  ['/crm/analytics/followup-compliance', ['rows', 'totals', 'trend', 'from', 'to']],
  ['/crm/analytics/owner-workload', ['rows', 'totals', 'sla_minutes']],
  ['/crm/analytics/stage-velocity', ['pipeline_id', 'pipelines', 'rows', 'totals']],
  ['/crm/analytics/activity-mix', ['rows', 'totals', 'by_type', 'by_week']],
  ['/crm/analytics/conversion-time', ['totals', 'buckets', 'by_owner', 'by_source', 'by_month']],
  ['/crm/analytics/weighted-pipeline', ['rows', 'totals']],
  ['/crm/analytics/deal-size-distribution', ['rows', 'totals']],
  ['/crm/analytics/win-rate-trend', ['rows', 'totals', 'months']],
  ['/crm/analytics/call-connect-trend', ['rows', 'totals', 'weeks']],
  ['/crm/analytics/lead-recycling', ['rows', 'totals', 'months']],
];

beforeEach(() => { __mock.reset(); mockKeys.length = 0; (global as any).__TEST_USER = withModule; });

describe('response envelope and empty-org shape', () => {
  it.each(ENDPOINTS)('GET %s answers 200 { success, data } with the documented keys on an empty org', async (path, keys) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const k of keys) expect(res.body.data).toHaveProperty(k);
  });
});

describe('module gate (crm_lead_analytics)', () => {
  it.each(ENDPOINTS)('GET %s is 403 without the module and runs no CRM query', async (path) => {
    (global as any).__TEST_USER = withoutModule;
    const res = await request(app).get(path);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    for (const t of ['crm_leads', 'crm_deals', 'crm_activities', 'crm_deal_stages', 'crm_lead_history']) {
      expect(__mock.chainsFor(t)).toHaveLength(0);
    }
  });

  it('is open to a super_admin and to a user who holds the module', async () => {
    (global as any).__TEST_USER = { ...withoutModule, role: 'super_admin' };
    expect((await request(app).get('/crm/analytics/activity-mix')).status).toBe(200);
    (global as any).__TEST_USER = withModule;
    expect((await request(app).get('/crm/analytics/activity-mix')).status).toBe(200);
  });
});

describe('bad input is a 400, never a 500 or a silent clamp', () => {
  const bad: Array<[string, Record<string, string>]> = [
    ['/crm/analytics/stage-velocity', { pipeline_id: 'not-a-uuid' }],
    ['/crm/analytics/stage-velocity', { pipeline_id: `${PIPE},id.eq.1` }],
    ['/crm/analytics/weighted-pipeline', { pipeline_id: '123' }],
    ['/crm/analytics/win-rate-trend', { months: '0' }],
    ['/crm/analytics/win-rate-trend', { months: '99' }],
    ['/crm/analytics/win-rate-trend', { months: 'abc' }],
    ['/crm/analytics/lead-recycling', { months: '-1' }],
    ['/crm/analytics/call-connect-trend', { weeks: '27' }],
    ['/crm/analytics/call-connect-trend', { weeks: '1.5' }],
    ['/crm/analytics/owner-workload', { sla_minutes: 'abc' }],
    ['/crm/analytics/owner-workload', { sla_minutes: '0' }],
  ];
  it.each(bad)('GET %s %j', async (path, query) => {
    const res = await request(app).get(path).query(query);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('a from after the to is a 400', async () => {
    const res = await request(app).get('/crm/analytics/source-performance').query({ from: '2026-10-31', to: '2026-10-01' });
    expect(res.status).toBe(400);
  });

  it('a malformed date is dropped like on the neighbouring endpoints (no bound), not an error', async () => {
    const res = await request(app).get('/crm/analytics/source-performance').query({ from: '23--06--2026' });
    expect(res.status).toBe(200);
  });
});

describe('org and client scoping come from the authenticated user', () => {
  it('uses the token\'s org even when a different X-Org-Id header is sent', async () => {
    await request(app).get('/crm/analytics/source-performance').set('X-Org-Id', '00000000-0000-0000-0000-0000000000ff');
    const c = __mock.chainsFor('crm_leads')[0];
    expect(c.eqs.org_id).toBe(ORG);
  });

  it('narrows to the X-Client-Id the user picked, on every table the report reads', async () => {
    await request(app).get('/crm/analytics/owner-workload').set('X-Client-Id', AGRI);
    for (const t of ['crm_leads', 'crm_activities']) {
      for (const c of __mock.chainsFor(t)) expect(c.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
    }
  });

  it('carries the per-user analyticsScope into the queries (city pick -> one OR on leads)', async () => {
    await request(app).get('/crm/analytics/source-performance').query({ city: 'Pune' });
    const c = __mock.chainsFor('crm_leads')[0];
    expect(c.ors).toHaveLength(1);
    expect(c.ors[0]).toContain('city.in.("Pune")');
  });
});

describe('cache key', () => {
  const key = async (path: string, query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    mockKeys.length = 0;
    await request(app).get(path).query(query).set(headers);
    return mockKeys[0];
  };

  it('names the endpoint, the org, the client and the date window', async () => {
    const k = await key('/crm/analytics/source-performance', { from: '2026-10-01', to: '2026-10-31' }, { 'X-Client-Id': AGRI });
    expect(k).toContain('plus:source-performance');
    expect(k).toContain(ORG);
    expect(k).toContain(AGRI);
    expect(k).toContain('2026-10-01');
    expect(k).toContain('2026-10-31');
  });

  it('differs for every query parameter a handler reads, so one view is never served for another', async () => {
    const keys = [
      await key('/crm/analytics/win-rate-trend', { months: '3' }),
      await key('/crm/analytics/win-rate-trend', { months: '6' }),
      await key('/crm/analytics/call-connect-trend', { weeks: '4' }),
      await key('/crm/analytics/call-connect-trend', { weeks: '8' }),
      await key('/crm/analytics/lead-recycling', { months: '3' }),
      await key('/crm/analytics/lead-recycling', { months: '6' }),
      await key('/crm/analytics/owner-workload', { sla_minutes: '30' }),
      await key('/crm/analytics/owner-workload', { sla_minutes: '120' }),
      await key('/crm/analytics/stage-velocity', { pipeline_id: PIPE }),
      await key('/crm/analytics/stage-velocity'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('differs by the caller\'s scope signature (a city pick changes it)', async () => {
    const all = await key('/crm/analytics/activity-mix');
    const pune = await key('/crm/analytics/activity-mix', { city: 'Pune' });
    expect(all).not.toBe(pune);
  });
});
