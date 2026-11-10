/**
 * Lead Management "plus" analytics (src/services/crm/analytics-leads-plus.service.ts).
 *
 * Each report is driven against in-memory tables that APPLY the recorded filters
 * (tests/helpers/crmPlusFake.ts), so the tests assert exact numbers on a small
 * seeded dataset, that another org's / another client's / soft-deleted rows never
 * appear, that the caller's visibility scope is applied exactly as in the
 * neighbouring analytics, that bad input is a 400, and that an empty org answers
 * with zeros instead of an error.
 */
import { createSupabaseMock } from './helpers/supabaseMock';
import { installTables } from './helpers/crmPlusFake';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };

import * as plus from '../src/services/crm/analytics-leads-plus.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
const AGRI = '55555555-5555-5555-5555-555555555555';
const OTHER_CLIENT = '66666666-6666-6666-6666-666666666666';
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const S1 = 'a1111111-1111-1111-1111-111111111111';
const S2 = 'a2222222-2222-2222-2222-222222222222';
const P1 = 'b1111111-1111-1111-1111-111111111111';
const P2 = 'b2222222-2222-2222-2222-222222222222';
const NOW = Date.parse('2026-11-10T12:00:00.000Z'); // a Tuesday

const users = [
  { id: U1, name: 'Asha', email: 'asha@example.com' },
  { id: U2, name: 'Ravi', email: 'ravi@example.com' },
];
const sources = [
  { id: S1, org_id: ORG, name: 'Website', cost_per_lead: 100 },
  { id: S2, org_id: ORG, name: 'Referral', cost_per_lead: 0 },
];
const stages = [
  { id: 'st-lead', org_id: ORG, pipeline_id: P1, name: 'Lead', position: 0, stage_type: 'open', probability: 10 },
  { id: 'st-prop', org_id: ORG, pipeline_id: P1, name: 'Proposal', position: 1, stage_type: 'open', probability: 50 },
  { id: 'st-won', org_id: ORG, pipeline_id: P1, name: 'Won', position: 2, stage_type: 'won', probability: 100 },
  { id: 'st-lost', org_id: ORG, pipeline_id: P1, name: 'Lost', position: 3, stage_type: 'lost', probability: 0 },
  { id: 'st-p2', org_id: ORG, pipeline_id: P2, name: 'Other pipeline stage', position: 0, stage_type: 'open', probability: 20 },
  { id: 'st-foreign', org_id: OTHER_ORG, pipeline_id: 'b9999999-9999-9999-9999-999999999999', name: 'Foreign', position: 0, stage_type: 'open', probability: 90 },
];
const pipelines = [
  { id: P1, org_id: ORG, name: 'Sales', is_default: true },
  { id: P2, org_id: ORG, name: 'Renewals', is_default: false },
];

beforeEach(() => { __mock.reset(); });

// ────────────────────────────────────────────────────────────────────────────
describe('sourcePerformance', () => {
  const lead = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: AGRI, deleted_at: null, score: 0, converted_at: null, converted_deal_id: null, ...o });
  const leads = [
    lead({ id: 'L1', source_id: S1, status: 'converted', created_at: '2026-10-02T10:00:00.000Z', converted_at: '2026-10-12T10:00:00.000Z', converted_deal_id: 'D1', score: 80 }),
    lead({ id: 'L2', source_id: S1, status: 'qualified', created_at: '2026-10-05T10:00:00.000Z', score: 60 }),
    lead({ id: 'L3', source_id: S1, status: 'lost', created_at: '2026-10-20T10:00:00.000Z', score: 20 }),
    lead({ id: 'L4', source_id: S1, status: 'new', created_at: '2026-10-31T23:00:00.000Z', score: 40 }), // last day of a date-only `to`
    lead({ id: 'L5', source_id: S2, status: 'converted', created_at: '2026-10-10T10:00:00.000Z', converted_at: '2026-10-14T10:00:00.000Z', converted_deal_id: 'D2', score: 90 }),
    lead({ id: 'L6', source_id: S2, status: 'working', created_at: '2026-10-15T10:00:00.000Z', score: 50 }),
    lead({ id: 'L7', source_id: null, status: 'unqualified', created_at: '2026-10-16T10:00:00.000Z', score: 10 }),
    lead({ id: 'L8', source_id: S1, status: 'new', created_at: '2026-09-30T23:59:59.000Z' }),                    // before the window
    lead({ id: 'L9', org_id: OTHER_ORG, source_id: S1, status: 'converted', created_at: '2026-10-10T10:00:00.000Z' }), // another org
    lead({ id: 'L10', source_id: S1, status: 'new', created_at: '2026-10-10T10:00:00.000Z', deleted_at: '2026-10-11T00:00:00.000Z' }),
    lead({ id: 'L11', client_id: OTHER_CLIENT, source_id: S1, status: 'new', created_at: '2026-10-10T10:00:00.000Z' }),
  ];
  const deals = [
    { id: 'D1', org_id: ORG, deleted_at: null, amount: 50000, stage_id: 'st-won' },
    { id: 'D2', org_id: ORG, deleted_at: null, amount: 30000, stage_id: 'st-won' },
  ];
  beforeEach(() => installTables(__mock, { crm_leads: leads, crm_lead_sources: sources, crm_deal_stages: stages, crm_deals: deals }));

  it('rolls leads up per source with exact counts, rates, days, score, value and cost', async () => {
    const r = await plus.sourcePerformance(ORG, AGRI, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.rows.map((x) => x.source)).toEqual(['Website', 'Referral', 'Unspecified']);
    const [web, ref, none] = r.rows;
    expect(web).toMatchObject({
      leads: 4, qualified: 2, converted: 1, lost: 1, unqualified: 0, open: 2,
      qualified_pct: 50, conversion_pct: 25, share_of_leads_pct: 57.1,
      avg_days_to_convert: 10, avg_score: 50, won_value: 50000, revenue_per_lead: 12500,
      cost_per_lead: 100, total_cost: 400, cost_per_converted: 400,
    });
    expect(ref).toMatchObject({
      leads: 2, qualified: 1, converted: 1, open: 1, conversion_pct: 50, avg_days_to_convert: 4, avg_score: 70,
      won_value: 30000, revenue_per_lead: 15000, total_cost: 0, cost_per_converted: null,
    });
    expect(none).toMatchObject({ leads: 1, unqualified: 1, conversion_pct: 0, avg_days_to_convert: null, source_id: null });
    expect(r.totals).toMatchObject({
      leads: 7, qualified: 3, converted: 2, lost: 1, unqualified: 1, open: 3, conversion_pct: 28.6,
      avg_days_to_convert: 7, won_value: 80000, revenue_per_lead: 11429, total_cost: 400, cost_per_converted: 200,
    });
  });

  it('never includes another org, another client, a soft-deleted or an out-of-window lead', async () => {
    const r = await plus.sourcePerformance(ORG, AGRI, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.totals.leads).toBe(7);
    const chain = __mock.chainsFor('crm_leads')[0];
    expect(chain.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
    expect(chain.ops).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    // without a client pick the org view keeps every client of this org (still never another org)
    __mock.reset(); installTables(__mock, { crm_leads: leads, crm_lead_sources: sources, crm_deal_stages: stages, crm_deals: deals });
    expect((await plus.sourcePerformance(ORG, null, { from: '2026-10-01', to: '2026-10-31' })).totals.leads).toBe(8);
  });

  it('applies the caller\'s lead scope as a single OR, identical to the neighbouring analytics', async () => {
    const scope = { effectiveCities: ['Pune'], visibleOwnerIds: [U1], selfOwnerId: U1, includeNullCity: false };
    await plus.sourcePerformance(ORG, AGRI, undefined, scope);
    const { applyLeadScope } = require('../src/services/crm/analytics.service');
    const expected = (applyLeadScope({ or: (s: string) => s }, scope) as string);
    expect(__mock.chainsFor('crm_leads')[0].ors).toEqual([expected]);
  });

  it('answers an empty org with an empty list and zero totals', async () => {
    __mock.reset();
    const r = await plus.sourcePerformance(ORG, null, {});
    expect(r.rows).toEqual([]);
    expect(r.totals).toMatchObject({ leads: 0, converted: 0, conversion_pct: null, avg_days_to_convert: null, won_value: 0, revenue_per_lead: null });
  });

  it('rejects a window whose from is after its to', async () => {
    await expect(plus.sourcePerformance(ORG, null, { from: '2026-10-31', to: '2026-10-01' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('followupCompliance', () => {
  const act = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: null, assigned_to: null, completed_at: null, status: 'open', ...o });
  const acts = [
    act({ id: 'A1', owner_id: U1, due_at: '2026-11-02T10:00:00.000Z', completed_at: '2026-11-02T09:00:00.000Z', status: 'done' }),   // on time
    act({ id: 'A2', owner_id: U1, due_at: '2026-11-03T10:00:00.000Z', completed_at: '2026-11-04T10:00:00.000Z', status: 'done' }),   // 1 day late
    act({ id: 'A3', owner_id: U1, due_at: '2026-11-05T10:00:00.000Z' }),                                                             // overdue
    act({ id: 'A4', owner_id: U2, due_at: '2026-11-12T10:00:00.000Z' }),                                                             // upcoming
    act({ id: 'A5', owner_id: U2, due_at: '2026-11-06T10:00:00.000Z', status: 'cancelled' }),                                        // ignored
    act({ id: 'A6', owner_id: U2, due_at: '2026-11-07T10:00:00.000Z', status: 'done' }),                                             // done, no time
    act({ id: 'A7', owner_id: U2, due_at: '2026-11-08T10:00:00.000Z', completed_at: '2026-11-08T10:00:00.000Z', status: 'done' }),   // exactly on time
    act({ id: 'A8', owner_id: U1, assigned_to: U2, due_at: '2026-11-06T12:00:00.000Z', completed_at: '2026-11-08T12:00:00.000Z', status: 'done' }), // 2 days late, assigned wins
    act({ id: 'A9', org_id: OTHER_ORG, owner_id: U1, due_at: '2026-11-02T10:00:00.000Z' }),
    act({ id: 'A10', owner_id: U1, due_at: '2026-10-20T10:00:00.000Z' }),
    act({ id: 'A11', owner_id: U1, due_at: '2026-11-04T10:00:00.000Z', deleted_at: '2026-11-05T00:00:00.000Z' }),
    act({ id: 'A12', owner_id: U1, due_at: null }),
  ];
  beforeEach(() => installTables(__mock, { crm_activities: acts, users }));

  it('splits scheduled activities into on time / late / overdue / upcoming with exact compliance', async () => {
    const r = await plus.followupCompliance(ORG, null, { from: '2026-11-01', to: '2026-11-15' }, undefined, NOW);
    const asha = r.rows.find((x) => x.owner === 'Asha')!;
    const ravi = r.rows.find((x) => x.owner === 'Ravi')!;
    expect(asha).toMatchObject({ due: 3, on_time: 1, late: 1, overdue: 1, upcoming: 0, done_untimed: 0, compliance_pct: 33.3, avg_days_late: 1, avg_days_overdue: 5.1 });
    expect(ravi).toMatchObject({ due: 4, on_time: 1, late: 1, overdue: 0, upcoming: 1, done_untimed: 1, compliance_pct: 50, avg_days_late: 2, avg_days_overdue: null });
    expect(r.totals).toMatchObject({ owner: 'Everyone', due: 7, on_time: 2, late: 2, overdue: 1, upcoming: 1, done_untimed: 1, compliance_pct: 40, avg_days_late: 1.5, avg_days_overdue: 5.1 });
    expect(r.trend).toEqual([
      { week: '2026-11-02', due: 6, on_time: 2, late: 2, overdue: 1, upcoming: 0, compliance_pct: 40 },
      { week: '2026-11-09', due: 1, on_time: 0, late: 0, overdue: 0, upcoming: 1, compliance_pct: null },
    ]);
  });

  it('only reads this org\'s live scheduled activities and applies the activity scope (owner OR assignee)', async () => {
    const scope = { effectiveCities: null, visibleOwnerIds: [U1], selfOwnerId: U1 };
    await plus.followupCompliance(ORG, AGRI, { from: '2026-11-01', to: '2026-11-15' }, scope, NOW);
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
    expect(chain.ops).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(chain.ors).toEqual([`owner_id.in.(${U1}),assigned_to.in.(${U1})`]);
  });

  it('an empty org is zeros and an empty list', async () => {
    __mock.reset();
    const r = await plus.followupCompliance(ORG, null, undefined, undefined, NOW);
    expect(r.rows).toEqual([]);
    expect(r.trend).toEqual([]);
    expect(r.totals).toMatchObject({ due: 0, compliance_pct: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('ownerWorkload', () => {
  const lead = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, last_activity_at: null, ...o });
  const leads = [
    lead({ id: 'O1', owner_id: U1, status: 'new', created_at: '2026-11-09T12:00:00.000Z' }),
    lead({ id: 'O2', owner_id: U1, status: 'working', created_at: '2026-10-01T12:00:00.000Z', last_activity_at: '2026-10-31T12:00:00.000Z' }),
    lead({ id: 'O3', owner_id: U1, status: 'qualified', created_at: '2026-09-01T12:00:00.000Z', last_activity_at: '2026-10-20T12:00:00.000Z' }),
    lead({ id: 'O4', owner_id: U2, status: 'new', created_at: '2026-08-01T12:00:00.000Z' }),
    lead({ id: 'O5', owner_id: null, status: 'working', created_at: '2026-11-05T12:00:00.000Z', last_activity_at: '2026-11-06T12:00:00.000Z' }),
    lead({ id: 'C1', owner_id: U1, status: 'converted', created_at: '2026-10-01T12:00:00.000Z' }),
    lead({ id: 'N1', owner_id: U2, status: 'lost', created_at: '2026-11-03T08:00:00.000Z' }),
    lead({ id: 'X1', org_id: OTHER_ORG, owner_id: U1, status: 'new', created_at: '2026-11-04T12:00:00.000Z' }),
  ];
  const act = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: null, assigned_to: null, lead_id: null, completed_at: null, status: 'open', due_at: null, ...o });
  const acts = [
    act({ id: 'F1', lead_id: 'O1', created_at: '2026-11-09T12:30:00.000Z' }),   // first touch after 30 min
    act({ id: 'F2', lead_id: 'O1', created_at: '2026-11-09T18:00:00.000Z' }),   // not the first
    act({ id: 'F3', lead_id: 'O5', created_at: '2026-11-05T15:00:00.000Z' }),   // 180 min
    act({ id: 'F4', lead_id: 'O4', created_at: '2026-10-15T10:00:00.000Z' }),   // before the window: ignored
    act({ id: 'V1', assigned_to: U1, due_at: '2026-11-08T10:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' }),
    act({ id: 'V2', owner_id: U1, due_at: '2026-11-01T10:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' }),
    act({ id: 'V3', assigned_to: U2, owner_id: U1, due_at: '2026-11-09T10:00:00.000Z', status: 'planned', created_at: '2026-11-01T00:00:00.000Z' }),
    act({ id: 'V4', owner_id: U1, due_at: '2026-11-01T10:00:00.000Z', status: 'done', completed_at: '2026-11-01T11:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' }), // done
    act({ id: 'V5', owner_id: U1, due_at: '2026-11-12T10:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' }),                                                           // not yet due
    act({ id: 'V6', org_id: OTHER_ORG, owner_id: U1, due_at: '2026-11-01T10:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' }),
  ];
  beforeEach(() => installTables(__mock, { crm_leads: leads, crm_activities: acts, users }));

  it('computes open load, idle buckets, overdue follow-ups and first-touch SLA per owner', async () => {
    const r = await plus.ownerWorkload(ORG, null, { from: '2026-11-01', to: '2026-11-10' }, undefined, undefined, NOW);
    expect(r.sla_minutes).toBe(60);
    const asha = r.rows.find((x) => x.owner === 'Asha')!;
    const ravi = r.rows.find((x) => x.owner === 'Ravi')!;
    const none = r.rows.find((x) => x.owner === 'Unassigned')!;
    expect(r.rows.map((x) => x.owner)).toEqual(['Asha', 'Ravi', 'Unassigned']); // open_leads 3, 1, 1; name breaks the tie
    expect(asha).toMatchObject({
      open_leads: 3, share_of_open_pct: 60, new_leads: 1, never_touched: 1, idle_7d: 2, idle_14d: 1, idle_30d: 0,
      avg_open_age_days: 37, overdue_followups: 2, first_touch_leads: 1, median_first_touch_minutes: 30, sla_breach_pct: 0,
    });
    expect(ravi).toMatchObject({
      open_leads: 1, share_of_open_pct: 20, new_leads: 1, never_touched: 1, idle_7d: 1, idle_14d: 1, idle_30d: 1,
      avg_open_age_days: 101, overdue_followups: 1, first_touch_leads: 0, median_first_touch_minutes: null, sla_breach_pct: null,
    });
    expect(none).toMatchObject({ open_leads: 1, new_leads: 1, idle_7d: 0, avg_open_age_days: 5, overdue_followups: 0, first_touch_leads: 1, median_first_touch_minutes: 180, sla_breach_pct: 100 });
    expect(r.totals).toMatchObject({
      owner: 'Everyone', open_leads: 5, new_leads: 3, never_touched: 2, idle_7d: 3, idle_14d: 2, idle_30d: 1,
      avg_open_age_days: 43.4, overdue_followups: 3, first_touch_leads: 2, median_first_touch_minutes: 105, sla_breach_pct: 50,
    });
  });

  it('honours a custom SLA and rejects a bad one', async () => {
    const r = await plus.ownerWorkload(ORG, null, { from: '2026-11-01', to: '2026-11-10' }, '240', undefined, NOW);
    expect(r.sla_minutes).toBe(240);
    expect(r.totals.sla_breach_pct).toBe(0);
    for (const bad of ['0', '-5', 'abc', '1.5', '99999']) {
      await expect(plus.ownerWorkload(ORG, null, undefined, bad, undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('scopes leads and overdue activities with the shared scope helpers', async () => {
    const scope = { effectiveCities: null, visibleOwnerIds: [U1], selfOwnerId: U1 };
    await plus.ownerWorkload(ORG, AGRI, undefined, undefined, scope, NOW);
    for (const c of __mock.chainsFor('crm_leads')) {
      expect(c.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
      expect(c.ors).toEqual([`owner_id.eq.${U1},owner_id.in.(${U1})`]);
    }
    const overdueChain = __mock.chainsFor('crm_activities').find((c) => c.ops.some((o) => o.method === 'lt'))!;
    expect(overdueChain.ors).toEqual([`owner_id.in.(${U1}),assigned_to.in.(${U1})`]);
  });

  it('an empty org is zeros', async () => {
    __mock.reset();
    const r = await plus.ownerWorkload(ORG, null, undefined, undefined, undefined, NOW);
    expect(r.rows).toEqual([]);
    expect(r.totals).toMatchObject({ open_leads: 0, new_leads: 0, median_first_touch_minutes: null, sla_breach_pct: null, avg_open_age_days: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('stageVelocity', () => {
  const deal = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, pipeline_id: P1, owner_id: U1, ...o });
  const deals = [
    deal({ id: 'D1', stage_id: 'st-won', amount: 100000, created_at: '2026-10-01T00:00:00.000Z' }),
    deal({ id: 'D2', stage_id: 'st-prop', amount: 20000, created_at: '2026-10-10T00:00:00.000Z' }),
    deal({ id: 'D3', stage_id: 'st-lead', amount: 10000, created_at: '2026-11-01T00:00:00.000Z' }),
    deal({ id: 'D4', stage_id: 'st-prop', amount: 30000, created_at: '2026-09-01T00:00:00.000Z' }),
    deal({ id: 'D5', pipeline_id: P2, stage_id: 'st-p2', amount: 1, created_at: '2026-10-01T00:00:00.000Z' }),
    deal({ id: 'D6', org_id: OTHER_ORG, stage_id: 'st-lead', amount: 1, created_at: '2026-10-01T00:00:00.000Z' }),
    deal({ id: 'D7', stage_id: 'st-lead', amount: 1, created_at: '2026-10-01T00:00:00.000Z', deleted_at: '2026-10-02T00:00:00.000Z' }),
  ];
  const h = (deal_id: string, from: string | null, to: string | null, at: string) => ({ org_id: ORG, deal_id, from_stage_id: from, to_stage_id: to, created_at: at });
  const history = [
    h('D1', 'st-lead', 'st-prop', '2026-10-05T00:00:00.000Z'),
    h('D1', 'st-prop', 'st-won', '2026-10-15T00:00:00.000Z'),
    h('D2', 'st-lead', 'st-prop', '2026-10-12T00:00:00.000Z'),
    h('D4', 'st-lead', 'st-prop', '2026-09-11T00:00:00.000Z'),
    h('D4', 'st-prop', 'st-lead', '2026-09-21T00:00:00.000Z'),
    h('D4', 'st-lead', 'st-prop', '2026-10-01T00:00:00.000Z'),
    h('D4', null, null, '2026-10-02T00:00:00.000Z'), // status-only change: ignored
  ];
  beforeEach(() => installTables(__mock, { crm_pipelines: pipelines, crm_deal_stages: stages, crm_deals: deals, crm_deal_history: history }));

  it('measures days per stage from the stage history and how long open deals have sat', async () => {
    const r = await plus.stageVelocity(ORG, null, undefined, undefined, NOW);
    expect(r.pipeline_id).toBe(P1); // the default pipeline
    expect(r.pipelines.map((p) => p.id)).toEqual([P1, P2]);
    expect(r.rows.map((x) => x.stage)).toEqual(['Lead', 'Proposal', 'Won', 'Lost']);
    const [lead, prop, won, lost] = r.rows;
    expect(lead).toMatchObject({ deals_entered: 4, completed_stays: 4, avg_days: 6.5, median_days: 7, max_days: 10, current_deals: 1, current_value: 10000, avg_current_age_days: 9.5, slow_current_deals: 0 });
    expect(prop).toMatchObject({ deals_entered: 3, completed_stays: 2, avg_days: 10, median_days: 10, max_days: 10, current_deals: 2, current_value: 50000, avg_current_age_days: 35, slow_current_deals: 0 });
    expect(won).toMatchObject({ deals_entered: 1, completed_stays: 0, avg_days: null, current_deals: 0 });
    expect(lost).toMatchObject({ deals_entered: 0, completed_stays: 0, current_deals: 0 });
    expect(r.totals).toEqual({ open_deals: 3, open_value: 60000, typical_days_through_open_stages: 16.5 });
  });

  it('flags open deals sitting more than twice a stage\'s average once it has 3+ completed stays', async () => {
    const extra = [
      deal({ id: 'D8', stage_id: 'st-lead', amount: 5, created_at: '2026-09-01T00:00:00.000Z' }), // no history: in Lead for ~70 days
    ];
    __mock.reset();
    installTables(__mock, { crm_pipelines: pipelines, crm_deal_stages: stages, crm_deals: [...deals, ...extra], crm_deal_history: history });
    const lead = (await plus.stageVelocity(ORG, null, P1, undefined, NOW)).rows[0];
    expect(lead.current_deals).toBe(2);
    expect(lead.slow_current_deals).toBe(1); // D8 (70.5 d) > 2 x 6.5; D3 (9.5 d) is not
  });

  it('can be pointed at another pipeline and never leaks another org\'s stages', async () => {
    const r = await plus.stageVelocity(ORG, null, P2, undefined, NOW);
    expect(r.pipeline_id).toBe(P2);
    expect(r.rows.map((x) => x.stage)).toEqual(['Other pipeline stage']);
    expect(r.rows[0]).toMatchObject({ deals_entered: 1, current_deals: 1 });
  });

  it('applies the owner scope to deals', async () => {
    await plus.stageVelocity(ORG, AGRI, undefined, { effectiveCities: null, visibleOwnerIds: [U1], selfOwnerId: U1 }, NOW);
    const dealChain = __mock.chainsFor('crm_deals')[0];
    expect(dealChain.eqs).toMatchObject({ org_id: ORG, client_id: AGRI, pipeline_id: P1 });
    expect(dealChain.ops).toContainEqual({ method: 'in', args: ['owner_id', [U1]] });
  });

  it('rejects a malformed pipeline_id (400) before any query runs', async () => {
    __mock.reset();
    await expect(plus.stageVelocity(ORG, null, 'x,id.eq.1', undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(__mock.chains).toHaveLength(0);
  });

  it('an org with no pipelines answers an empty report', async () => {
    __mock.reset();
    const r = await plus.stageVelocity(ORG, null, undefined, undefined, NOW);
    expect(r).toMatchObject({ pipeline_id: null, rows: [], totals: { open_deals: 0, open_value: 0, typical_days_through_open_stages: null } });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('activityMix', () => {
  const act = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: null, assigned_to: null, completed_at: null, outcome: null, ...o });
  const acts = [
    act({ id: 'm1', owner_id: U1, type: 'call', completed_at: '2026-11-02T10:30:00.000Z', outcome: 'Connected – interested', created_at: '2026-11-02T10:00:00.000Z' }),
    act({ id: 'm2', owner_id: U1, type: 'call', outcome: 'Not reachable', created_at: '2026-11-02T11:00:00.000Z' }),
    act({ id: 'm3', owner_id: U1, type: 'call', created_at: '2026-11-03T10:00:00.000Z' }),
    act({ id: 'm4', owner_id: U1, type: 'email', completed_at: '2026-11-03T11:00:00.000Z', created_at: '2026-11-03T10:30:00.000Z' }),
    act({ id: 'm5', owner_id: U1, type: 'meeting', completed_at: '2026-11-04T12:00:00.000Z', created_at: '2026-11-04T09:00:00.000Z' }),
    act({ id: 'm6', owner_id: U2, type: 'sms', created_at: '2026-11-04T10:00:00.000Z' }),
    act({ id: 'm7', owner_id: U2, type: 'visit', completed_at: '2026-11-05T12:00:00.000Z', created_at: '2026-11-05T09:00:00.000Z' }),
    act({ id: 'm8', owner_id: U1, assigned_to: U2, type: 'note', created_at: '2026-11-05T10:00:00.000Z' }),
    act({ id: 'm9', org_id: OTHER_ORG, owner_id: U1, type: 'call', created_at: '2026-11-03T10:00:00.000Z' }),
    act({ id: 'm10', owner_id: U1, type: 'call', created_at: '2026-10-20T10:00:00.000Z' }),
  ];
  beforeEach(() => installTables(__mock, { crm_activities: acts, users }));

  it('counts by type per person, completion, connect rate and active days', async () => {
    const r = await plus.activityMix(ORG, null, { from: '2026-11-01', to: '2026-11-10' });
    const asha = r.rows.find((x) => x.owner === 'Asha')!;
    const ravi = r.rows.find((x) => x.owner === 'Ravi')!;
    expect(asha).toMatchObject({ total: 5, calls: 3, emails: 1, meetings: 1, site_visits: 0, completed: 3, completion_pct: 60, calls_with_outcome: 2, calls_connected: 1, connect_rate_pct: 50, active_days: 3, avg_per_active_day: 1.7 });
    expect(ravi).toMatchObject({ total: 3, calls: 0, site_visits: 1, notes: 1, messages: 1, completed: 1, completion_pct: 33.3, connect_rate_pct: null, active_days: 2, avg_per_active_day: 1.5 });
    expect(r.totals).toMatchObject({ owner: 'Everyone', total: 8, calls: 3, completed: 4, completion_pct: 50 });
    expect(r.by_type).toEqual([
      { type: 'Calls', count: 3 }, { type: 'Emails', count: 1 }, { type: 'Meetings', count: 1 },
      { type: 'Site visits', count: 1 }, { type: 'Notes', count: 1 }, { type: 'SMS / WhatsApp', count: 1 },
    ]);
    expect(r.by_week).toEqual([{ week: '2026-11-02', total: 8, calls: 3, completed: 4 }]);
  });

  it('is scoped to the org and the caller\'s activity scope', async () => {
    await plus.activityMix(ORG, AGRI, undefined, { effectiveCities: null, visibleOwnerIds: [U2], selfOwnerId: U2 });
    const c = __mock.chainsFor('crm_activities')[0];
    expect(c.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
    expect(c.ors).toEqual([`owner_id.in.(${U2}),assigned_to.in.(${U2})`]);
  });

  it('an empty org is zeros', async () => {
    __mock.reset();
    const r = await plus.activityMix(ORG, null, undefined);
    expect(r).toMatchObject({ rows: [], by_type: [], by_week: [], totals: { total: 0, completion_pct: null, connect_rate_pct: null } });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('conversionTime', () => {
  const lead = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, status: 'converted', ...o });
  const leads = [
    lead({ id: 'c1', owner_id: U1, source_id: S1, created_at: '2026-10-01T00:00:00.000Z', converted_at: '2026-10-01T12:00:00.000Z' }),   // 0.5 d
    lead({ id: 'c2', owner_id: U1, source_id: S1, created_at: '2026-09-28T00:00:00.000Z', converted_at: '2026-10-05T00:00:00.000Z' }),   // 7 d
    lead({ id: 'c3', owner_id: U2, source_id: S2, created_at: '2026-09-01T00:00:00.000Z', converted_at: '2026-10-20T00:00:00.000Z' }),   // 49 d
    lead({ id: 'c4', owner_id: U2, source_id: S2, created_at: '2026-10-01T00:00:00.000Z', converted_at: '2026-10-03T00:00:00.000Z' }),   // 2 d
    lead({ id: 'c5', owner_id: U1, source_id: S1, created_at: '2026-10-01T00:00:00.000Z', converted_at: null }),
    lead({ id: 'c6', owner_id: U1, source_id: S1, status: 'qualified', created_at: '2026-10-01T00:00:00.000Z', converted_at: '2026-10-10T00:00:00.000Z' }),
    lead({ id: 'c7', owner_id: U1, source_id: S1, created_at: '2026-08-01T00:00:00.000Z', converted_at: '2026-09-30T23:59:59.000Z' }),
    lead({ id: 'c8', org_id: OTHER_ORG, owner_id: U1, source_id: S1, created_at: '2026-10-01T00:00:00.000Z', converted_at: '2026-10-02T00:00:00.000Z' }),
  ];
  beforeEach(() => installTables(__mock, { crm_leads: leads, crm_lead_sources: sources, users }));

  it('buckets whole days from creation to conversion and summarises them', async () => {
    const r = await plus.conversionTime(ORG, null, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.totals).toEqual({ converted: 4, avg_days: 14.6, median_days: 4.5, p90_days: 49, fastest_days: 0.5, slowest_days: 49 });
    expect(r.buckets).toEqual([
      { bucket: '<1d', count: 1 }, { bucket: '1–3d', count: 1 }, { bucket: '4–7d', count: 1 }, { bucket: '8–14d', count: 0 },
      { bucket: '15–30d', count: 0 }, { bucket: '31–60d', count: 1 }, { bucket: '60d+', count: 0 },
    ]);
    expect(r.by_owner).toEqual([
      { key: U2, label: 'Ravi', converted: 2, avg_days: 25.5, median_days: 25.5 },
      { key: U1, label: 'Asha', converted: 2, avg_days: 3.8, median_days: 3.8 },
    ].sort((a, b) => b.converted - a.converted || a.label.localeCompare(b.label)));
    expect(r.by_source.map((x) => [x.label, x.converted, x.avg_days])).toEqual([['Referral', 2, 25.5], ['Website', 2, 3.8]]);
    expect(r.by_month).toEqual([{ key: '2026-10', label: '2026-10', converted: 4, avg_days: 14.6, median_days: 4.5 }]);
  });

  it('only counts this org\'s converted leads dated inside the window', async () => {
    const r = await plus.conversionTime(ORG, AGRI, { from: '2026-10-01', to: '2026-10-31' });
    expect(__mock.chainsFor('crm_leads')[0].eqs).toMatchObject({ org_id: ORG, client_id: AGRI, status: 'converted' });
    expect(r.totals.converted).toBe(0); // the fixtures carry no client_id, so a client pick narrows them away
  });

  it('an empty org is zeros', async () => {
    __mock.reset();
    const r = await plus.conversionTime(ORG, null, undefined);
    expect(r.totals).toEqual({ converted: 0, avg_days: null, median_days: null, p90_days: null, fastest_days: null, slowest_days: null });
    expect(r.buckets.every((b) => b.count === 0)).toBe(true);
    expect(r.by_owner).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('weightedPipeline', () => {
  const deal = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, pipeline_id: P1, owner_id: U1, probability: 0, expected_close_date: null, ...o });
  const deals = [
    deal({ id: 'W1', stage_id: 'st-lead', amount: 100000, probability: 0, expected_close_date: '2026-11-01', created_at: '2026-11-01T12:00:00.000Z' }),  // stage prob 10 -> 10000, past close
    deal({ id: 'W2', stage_id: 'st-lead', amount: 50000, probability: 20, created_at: '2026-10-31T12:00:00.000Z' }),                                  // own prob 20 -> 10000
    deal({ id: 'W3', stage_id: 'st-prop', amount: 200000, probability: 60, expected_close_date: '2026-12-01', created_at: '2026-10-01T12:00:00.000Z' }), // 120000
    deal({ id: 'W4', stage_id: 'st-prop', amount: null, created_at: '2026-10-01T12:00:00.000Z' }),
    deal({ id: 'W5', stage_id: 'st-won', amount: 999999, created_at: '2026-10-01T12:00:00.000Z' }),
    deal({ id: 'W6', org_id: OTHER_ORG, stage_id: 'st-lead', amount: 5000000, created_at: '2026-10-01T12:00:00.000Z' }),
  ];
  beforeEach(() => installTables(__mock, { crm_deal_stages: stages, crm_deals: deals }));

  it('weights open deals by their own probability, else the stage\'s, per stage', async () => {
    const r = await plus.weightedPipeline(ORG, null, undefined, undefined, NOW);
    // all pipelines: stages fold by name and order by position (the other pipeline's empty stage ties with "Lead")
    expect(r.rows.map((x) => x.stage)).toEqual(['Lead', 'Other pipeline stage', 'Proposal']);
    expect(r.rows[0]).toMatchObject({ deals: 2, value: 150000, weighted_value: 20000, avg_deal_size: 75000, avg_age_days: 9.5, past_close_date: 1 });
    expect(r.rows[1]).toMatchObject({ deals: 0, value: 0, weighted_value: 0, avg_deal_size: null });
    expect(r.rows[2]).toMatchObject({ deals: 2, value: 200000, weighted_value: 120000, avg_deal_size: 100000 });
    expect(r.totals).toEqual({ deals: 4, value: 350000, weighted_value: 140000, weighted_pct_of_value: 40, past_close_date: 1, past_close_value: 100000 });
  });

  it('can be limited to one pipeline, scopes deals by owner, and rejects a bad id', async () => {
    const r = await plus.weightedPipeline(ORG, AGRI, P1, { effectiveCities: null, visibleOwnerIds: [U1], selfOwnerId: U1 }, NOW);
    expect(r.rows.map((x) => x.stage)).toEqual(['Lead', 'Proposal']);
    const c = __mock.chainsFor('crm_deals')[0];
    expect(c.eqs).toMatchObject({ org_id: ORG, client_id: AGRI, pipeline_id: P1 });
    expect(c.ops).toContainEqual({ method: 'in', args: ['owner_id', [U1]] });
    await expect(plus.weightedPipeline(ORG, null, 'nope', undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('an org with no stages is an empty report', async () => {
    __mock.reset();
    const r = await plus.weightedPipeline(ORG, null, undefined, undefined, NOW);
    expect(r.rows).toEqual([]);
    expect(r.totals).toMatchObject({ deals: 0, value: 0, weighted_value: 0, weighted_pct_of_value: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('dealSizeDistribution', () => {
  const deal = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: U1, ...o });
  const deals = [
    deal({ id: 'E1', amount: 5000, stage_id: 'st-lead', created_at: '2026-10-02T00:00:00.000Z' }),
    deal({ id: 'E2', amount: 20000, stage_id: 'st-won', created_at: '2026-10-03T00:00:00.000Z' }),
    deal({ id: 'E3', amount: 30000, stage_id: 'st-lost', created_at: '2026-10-04T00:00:00.000Z' }),
    deal({ id: 'E4', amount: 75000, stage_id: 'st-won', created_at: '2026-10-05T00:00:00.000Z' }),
    deal({ id: 'E5', amount: 250000, stage_id: 'st-won', created_at: '2026-10-06T00:00:00.000Z' }),
    deal({ id: 'E6', amount: 2000000, stage_id: 'st-prop', created_at: '2026-10-07T00:00:00.000Z' }),
    deal({ id: 'E7', amount: null, stage_id: 'st-lead', created_at: '2026-10-08T00:00:00.000Z' }),
    deal({ id: 'E8', amount: 40000, stage_id: 'st-won', created_at: '2026-09-30T00:00:00.000Z' }),
    deal({ id: 'E9', org_id: OTHER_ORG, amount: 40000, stage_id: 'st-won', created_at: '2026-10-08T00:00:00.000Z' }),
  ];
  beforeEach(() => installTables(__mock, { crm_deal_stages: stages, crm_deals: deals }));

  it('bands deals created in the window by amount and splits them by outcome', async () => {
    const r = await plus.dealSizeDistribution(ORG, null, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.rows).toEqual([
      { bucket: 'No amount', deals: 1, won: 0, lost: 0, open: 1, value: 0, win_rate_pct: null },
      { bucket: 'Under ₹10K', deals: 1, won: 0, lost: 0, open: 1, value: 5000, win_rate_pct: null },
      { bucket: '₹10K–50K', deals: 2, won: 1, lost: 1, open: 0, value: 50000, win_rate_pct: 50 },
      { bucket: '₹50K–1L', deals: 1, won: 1, lost: 0, open: 0, value: 75000, win_rate_pct: 100 },
      { bucket: '₹1L–5L', deals: 1, won: 1, lost: 0, open: 0, value: 250000, win_rate_pct: 100 },
      { bucket: '₹5L–10L', deals: 0, won: 0, lost: 0, open: 0, value: 0, win_rate_pct: null },
      { bucket: '₹10L+', deals: 1, won: 0, lost: 0, open: 1, value: 2000000, win_rate_pct: null },
    ]);
    expect(r.totals).toEqual({ deals: 7, with_amount: 6, avg_amount: 396667, median_amount: 52500, largest_amount: 2000000 });
  });

  it('hides the empty "No amount" band and handles an empty org', async () => {
    __mock.reset();
    const r = await plus.dealSizeDistribution(ORG, null, undefined);
    expect(r.rows[0].bucket).toBe('Under ₹10K');
    expect(r.rows.every((x) => x.deals === 0)).toBe(true);
    expect(r.totals).toMatchObject({ deals: 0, with_amount: 0, avg_amount: null, median_amount: null, largest_amount: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('winRateTrend', () => {
  const deal = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: U1, actual_close_date: null, ...o });
  const deals = [
    deal({ id: 'T1', stage_id: 'st-won', amount: 100, actual_close_date: '2026-09-10', updated_at: '2026-09-10T10:00:00.000Z' }),
    deal({ id: 'T2', stage_id: 'st-won', amount: 200, actual_close_date: '2026-10-05', updated_at: '2026-10-05T10:00:00.000Z' }),
    deal({ id: 'T3', stage_id: 'st-won', amount: 300, actual_close_date: '2026-10-20', updated_at: '2026-10-20T10:00:00.000Z' }),
    deal({ id: 'T4', stage_id: 'st-lost', amount: 50, updated_at: '2026-10-12T10:00:00.000Z' }),   // no close date: falls back to updated_at
    deal({ id: 'T5', stage_id: 'st-lost', amount: 50, updated_at: '2026-11-02T10:00:00.000Z' }),
    deal({ id: 'T6', stage_id: 'st-won', amount: 9, actual_close_date: '2026-08-15', updated_at: '2026-08-15T10:00:00.000Z' }), // before the window
    deal({ id: 'T7', stage_id: 'st-prop', amount: 9, updated_at: '2026-10-15T10:00:00.000Z' }),     // still open
    deal({ id: 'T8', org_id: OTHER_ORG, stage_id: 'st-won', amount: 9, actual_close_date: '2026-10-05', updated_at: '2026-10-05T10:00:00.000Z' }),
  ];
  beforeEach(() => installTables(__mock, { crm_deal_stages: stages, crm_deals: deals }));

  it('buckets closed deals by month with exact win rates and a zero-filled axis', async () => {
    const r = await plus.winRateTrend(ORG, null, '3', undefined, NOW);
    expect(r.rows).toEqual([
      { month: '2026-09', won: 1, lost: 0, closed: 1, win_rate_pct: 100, won_value: 100, lost_value: 0 },
      { month: '2026-10', won: 2, lost: 1, closed: 3, win_rate_pct: 66.7, won_value: 500, lost_value: 50 },
      { month: '2026-11', won: 0, lost: 1, closed: 1, win_rate_pct: 0, won_value: 0, lost_value: 50 },
    ]);
    expect(r.totals).toEqual({ won: 3, lost: 2, closed: 5, win_rate_pct: 60 });
  });

  it('defaults to 6 months and rejects a bad months value', async () => {
    expect((await plus.winRateTrend(ORG, null, undefined, undefined, NOW)).rows).toHaveLength(6);
    for (const bad of ['0', '25', 'x', '2.5']) await expect(plus.winRateTrend(ORG, null, bad, undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('an org with no closed deals shows empty months, not an error', async () => {
    __mock.reset();
    const r = await plus.winRateTrend(ORG, null, '2', undefined, NOW);
    expect(r.rows).toEqual([
      { month: '2026-10', won: 0, lost: 0, closed: 0, win_rate_pct: null, won_value: 0, lost_value: 0 },
      { month: '2026-11', won: 0, lost: 0, closed: 0, win_rate_pct: null, won_value: 0, lost_value: 0 },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('callConnectTrend', () => {
  const act = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: U1, type: 'call', outcome: null, ...o });
  const acts = [
    act({ id: 'k1', outcome: 'Connected', created_at: '2026-10-27T10:00:00.000Z' }),
    act({ id: 'k2', created_at: '2026-10-28T10:00:00.000Z' }),
    act({ id: 'k3', outcome: 'Connected – interested', created_at: '2026-11-02T10:00:00.000Z' }),
    act({ id: 'k4', outcome: 'Not interested', created_at: '2026-11-03T10:00:00.000Z' }),
    act({ id: 'k5', outcome: 'Busy', created_at: '2026-11-08T23:00:00.000Z' }), // Sunday: still the week of Nov 2
    act({ id: 'k6', created_at: '2026-11-09T10:00:00.000Z' }),
    act({ id: 'k7', type: 'email', outcome: 'Connected', created_at: '2026-11-03T10:00:00.000Z' }),
    act({ id: 'k8', outcome: 'Connected', created_at: '2026-10-10T10:00:00.000Z' }),
    act({ id: 'k9', org_id: OTHER_ORG, outcome: 'Connected', created_at: '2026-11-03T10:00:00.000Z' }),
  ];
  beforeEach(() => installTables(__mock, { crm_activities: acts }));

  it('reports calls, outcomes and connect rate per week', async () => {
    const r = await plus.callConnectTrend(ORG, null, '3', undefined, NOW);
    expect(r.rows).toEqual([
      { week: '2026-10-26', calls: 2, with_outcome: 1, connected: 1, connect_rate_pct: 100 },
      { week: '2026-11-02', calls: 3, with_outcome: 3, connected: 1, connect_rate_pct: 33.3 },
      { week: '2026-11-09', calls: 1, with_outcome: 0, connected: 0, connect_rate_pct: null },
    ]);
    expect(r.totals).toEqual({ calls: 6, with_outcome: 4, connected: 2, connect_rate_pct: 50 });
  });

  it('rejects a bad weeks value and answers an empty org with zero weeks', async () => {
    await expect(plus.callConnectTrend(ORG, null, '0', undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
    await expect(plus.callConnectTrend(ORG, null, '27', undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
    __mock.reset();
    const r = await plus.callConnectTrend(ORG, null, undefined, undefined, NOW);
    expect(r.rows).toHaveLength(8);
    expect(r.totals).toEqual({ calls: 0, with_outcome: 0, connected: 0, connect_rate_pct: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('leadRecycling', () => {
  const A = 'c0000000-0000-0000-0000-00000000000a';
  const B = 'c0000000-0000-0000-0000-00000000000b';
  const C = 'c0000000-0000-0000-0000-00000000000c';
  const D = 'c0000000-0000-0000-0000-00000000000d';
  const E = 'c0000000-0000-0000-0000-00000000000e';
  const hist = (lead_id: string, old_value: string, new_value: string, changed_at: string, o: Record<string, unknown> = {}) =>
    ({ org_id: ORG, field: 'status', lead_id, old_value, new_value, changed_at, ...o });
  const history = [
    hist(A, 'lost', 'working', '2026-11-02T10:00:00.000Z'),          // reopened (Nov)
    hist(B, 'working', 'lost', '2026-11-03T10:00:00.000Z'),          // moved to lost (Nov)
    hist(C, 'unqualified', 'converted', '2026-10-20T10:00:00.000Z'), // not a reopen: went straight to converted
    hist(A, 'working', 'lost', '2026-10-05T10:00:00.000Z'),          // moved to lost (Oct)
    hist(D, 'lost', 'new', '2026-10-25T10:00:00.000Z'),              // reopened (Oct), converted today
    hist(E, 'lost', 'new', '2026-11-01T10:00:00.000Z'),              // lead not visible to this caller
    hist(A, 'lost', 'unqualified', '2026-10-06T10:00:00.000Z'),      // negative -> negative: neither
    hist(A, 'new', 'working', '2026-11-04T10:00:00.000Z', { field: 'owner_id' }),
    hist(A, 'lost', 'working', '2026-11-05T10:00:00.000Z', { org_id: OTHER_ORG }),
    hist(A, 'lost', 'working', '2026-07-05T10:00:00.000Z'),          // before the window
  ];
  const lead = (id: string, status: string, o: Record<string, unknown> = {}) => ({ id, org_id: ORG, client_id: null, deleted_at: null, status, ...o });
  const leads = [lead(A, 'working'), lead(B, 'lost'), lead(C, 'converted'), lead(D, 'converted'), lead(E, 'new', { org_id: OTHER_ORG })];
  beforeEach(() => installTables(__mock, { crm_lead_history: history, crm_leads: leads }));

  it('counts moves to lost and reopens per month for the leads the caller can see', async () => {
    const r = await plus.leadRecycling(ORG, null, '2', undefined, NOW);
    expect(r.rows).toEqual([
      { month: '2026-10', moved_to_lost: 1, reopened: 1 },
      { month: '2026-11', moved_to_lost: 1, reopened: 1 },
    ]);
    expect(r.totals).toEqual({ moved_to_lost: 2, reopened: 2, distinct_leads_reopened: 2, converted_after_reopen: 1 });
  });

  it('reads only this org\'s status history and applies the lead scope to the leads it resolves', async () => {
    await plus.leadRecycling(ORG, AGRI, '2', { effectiveCities: null, visibleOwnerIds: [U1], selfOwnerId: U1 }, NOW);
    expect(__mock.chainsFor('crm_lead_history')[0].eqs).toMatchObject({ org_id: ORG, field: 'status' });
    const leadChain = __mock.chainsFor('crm_leads')[0];
    expect(leadChain.eqs).toMatchObject({ org_id: ORG, client_id: AGRI });
    expect(leadChain.ors).toHaveLength(1);
  });

  it('rejects a bad months value; an org with no history is zeros', async () => {
    await expect(plus.leadRecycling(ORG, null, '0', undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
    __mock.reset();
    const r = await plus.leadRecycling(ORG, null, '3', undefined, NOW);
    expect(r.rows).toHaveLength(3);
    expect(r.totals).toEqual({ moved_to_lost: 0, reopened: 0, distinct_leads_reopened: 0, converted_after_reopen: 0 });
  });
});
