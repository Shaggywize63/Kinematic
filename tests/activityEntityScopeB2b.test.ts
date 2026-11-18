/**
 * Connected-B2B (Spark & Ray) RECORD timelines show the whole team's activities.
 *
 * A lead / account / contact / deal `/:id/activities` read is already scoped to one record
 * the caller can see, and Spark's multi-FE (co-assignee) model means every rep on the lead
 * must see its full timeline — not just their own rows. A rep opening a teammate-owned lead
 * was getting an empty Timeline tab because the per-user owner filter (`owner_id.eq.<rep>` …)
 * matched nothing. This pins the fix: for a connected-B2B client that owner filter is dropped
 * on the entity timelines, while every other tenant (and the GLOBAL activities list) keeps it.
 *
 * Proven by the exact query shape the handler builds, captured from the supabase mock.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// Settable auth user: each test picks the role / client it needs.
let CURRENT_USER: Record<string, unknown> = {};
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => { req.user = CURRENT_USER; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));

// Enrichment runs AFTER the query under test is built; stub its helpers to passthrough so a
// partially-mocked name lookup can't 500 the handler and mask the filter assertion.
jest.mock('../src/services/crm/owners.helper', () => ({
  ...jest.requireActual('../src/services/crm/owners.helper'),
  stampOwnerNames: async (r: any) => r,
  stampLinkedEntityNames: async (r: any) => r,
  stampDirectoryNames: async (r: any) => r,
}));
jest.mock('../src/services/crm/activityExtras.service', () => ({
  ...jest.requireActual('../src/services/crm/activityExtras.service'),
  stampAssignees: async (r: any) => r,
  coAssignedActivityIds: async () => [],
}));
jest.mock('../src/services/crm/activityTypeFallback', () => ({
  ...jest.requireActual('../src/services/crm/activityTypeFallback'),
  restoreCarrierType: (r: any) => r,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const LEAD = '11111111-1111-1111-1111-111111111111';
const REP = '22222222-2222-2222-2222-222222222222';
const SPARK = 'c0218852-0a19-4dd0-b9fa-72f9e32ed0d8'; // connected-B2B
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const app = express();
app.use(express.json());
app.use('/crm', crmRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));

// Capture the filters of the crm_activities SELECT the handler builds.
let lastActivityOrs: string[] = [];
beforeEach(() => {
  __mock.reset();
  lastActivityOrs = [];
  __mock.setDefault('crm_activities', (chain: any) => {
    if (!chain.ops.some((o: any) => o.method === 'insert' || o.method === 'update')) {
      lastActivityOrs = chain.ors.slice();
    }
    // One activity owned by SOMEONE ELSE — visible only if no owner filter is applied.
    return { data: [{ id: 'a1', org_id: ORG, lead_id: LEAD, type: 'call', owner_id: 'someone-else', assigned_to: 'someone-else' }] };
  });
  __mock.setDefault('crm_activity_assignees', { data: [] });
  __mock.setDefault('crm_leads', { data: { id: LEAD, client_id: SPARK } });
  __mock.setDefault('users', { data: [] });
  __mock.setDefault('clients', { data: [] });
});

const hasOwnerFilter = () => lastActivityOrs.some((o) => o.includes(`owner_id.eq.${REP}`) || o.includes(`assigned_to.eq.${REP}`));

describe('lead /:id/activities visibility', () => {
  it('a connected-B2B rep sees the whole lead timeline (no owner filter)', async () => {
    CURRENT_USER = { id: REP, org_id: ORG, client_id: SPARK, role: 'executive' };
    const res = await request(app).get(`/crm/leads/${LEAD}/activities`);
    expect(res.status).toBe(200);
    expect(hasOwnerFilter()).toBe(false);
  });

  it('a non-B2B rep is still owner-scoped on the lead timeline (unchanged)', async () => {
    CURRENT_USER = { id: REP, org_id: ORG, client_id: OTHER, role: 'executive' };
    const res = await request(app).get(`/crm/leads/${LEAD}/activities`);
    expect(res.status).toBe(200);
    expect(hasOwnerFilter()).toBe(true);
  });

  it('the account timeline is relaxed for connected-B2B too', async () => {
    CURRENT_USER = { id: REP, org_id: ORG, client_id: SPARK, role: 'executive' };
    __mock.setDefault('crm_accounts', { data: { id: 'acc-1', client_id: SPARK } });
    const res = await request(app).get(`/crm/accounts/acc-1/activities`);
    expect(res.status).toBe(200);
    expect(hasOwnerFilter()).toBe(false);
  });
});
