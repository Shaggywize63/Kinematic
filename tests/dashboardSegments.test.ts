/**
 * CRM dashboard: `leads_by_segment` { b2b, b2c } — total leads per lead type, on the same basis as
 * total_leads, and ONLY for a client that has named its lead types (config.lead_form.segment_labels).
 * Every other client must get a byte-identical response.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock, RecordedChain } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: null, org_role_data_scope: 'all' };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
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
import * as analytics from '../src/services/crm/analytics.service';
import { hasSegmentLabels, loadLeadFormConfig } from '../src/services/crm/leadFormConfig';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const AGRI = '55555555-5555-5555-5555-555555555555';
const TATA = '66666666-6666-6666-6666-666666666666';
const LABELS = { lead_form: { segment_labels: { b2b: 'Dealer', b2c: 'Farmers' } } };

/** The keys dashboardSummary returned before this change. */
const ORIGINAL_KEYS = [
  'total_leads', 'new_leads_30d', 'open_deals', 'open_deal_value', 'open_deal_volume', 'won_deals_30d', 'won_revenue_30d',
  'win_rate_30d', 'avg_deal_size', 'avg_sales_cycle_days', 'pipeline_velocity', 'activities_7d', 'conversion_rate',
  'estimates_raised', 'by_stage', 'by_owner', 'by_source',
];

const segmentOf = (c: RecordedChain) => c.ops.find((o) => o.method === 'eq' && o.args[0] === 'is_b2c');
const isHeadCount = (c: RecordedChain) => c.ops.some((o) => o.method === 'select' && (o.args[1] as any)?.head === true);

/** crm_leads: 40 leads in total, 12 dealers, 28 farmers — for head counts; no rows otherwise. */
function leadCounts() {
  __mock.setDefault('crm_leads', (chain) => {
    const seg = segmentOf(chain);
    const count = seg ? (seg.args[1] === true ? 28 : 12) : 40;
    return { data: isHeadCount(chain) ? null : [], count };
  });
}
/** Settings: a per-client config row (or none) and an org-level default row. */
function settings(byClient: Record<string, unknown | null>, orgDefault: unknown | null = null) {
  __mock.setDefault('crm_settings', (chain) => {
    const cid = chain.eqs['client_id'];
    const isOrgLevel = chain.ops.some((o) => o.method === 'is' && o.args[0] === 'client_id');
    const cfg = isOrgLevel ? orgDefault : byClient[String(cid)] ?? null;
    return { data: cfg ? [{ config: cfg }] : [] };
  });
}
const segmentChains = () => __mock.chainsFor('crm_leads').filter((c) => segmentOf(c));
const totalChain = () => __mock.chainsFor('crm_leads').find((c) => isHeadCount(c) && !segmentOf(c) && !c.ops.some((o) => o.method === 'gte'))!;

beforeEach(() => { __mock.reset(); leadCounts(); });

describe('hasSegmentLabels', () => {
  it('is true only when a lead type has been named', () => {
    expect(hasSegmentLabels({ segment_labels: { b2b: 'Dealer', b2c: 'Farmers' } })).toBe(true);
    expect(hasSegmentLabels({ segment_labels: { b2c: 'Farmers' } })).toBe(true);
  });
  it('is false for everything else', () => {
    for (const lf of [null, undefined, {}, { segment_labels: {} }, { segment_labels: { b2b: '  ' } }, { segment_labels: null },
      { segment_labels: ['Dealer'] }, { segment_labels: 'Dealer' }, { segment_labels: { b2b: 5 } }, { address_on_b2b: true }]) {
      expect({ lf, out: hasSegmentLabels(lf as any) }).toEqual({ lf, out: false });
    }
  });
});

describe('loadLeadFormConfig', () => {
  it('prefers the client\'s own row', async () => {
    settings({ [AGRI]: LABELS }, { lead_form: { segment_labels: { b2b: 'Org' } } });
    expect(await loadLeadFormConfig(ORG, AGRI)).toEqual(LABELS.lead_form);
  });
  it('falls back to the org-level default row, like GET /crm/settings does', async () => {
    settings({}, LABELS);
    expect(await loadLeadFormConfig(ORG, AGRI)).toEqual(LABELS.lead_form);
  });
  it('reads only the org-level row when no client is picked', async () => {
    settings({ [AGRI]: LABELS }, null);
    expect(await loadLeadFormConfig(ORG, null)).toBeNull();
    expect(__mock.chainsFor('crm_settings')).toHaveLength(1);
  });
  it('is null when nothing is configured', async () => {
    settings({});
    expect(await loadLeadFormConfig(ORG, AGRI)).toBeNull();
  });
});

describe('dashboardSummary', () => {
  it('adds leads_by_segment for a client that named its lead types, counting the same leads as total_leads', async () => {
    settings({ [AGRI]: LABELS });
    const s = await analytics.dashboardSummary(ORG, undefined, AGRI);
    expect(s.total_leads).toBe(40);
    expect(s.leads_by_segment).toEqual({ b2b: 12, b2c: 28 });

    const [b2b, b2c] = [false, true].map((v) => segmentChains().find((c) => segmentOf(c)!.args[1] === v)!);
    expect(b2b).toBeDefined(); expect(b2c).toBeDefined();
    expect(segmentChains()).toHaveLength(2);                  // exactly two head counts
    expect(segmentChains().every(isHeadCount)).toBe(true);
    // identical basis: same org, same soft-delete rule, same client, no date window
    for (const c of [b2b, b2c]) {
      expect(c.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
      expect(c.ops).toContainEqual({ method: 'is', args: ['deleted_at', null] });
      expect(c.ops.some((o) => o.method === 'gte' || o.method === 'lte')).toBe(false);
    }
    const t = totalChain();
    expect(t.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
  });

  it('applies the caller\'s visibility scope to the split exactly as it does to total_leads', async () => {
    settings({ [AGRI]: LABELS });
    const scope = { effectiveCities: ['Pune'], visibleOwnerIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'], selfOwnerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', includeNullCity: false };
    await analytics.dashboardSummary(ORG, undefined, AGRI, 'inr', scope);
    const expectedOr = totalChain().ors;
    expect(expectedOr).toHaveLength(1);
    for (const c of segmentChains()) expect(c.ors).toEqual(expectedOr);
  });

  it('leaves the response byte-identical for a client with no lead types named', async () => {
    for (const cfg of [{}, { lead_form: { address_on_b2b: true } }, { lead_form: { segment_labels: {} } }, { field_overrides: {} }]) {
      __mock.reset(); leadCounts(); settings({ [TATA]: cfg });
      const s = await analytics.dashboardSummary(ORG, undefined, TATA);
      expect('leads_by_segment' in s).toBe(false);
      expect(Object.keys(s)).toEqual(ORIGINAL_KEYS);
      expect(JSON.stringify(s)).not.toMatch(/segment/);
      expect(segmentChains()).toHaveLength(0);               // not even queried
    }
  });

  it('leaves it alone when the client has no settings row at all', async () => {
    settings({});
    const s = await analytics.dashboardSummary(ORG, undefined, TATA);
    expect(Object.keys(s)).toEqual(ORIGINAL_KEYS);
    expect(segmentChains()).toHaveLength(0);
  });

  it('keeps the dashboard working when the settings read or a count fails', async () => {
    __mock.setDefault('crm_settings', { data: null, error: { message: 'settings down' } });
    let s = await analytics.dashboardSummary(ORG, undefined, AGRI);
    expect(Object.keys(s)).toEqual(ORIGINAL_KEYS);

    __mock.reset();
    settings({ [AGRI]: LABELS });
    __mock.setDefault('crm_leads', (chain) => (segmentOf(chain) ? { data: null, error: { message: 'count failed' } } : { data: [], count: 40 }));
    s = await analytics.dashboardSummary(ORG, undefined, AGRI);
    expect(s.total_leads).toBe(40);
    expect(Object.keys(s)).toEqual(ORIGINAL_KEYS);
  });

  it('reports zeros, not missing keys, when a client has no leads of one type', async () => {
    settings({ [AGRI]: LABELS });
    __mock.setDefault('crm_leads', (chain) => {
      const seg = segmentOf(chain);
      return { data: [], count: seg ? (seg.args[1] === true ? 5 : 0) : 5 };
    });
    expect((await analytics.dashboardSummary(ORG, undefined, AGRI)).leads_by_segment).toEqual({ b2b: 0, b2c: 5 });
  });
});

describe('dashboardComplete', () => {
  it('carries the split inside summary, and nothing else changes shape', async () => {
    settings({ [AGRI]: LABELS });
    const c: any = await analytics.dashboardComplete(ORG, undefined, AGRI);
    expect(c.summary.leads_by_segment).toEqual({ b2b: 12, b2c: 28 });
    expect(Object.keys(c)).toEqual(['summary', 'funnel', 'pipelineValue', 'winRate', 'forecast', 'leadScoreDistribution', 'unit']);
  });
});

// ── through the real routes, and their 60 s cache ────────────────────────────
describe('GET /crm/analytics/dashboard-summary and /dashboard-complete', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));

  it('serves the split to the client that named its lead types and not to another, even from the cache', async () => {
    settings({ [AGRI]: LABELS, [TATA]: {} });
    const a1 = await request(app).get('/crm/analytics/dashboard-summary').set('X-Client-Id', AGRI).query({ from: '2026-02-01T00:00:00.000Z' });
    expect(a1.status).toBe(200);
    // the CRM router wraps every JSON reply as { success, data }
    expect(a1.body.data.leads_by_segment).toEqual({ b2b: 12, b2c: 28 });

    const t1 = await request(app).get('/crm/analytics/dashboard-summary').set('X-Client-Id', TATA).query({ from: '2026-02-01T00:00:00.000Z' });
    expect(t1.status).toBe(200);
    expect('leads_by_segment' in t1.body.data).toBe(false);     // not served the other client's cached payload

    // a repeat is served from the cache and still carries the field (it is part of the cached payload)
    __mock.chains.length = 0;
    const a2 = await request(app).get('/crm/analytics/dashboard-summary').set('X-Client-Id', AGRI).query({ from: '2026-02-01T00:00:00.000Z' });
    expect(a2.body).toEqual(a1.body);
    expect(__mock.chainsFor('crm_leads')).toHaveLength(0);       // no queries: it came from the cache
    const t2 = await request(app).get('/crm/analytics/dashboard-summary').set('X-Client-Id', TATA).query({ from: '2026-02-01T00:00:00.000Z' });
    expect('leads_by_segment' in t2.body.data).toBe(false);
  });

  it('does the same for dashboard-complete (inside summary)', async () => {
    settings({ [AGRI]: LABELS, [TATA]: {} });
    const a = await request(app).get('/crm/analytics/dashboard-complete').set('X-Client-Id', AGRI).query({ from: '2026-03-01T00:00:00.000Z' });
    const t = await request(app).get('/crm/analytics/dashboard-complete').set('X-Client-Id', TATA).query({ from: '2026-03-01T00:00:00.000Z' });
    expect(a.status).toBe(200);
    expect(a.body.data.summary.leads_by_segment).toEqual({ b2b: 12, b2c: 28 });
    expect('leads_by_segment' in t.body.data.summary).toBe(false);
  });
});
