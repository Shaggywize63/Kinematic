/**
 * Extra data points on the EXISTING CRM reports (Team Performance, Lead Tracker,
 * Win/Loss, Sales Cycle, Forecast, Lead Source ROI, Team Daily). Every new field
 * is additive: the fields these reports already returned keep their values, which
 * is asserted alongside the new numbers on a small seeded dataset.
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

import * as analytics from '../src/services/crm/analytics.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const S1 = 'a1111111-1111-1111-1111-111111111111';
const S2 = 'a2222222-2222-2222-2222-222222222222';
const users = [
  { id: U1, org_id: ORG, client_id: null, name: 'Asha', email: 'asha@example.com' },
  { id: U2, org_id: ORG, client_id: null, name: 'Ravi', email: 'ravi@example.com' },
];
const sources = [
  { id: S1, org_id: ORG, name: 'Website', cost_per_lead: 100 },
  { id: S2, org_id: ORG, name: 'Referral', cost_per_lead: 0 },
];
const won = (p = 100) => ({ stage_type: 'won', probability: p, name: 'Won' });
const lost = () => ({ stage_type: 'lost', probability: 0, name: 'Lost' });
const open = (p: number, name = 'Proposal') => ({ stage_type: 'open', probability: p, name });

// Only Date is faked: the services stamp "now" with `new Date()` / `Date.now()`.
const NOW = '2026-11-10T12:00:00.000Z'; // a Tuesday
beforeAll(() => {
  jest.useFakeTimers({
    now: new Date(NOW),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'],
  });
});
afterAll(() => jest.useRealTimers());
beforeEach(() => __mock.reset());

// ────────────────────────────────────────────────────────────────────────────
describe('teamPerformance — follow-through and previous-period columns', () => {
  const lead = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, score: 0, converted_at: null, last_activity_at: null, ...o });
  const deal = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, probability: 0, actual_close_date: null, ...o });
  const act = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: null, assigned_to: null, completed_at: null, status: 'open', due_at: null, type: 'note', ...o });
  const tables = () => ({
    users,
    crm_leads: [
      lead({ id: 'l1', owner_id: U1, status: 'new', created_at: '2026-11-05T10:00:00.000Z' }),
      lead({ id: 'l2', owner_id: U1, status: 'working', created_at: '2026-10-01T10:00:00.000Z', last_activity_at: '2026-10-10T10:00:00.000Z' }),
      lead({ id: 'l3', owner_id: U1, status: 'converted', created_at: '2026-10-25T10:00:00.000Z', converted_at: '2026-11-03T10:00:00.000Z', last_activity_at: '2026-11-03T10:00:00.000Z' }),
      lead({ id: 'l4', owner_id: U2, status: 'new', created_at: '2026-10-26T10:00:00.000Z' }),
      lead({ id: 'l5', org_id: OTHER_ORG, owner_id: U1, status: 'new', created_at: '2026-11-05T10:00:00.000Z' }),
    ],
    crm_deals: [
      deal({ id: 'd1', owner_id: U1, amount: 100000, created_at: '2026-10-01T00:00:00.000Z', actual_close_date: '2026-11-04T00:00:00.000Z', crm_deal_stages: won() }),
      deal({ id: 'd2', owner_id: U1, amount: 40000, created_at: '2026-10-01T00:00:00.000Z', actual_close_date: '2026-10-28T00:00:00.000Z', crm_deal_stages: won() }),
      deal({ id: 'd3', owner_id: U1, amount: 25000, created_at: '2026-10-01T00:00:00.000Z', crm_deal_stages: lost() }),
      deal({ id: 'd4', owner_id: U1, amount: 200000, probability: 0, created_at: '2026-10-01T00:00:00.000Z', crm_deal_stages: open(25) }),   // stage probability -> 50000
      deal({ id: 'd5', owner_id: U1, amount: 100000, probability: 40, created_at: '2026-10-01T00:00:00.000Z', crm_deal_stages: open(25) }), // own probability -> 40000
      deal({ id: 'd6', owner_id: U2, amount: 50000, probability: 10, created_at: '2026-10-01T00:00:00.000Z', crm_deal_stages: open(50) }),  // 5000
      deal({ id: 'd7', org_id: OTHER_ORG, owner_id: U1, amount: 999999, created_at: '2026-10-01T00:00:00.000Z', crm_deal_stages: won() }),
    ],
    crm_activities: [
      act({ id: 'a1', owner_id: U1, type: 'call', completed_at: '2026-11-02T10:30:00.000Z', created_at: '2026-11-02T10:00:00.000Z' }),
      act({ id: 'a2', owner_id: U1, type: 'meeting', created_at: '2026-11-03T10:00:00.000Z' }),
      act({ id: 'a3', owner_id: U2, type: 'call', created_at: '2026-11-04T10:00:00.000Z' }),
      act({ id: 'a4', owner_id: U1, type: 'email', created_at: '2026-11-05T10:00:00.000Z' }),
      act({ id: 'v1', assigned_to: U1, due_at: '2026-11-08T10:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }), // overdue
      act({ id: 'v2', owner_id: U2, due_at: '2026-11-01T10:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }),    // overdue
      act({ id: 'v3', owner_id: U2, due_at: '2026-11-01T10:00:00.000Z', status: 'done', completed_at: '2026-11-01T11:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }),
      act({ id: 'v4', owner_id: U2, due_at: '2026-11-20T10:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }),     // not yet due
    ],
  });

  it('adds the new columns per rep and in the total, with exact numbers', async () => {
    installTables(__mock, tables());
    const r = await analytics.teamPerformance(ORG, { from: '2026-11-01', to: '2026-11-10' });
    const asha = r.rows.find((x) => x.name === 'Asha')!;
    const ravi = r.rows.find((x) => x.name === 'Ravi')!;
    expect(asha).toMatchObject({
      lost_value: 25000, weighted_pipeline_value: 90000, overdue_followups: 1,
      untouched_open_leads: 1, idle_leads_14d: 1, calls_period: 1, meetings_period: 1,
      new_leads_prev_period: 1, won_count_prev_period: 1, won_value_prev_period: 40000,
    });
    expect(ravi).toMatchObject({
      lost_value: 0, weighted_pipeline_value: 5000, overdue_followups: 1,
      untouched_open_leads: 1, idle_leads_14d: 1, calls_period: 1, meetings_period: 0, // l4 was created 15 days ago and never touched
      new_leads_prev_period: 1, won_count_prev_period: 0, won_value_prev_period: 0,
    });
    expect(r.total).toMatchObject({
      lost_value: 25000, weighted_pipeline_value: 95000, overdue_followups: 2, untouched_open_leads: 2, idle_leads_14d: 2,
      calls_period: 2, meetings_period: 1, new_leads_prev_period: 2, won_count_prev_period: 1, won_value_prev_period: 40000,
    });
  });

  it('keeps every pre-existing field exactly as before', async () => {
    installTables(__mock, tables());
    const r = await analytics.teamPerformance(ORG, { from: '2026-11-01', to: '2026-11-10' });
    const asha = r.rows.find((x) => x.name === 'Asha')!;
    expect(asha).toMatchObject({
      total_leads_owned: 3, new_leads_period: 1, qualified_count: 0, converted_count: 1,
      won_count: 1, won_value: 100000, lost_count: 1, open_count: 2, open_pipeline_value: 300000,
      conversion_rate: 0.5, avg_deal_size: 100000, activities_total_period: 3, activities_completed_period: 1,
    });
    expect(Object.keys(asha)).toEqual(expect.arrayContaining([
      'user_id', 'name', 'total_leads_owned', 'new_leads_today', 'new_leads_week', 'new_leads_month', 'new_leads_period',
      'qualified_count', 'converted_count', 'unqualified_count', 'lost_leads_count', 'qualified_rate', 'converted_rate',
      'won_count', 'won_value', 'lost_count', 'open_count', 'open_pipeline_value', 'conversion_rate', 'avg_deal_size',
      'avg_sales_cycle_days', 'avg_ageing_days', 'oldest_open_lead_days', 'activities_completed_period',
      'activities_total_period', 'last_activity_at', 'avg_lead_score',
    ]));
  });

  it('has no previous-period figures when no date range is asked for (null, not zero)', async () => {
    installTables(__mock, tables());
    const r = await analytics.teamPerformance(ORG, undefined);
    const asha = r.rows.find((x) => x.name === 'Asha')!;
    expect(asha.new_leads_prev_period).toBeNull();
    expect(asha.won_value_prev_period).toBeNull();
    expect(asha.lost_value).toBe(25000);
  });

  it('an org with no data answers zero rows and a zero total', async () => {
    const r = await analytics.teamPerformance(ORG, { from: '2026-11-01', to: '2026-11-10' });
    expect(r.rows).toEqual([]);
    expect(r.total).toMatchObject({ lost_value: 0, weighted_pipeline_value: 0, overdue_followups: 0, new_leads_prev_period: 0 });
  });

  it('never reads another org\'s rows', async () => {
    installTables(__mock, tables());
    await analytics.teamPerformance(ORG, { from: '2026-11-01', to: '2026-11-10' });
    for (const t of ['crm_leads', 'crm_deals', 'crm_activities']) {
      for (const c of __mock.chainsFor(t)) expect(c.eqs.org_id).toBe(ORG);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('leadTracker — monthly conversion, like-for-like previous periods, source conversion', () => {
  const lead = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, owner_id: U1, city: null, source_id: null, ...o });
  const leads = [
    lead({ id: 't1', status: 'converted', source_id: S1, created_at: '2026-11-10T08:00:00.000Z' }),
    lead({ id: 't2', status: 'new', source_id: S2, created_at: '2026-11-09T08:00:00.000Z' }),
    lead({ id: 't3', status: 'new', created_at: '2026-11-09T20:00:00.000Z' }),
    lead({ id: 't4', status: 'converted', source_id: S1, created_at: '2026-11-03T10:00:00.000Z' }),
    lead({ id: 't5', status: 'qualified', source_id: S2, created_at: '2026-10-05T10:00:00.000Z' }),
    lead({ id: 't6', status: 'converted', source_id: S1, created_at: '2026-10-20T10:00:00.000Z' }),
    lead({ id: 't7', org_id: OTHER_ORG, status: 'converted', source_id: S1, created_at: '2026-11-10T08:00:00.000Z' }),
  ];

  it('adds monthly_detail, previous_* and source_detail without changing the existing blocks', async () => {
    installTables(__mock, { crm_leads: leads, crm_lead_sources: sources });
    const r = await analytics.leadTracker(ORG, 2);
    // existing blocks, unchanged
    expect(r.monthly).toEqual([{ key: '2026-10', count: 2 }, { key: '2026-11', count: 4 }]);
    expect(r.period_today).toMatchObject({ new_leads: 1, converted: 1, conversion_rate: 1 });
    expect(r.period_week).toMatchObject({ new_leads: 3, converted: 1 });
    expect(r.period_month).toMatchObject({ new_leads: 4, converted: 2, conversion_rate: 0.5 });
    expect(r.status_breakdown).toMatchObject({ new: 2, converted: 3, qualified: 1 });
    expect(r.source_breakdown).toEqual([
      { name: 'Website', count: 3 }, { name: 'Referral', count: 2 }, { name: 'Unspecified', count: 1 },
    ]);
    // additive blocks
    expect(r.monthly_detail).toEqual([
      { key: '2026-10', new_leads: 2, converted: 1, conversion_rate: 0.5 },
      { key: '2026-11', new_leads: 4, converted: 2, conversion_rate: 0.5 },
    ]);
    expect(r.previous_today).toMatchObject({ label: 'Yesterday (same time)', new_leads: 1, converted: 0 });
    expect(r.previous_week).toMatchObject({ label: 'Last week (same days)', new_leads: 1, converted: 1, conversion_rate: 1 });
    expect(r.previous_month).toMatchObject({ label: 'Last month (same days)', new_leads: 1, converted: 0 });
    expect(r.source_detail).toEqual([
      { name: 'Website', count: 3, converted: 3, conversion_rate: 1 },
      { name: 'Referral', count: 2, converted: 0, conversion_rate: 0 },
      { name: 'Unspecified', count: 1, converted: 0, conversion_rate: 0 },
    ]);
  });

  it('an empty org still returns every block, all zeros', async () => {
    const r = await analytics.leadTracker(ORG, 3);
    expect(r.monthly).toHaveLength(3);
    expect(r.monthly_detail!.every((m) => m.new_leads === 0 && m.conversion_rate === 0)).toBe(true);
    expect(r.previous_today!.new_leads).toBe(0);
    expect(r.source_detail).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('winRate — value columns', () => {
  const deal = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, created_at: '2026-10-10T00:00:00.000Z', ...o });
  const deals = [
    deal({ id: 'w1', owner_id: U1, amount: 100000, crm_deal_stages: won() }),
    deal({ id: 'w2', owner_id: U1, amount: 50000, crm_deal_stages: won() }),
    deal({ id: 'w3', owner_id: U1, amount: 30000, crm_deal_stages: lost() }),
    deal({ id: 'w4', owner_id: U1, amount: 70000, crm_deal_stages: open(30) }),
    deal({ id: 'w5', owner_id: U2, amount: 20000, crm_deal_stages: lost() }),
    deal({ id: 'w6', org_id: OTHER_ORG, owner_id: U1, amount: 1, crm_deal_stages: won() }),
  ];

  it('by rep: keeps won / lost / rate and adds open, value won / lost, average won deal and value win rate', async () => {
    installTables(__mock, { crm_deals: deals, users });
    const rows = await analytics.winRate(ORG, 'rep');
    const asha = rows.find((r) => r.bucket === 'Asha')!;
    expect(asha).toMatchObject({ won: 2, lost: 1, rate: 2 / 3, open: 1, won_value: 150000, lost_value: 30000, avg_won_deal: 75000, value_win_rate: 150000 / 180000 });
    const ravi = rows.find((r) => r.bucket === 'Ravi')!;
    expect(ravi).toMatchObject({ won: 0, lost: 1, rate: 0, open: 0, won_value: 0, lost_value: 20000, avg_won_deal: 0, value_win_rate: 0 });
  });

  it('by stage: the same value columns per stage', async () => {
    installTables(__mock, { crm_deals: deals, users });
    const rows = await analytics.winRate(ORG, 'stage');
    expect(rows.find((r) => r.bucket === 'Won')).toMatchObject({ won: 2, won_value: 150000 });
    expect(rows.find((r) => r.bucket === 'Lost')).toMatchObject({ lost: 2, lost_value: 50000 });
  });

  it('by source: adds the lead volume behind the rate', async () => {
    installTables(__mock, {
      crm_leads: [
        { org_id: ORG, deleted_at: null, status: 'converted', source_id: S1 }, { org_id: ORG, deleted_at: null, status: 'new', source_id: S1 },
        { org_id: ORG, deleted_at: null, status: 'new', source_id: S2 }, { org_id: OTHER_ORG, deleted_at: null, status: 'converted', source_id: S1 },
      ],
      crm_lead_sources: sources,
    });
    const rows = await analytics.winRate(ORG, 'source');
    expect(rows.find((r) => r.bucket === 'Website')).toMatchObject({ won: 1, lost: 1, rate: 0.5, total: 2 });
    expect(rows.find((r) => r.bucket === 'Referral')).toMatchObject({ won: 0, lost: 1, rate: 0, total: 1 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('salesCycle — deal count, median, fastest, slowest', () => {
  const deal = (id: string, created: string, closed: string) => ({ id, org_id: ORG, client_id: null, deleted_at: null, created_at: created, actual_close_date: closed, crm_deal_stages: won() });
  it('keeps month + avg_days and adds the spread behind each average', async () => {
    installTables(__mock, {
      crm_deals: [
        deal('s1', '2026-10-01', '2026-10-11'), deal('s2', '2026-10-01', '2026-10-21'), deal('s3', '2026-10-01', '2026-10-31'),
        deal('s4', '2026-11-01', '2026-11-06'),
        { ...deal('s5', '2026-10-01', '2026-10-02'), org_id: OTHER_ORG },
      ],
    });
    const rows = await analytics.salesCycle(ORG);
    expect(rows).toEqual([
      { month: '2026-10', avg_days: 20, deals: 3, median_days: 20, fastest_days: 10, slowest_days: 30 },
      { month: '2026-11', avg_days: 5, deals: 1, median_days: 5, fastest_days: 5, slowest_days: 5 },
    ]);
  });
  it('is an empty list for an org with no closed deals', async () => { expect(await analytics.salesCycle(ORG)).toEqual([]); });
});

// ────────────────────────────────────────────────────────────────────────────
describe('forecast — deal counts, average probability and expected total', () => {
  const deal = (o: Record<string, unknown>) => ({ org_id: ORG, client_id: null, deleted_at: null, ...o });
  it('keeps the existing buckets and adds counts / avg probability / expected_total', async () => {
    installTables(__mock, {
      crm_deals: [
        deal({ id: 'f1', amount: 100000, probability: 50, expected_close_date: '2026-11-20', crm_deal_stages: open(20) }),
        deal({ id: 'f2', amount: 50000, probability: null, expected_close_date: '2026-11-25', crm_deal_stages: open(20) }),
        deal({ id: 'f3', amount: 200000, probability: 10, expected_close_date: '2026-12-05', crm_deal_stages: open(20) }),
        deal({ id: 'f4', amount: 80000, actual_close_date: '2026-11-08', crm_deal_stages: won() }),
        deal({ id: 'f5', org_id: OTHER_ORG, amount: 5000000, probability: 50, expected_close_date: '2026-11-20', crm_deal_stages: open(20) }),
      ],
    });
    const rows = await analytics.forecast(ORG, 'quarter', { from: '2026-11-01', to: '2026-12-31' });
    expect(rows).toEqual([
      { period: '2026-11', committed: 60000, best_case: 150000, pipeline: 150000, closed: 80000, open_deals: 2, won_deals: 1, avg_probability: 35, expected_total: 140000 },
      { period: '2026-12', committed: 20000, best_case: 200000, pipeline: 200000, closed: 0, open_deals: 1, won_deals: 0, avg_probability: 10, expected_total: 20000 },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('leadSourceRoi — funnel and unit-economics columns', () => {
  it('keeps source / leads / deals / revenue / cost / roi and adds the new columns', async () => {
    installTables(__mock, {
      crm_leads: [
        { org_id: ORG, deleted_at: null, source_id: S1, status: 'converted', converted_deal_id: 'D1' },
        { org_id: ORG, deleted_at: null, source_id: S1, status: 'qualified', converted_deal_id: null },
        { org_id: ORG, deleted_at: null, source_id: S1, status: 'new', converted_deal_id: null },
        { org_id: ORG, deleted_at: null, source_id: S2, status: 'new', converted_deal_id: null },
        { org_id: OTHER_ORG, deleted_at: null, source_id: S1, status: 'converted', converted_deal_id: 'D1' },
      ],
      crm_lead_sources: sources,
      crm_deals: [{ id: 'D1', org_id: ORG, deleted_at: null, amount: 50000, crm_deal_stages: won() }],
    });
    const rows = await analytics.leadSourceRoi(ORG);
    const web = rows.find((r) => r.source === 'Website')!;
    expect(web).toMatchObject({ leads: 3, deals: 1, revenue: 50000, cost: 300, roi: (50000 - 300) / 300 });
    expect(web).toMatchObject({
      qualified: 2, lead_to_deal_pct: 33.3, avg_deal_value: 50000, revenue_per_lead: 16667, cost_per_lead: 100,
      cost_per_deal: 300, revenue_share_pct: 100,
    });
    const ref = rows.find((r) => r.source === 'Referral')!;
    expect(ref).toMatchObject({ leads: 1, deals: 0, revenue: 0, cost: 0, roi: 0, qualified: 0, lead_to_deal_pct: 0, avg_deal_value: null, revenue_per_lead: 0, cost_per_deal: null, revenue_share_pct: 0 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('teamDaily — open follow-ups due that day / overdue', () => {
  it('counts still-open scheduled activities per rep and leaves the card otherwise unchanged', async () => {
    const act = (o: Record<string, unknown>) => ({ org_id: ORG, deleted_at: null, owner_id: null, assigned_to: null, completed_at: null, status: 'open', due_at: null, ...o });
    installTables(__mock, {
      users,
      crm_activities: [
        act({ id: 'x1', owner_id: U1, due_at: '2026-11-05T10:00:00.000Z' }),                                                       // due that day
        act({ id: 'x2', assigned_to: U1, due_at: '2026-11-03T10:00:00.000Z', status: 'planned' }),                                  // before
        act({ id: 'x3', owner_id: U2, due_at: '2026-11-06T10:00:00.000Z' }),                                                       // after the day
        act({ id: 'x4', owner_id: U1, due_at: '2026-11-04T10:00:00.000Z', status: 'done', completed_at: '2026-11-04T11:00:00.000Z' }),
        act({ id: 'x5', org_id: OTHER_ORG, owner_id: U1, due_at: '2026-11-05T10:00:00.000Z' }),
      ],
    });
    const cards = await analytics.teamDaily(ORG, '2026-11-05');
    const asha = cards.find((c) => c.name === 'Asha')!;
    const ravi = cards.find((c) => c.name === 'Ravi')!;
    expect(asha).toMatchObject({ open_followups_due_that_day: 1, open_followups_overdue: 1 });
    expect(ravi).toMatchObject({ open_followups_due_that_day: 0, open_followups_overdue: 0 });
    expect(asha.activities_today).toEqual({ total: 0, completed: 0, calls: 0, emails: 0, meetings: 0, site_visits: 0, tasks: 0, other: 0 });
  });
});
