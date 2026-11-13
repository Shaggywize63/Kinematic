/**
 * Business Report aggregation (connected-B2B / Spark & Ray only).
 *
 * Exercises the deal-centric aggregation against a filtering Supabase mock: grouping
 * by each dimension (engineer / account / industry / brand / product), the brand &
 * product FAN-OUT vs the deduped totals, the explicit filters narrowing the deal set,
 * cost attribution (deal- and lead-linked claims; null for brand/product rows and when
 * the links are unreadable), the scope=own/supervised split over users.supervisor_id,
 * the non-B2B short-circuit, and the date range.
 */

let mockTables: Record<string, { rows?: any[]; error?: { message: string } }> = {};

const cmp = (a: any, b: any): number => {
  if (String(a).includes('T') || String(b).includes('T')) {
    const pa = Date.parse(a); const pb = Date.parse(b);
    if (Number.isFinite(pa) && Number.isFinite(pb)) return pa - pb;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

function mockBuilder(rows: any[], error?: { message: string }) {
  const preds: Array<(r: any) => boolean> = [];
  const self: any = {
    select: () => self,
    eq: (c: string, v: any) => (preds.push((r) => r[c] === v), self),
    is: (c: string, v: any) => (preds.push((r) => (r[c] ?? null) === v), self),
    gte: (c: string, v: any) => (preds.push((r) => cmp(r[c], v) >= 0), self),
    lte: (c: string, v: any) => (preds.push((r) => cmp(r[c], v) <= 0), self),
    in: (c: string, arr: any[]) => (preds.push((r) => arr.includes(r[c])), self),
    order: () => self,
    limit: () => self,
    range: () => self,
    then: (resolve: (v: any) => any) => {
      if (error) return resolve({ data: null, error });
      return resolve({ data: rows.filter((r) => preds.every((p) => p(r))), error: null });
    },
  };
  return self;
}

jest.mock('../src/lib/supabase', () => ({
  supabaseAdmin: {
    from: (t: string) => {
      const spec = mockTables[t] ?? { rows: [] };
      return mockBuilder(spec.rows ?? [], spec.error);
    },
  },
}));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { buildBusinessReport, resolveGroupBy, resolveScope } from '../src/services/crm/businessReport.service';
import { SPARK_CLIENT_ID } from '../src/lib/b2bClients';

const ORG = 'org-1';
const U1 = '11111111-1111-4111-8111-111111111111'; // Alice (supervisor)
const U2 = '22222222-2222-4222-8222-222222222222'; // Bob (reports to Alice)
const OTHER_CLIENT = '99999999-9999-4999-8999-999999999999';
const S_WON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S_OPEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACC1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACC2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LEAD1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LEAD2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PROD1 = '12121212-1212-4121-8121-121212121212';

const FROM = '2026-11-01';
const TO = '2026-11-30';

// D1: U1, won-in-range, account ACC1, lead LEAD1, lines MAC(order 40000)+Lincoln(order 20000), product PROD1
// D2: U2, won-in-range, account ACC2, lead LEAD2, NO line order value -> amount fallback (50000), brand ESAB
// D3: U1, open/active, account ACC1, lead LEAD1, amount 30000, brand MAC
// D4: U1, won but closed BEFORE range -> excluded entirely
function seed() {
  mockTables = {
    users: {
      rows: [
        { id: U1, name: 'Alice', email: 'a@x.com', org_id: ORG, client_id: SPARK_CLIENT_ID, is_active: true, supervisor_id: null, deleted_at: null },
        { id: U2, name: 'Bob', email: 'b@x.com', org_id: ORG, client_id: SPARK_CLIENT_ID, is_active: true, supervisor_id: U1, deleted_at: null },
      ],
    },
    crm_deal_stages: {
      rows: [
        { id: S_WON, stage_type: 'won', org_id: ORG },
        { id: S_OPEN, stage_type: 'open', org_id: ORG },
      ],
    },
    crm_deals: {
      rows: [
        { id: 'D1', owner_id: U1, assigned_to: null, status: 'won', stage_id: S_WON, amount: 100000, actual_close_date: '2026-11-08', created_at: '2026-11-01T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null, account_id: ACC1, lead_id: LEAD1 },
        { id: 'D2', owner_id: U2, assigned_to: null, status: 'won', stage_id: S_WON, amount: 50000, actual_close_date: '2026-11-15', created_at: '2026-11-02T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null, account_id: ACC2, lead_id: LEAD2 },
        { id: 'D3', owner_id: U1, assigned_to: null, status: 'open', stage_id: S_OPEN, amount: 30000, actual_close_date: null, created_at: '2026-11-03T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null, account_id: ACC1, lead_id: LEAD1 },
        { id: 'D4', owner_id: U1, assigned_to: null, status: 'won', stage_id: S_WON, amount: 999999, actual_close_date: '2026-10-30', created_at: '2026-10-01T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null, account_id: ACC1, lead_id: LEAD1 },
      ],
    },
    crm_deal_line_items: {
      rows: [
        { id: 'li1', deal_id: 'D1', org_id: ORG, product_id: PROD1, sku: 'SKU-MAC', name: 'MAC Welder', custom_fields: { order_value: 40000, brand_name: 'MAC' } },
        { id: 'li2', deal_id: 'D1', org_id: ORG, product_id: null, sku: 'SKU-LN', name: 'Lincoln Rod', custom_fields: { order_value: 20000, brand_name: 'Lincoln' } },
        { id: 'li3', deal_id: 'D2', org_id: ORG, product_id: null, sku: null, name: null, custom_fields: { brand_name: 'ESAB' } },
        { id: 'li4', deal_id: 'D3', org_id: ORG, product_id: PROD1, sku: 'SKU-MAC', name: 'MAC Welder', custom_fields: { brand_name: 'MAC' } },
      ],
    },
    crm_products: { rows: [{ id: PROD1, name: 'MAC Welder 3000', org_id: ORG }] },
    crm_accounts: {
      rows: [
        { id: ACC1, name: 'Acme Fabrication', industry: 'Manufacturing', org_id: ORG, client_id: SPARK_CLIENT_ID },
        { id: ACC2, name: 'Bolt Industries', industry: 'Construction', org_id: ORG, client_id: SPARK_CLIENT_ID },
      ],
    },
    crm_leads: {
      rows: [
        { id: LEAD1, industry: 'Manufacturing', org_id: ORG },
        { id: LEAD2, industry: 'Construction', org_id: ORG },
      ],
    },
    expense_claims: {
      rows: [
        // deal-linked claim on D1 (approved -> approved_amount counts)
        { id: 'c1', deal_id: 'D1', lead_id: LEAD1, status: 'approved', total_amount: 5000, approved_amount: 4000, org_id: ORG, client_id: SPARK_CLIENT_ID },
        // lead-only claim on LEAD2 (no deal_id) -> attributed to D2 (submitted -> total_amount)
        { id: 'c2', deal_id: null, lead_id: LEAD2, status: 'submitted', total_amount: 3000, approved_amount: null, org_id: ORG, client_id: SPARK_CLIENT_ID },
        // rejected claim -> excluded from cost
        { id: 'c3', deal_id: 'D1', lead_id: LEAD1, status: 'rejected', total_amount: 9999, approved_amount: null, org_id: ORG, client_id: SPARK_CLIENT_ID },
      ],
    },
  };
}

const byKey = (data: any, k: string) => data.rows.find((r: any) => r.key === k);

describe('resolveGroupBy / resolveScope', () => {
  it('defaults and validates group_by', () => {
    expect(resolveGroupBy(undefined)).toBe('engineer');
    expect(resolveGroupBy('nonsense')).toBe('engineer');
    expect(resolveGroupBy('BRAND')).toBe('brand');
    expect(resolveGroupBy('account')).toBe('account');
  });
  it('defaults and validates scope', () => {
    expect(resolveScope(undefined)).toBe('all');
    expect(resolveScope('x')).toBe('all');
    expect(resolveScope('own')).toBe('own');
    expect(resolveScope('SUPERVISED')).toBe('supervised');
  });
});

describe('buildBusinessReport — non-B2B tenant', () => {
  beforeEach(seed);
  it('returns null for a client outside the connected-B2B flow', async () => {
    expect(await buildBusinessReport({ orgId: ORG, clientId: OTHER_CLIENT, from: FROM, to: TO })).toBeNull();
  });
  it('returns null when there is no client in scope', async () => {
    expect(await buildBusinessReport({ orgId: ORG, clientId: null, from: FROM, to: TO })).toBeNull();
  });
});

describe('buildBusinessReport — totals (deduped at deal level)', () => {
  beforeEach(seed);
  it('rolls true totals over the in-range deals regardless of grouping', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer' }))!;
    expect(data.range).toEqual({ from: FROM, to: TO });
    expect(data.totals).toEqual({
      leads_count: 2,            // LEAD1 (D1,D3) + LEAD2 (D2); D4 excluded
      orders_won: 2,             // D1 + D2; D4 closed before range; D3 open
      quoted_value: 180000,      // active-in-range: D1 100000 + D2 50000 (won+closed in range) + D3 30000
      order_value: 110000,       // D1 60000 (lines) + D2 50000 (amount fallback)
      brands: ['ESAB', 'Lincoln', 'MAC'],
      cost: 7000,                // D1 approved 4000 + D2 lead-only 3000; rejected excluded
    });
  });
});

describe('buildBusinessReport — group_by engineer', () => {
  beforeEach(seed);
  it('groups by deal owner (owner_id -> assigned_to) with user-name labels and cost', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer' }))!;
    const a = byKey(data, U1);
    expect(a.label).toBe('Alice');
    expect(a.orders_won).toBe(1);      // D1
    expect(a.order_value).toBe(60000); // D1 lines 40000+20000
    expect(a.leads_count).toBe(1);     // LEAD1 (D1 + D3)
    expect(a.brands).toEqual(['Lincoln', 'MAC']);
    expect(a.cost).toBe(4000);         // D1 approved claim
    const b = byKey(data, U2);
    expect(b.label).toBe('Bob');
    expect(b.order_value).toBe(50000); // amount fallback
    expect(b.cost).toBe(3000);         // lead-only claim on LEAD2
    // engineer rows sum back to totals (no fan-out)
    const sumOrderValue = data.rows.reduce((s: number, r: any) => s + r.order_value, 0);
    expect(sumOrderValue).toBe(data.totals.order_value);
    const sumCost = data.rows.reduce((s: number, r: any) => s + (r.cost ?? 0), 0);
    expect(sumCost).toBe(data.totals.cost);
  });
});

describe('buildBusinessReport — group_by account & industry', () => {
  beforeEach(seed);
  it('groups by the deal account with names', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'account' }))!;
    expect(byKey(data, ACC1).label).toBe('Acme Fabrication');
    expect(byKey(data, ACC1).order_value).toBe(60000);
    expect(byKey(data, ACC2).label).toBe('Bolt Industries');
    expect(byKey(data, ACC2).cost).toBe(3000);
  });
  it('groups by industry (lead industry, account fallback) and sums to totals', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'industry' }))!;
    expect(byKey(data, 'Manufacturing').order_value).toBe(60000);
    expect(byKey(data, 'Construction').order_value).toBe(50000);
    const sum = data.rows.reduce((s: number, r: any) => s + r.order_value, 0);
    expect(sum).toBe(data.totals.order_value);
  });
});

describe('buildBusinessReport — brand/product fan-out', () => {
  beforeEach(seed);
  it('fans a multi-brand deal across brand rows; totals stay deduped; cost null', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'brand' }))!;
    // D1 (order 60000) contributes to BOTH MAC and Lincoln; D3 (active, quoted 30000) to MAC; D2 to ESAB
    expect(byKey(data, 'MAC').order_value).toBe(60000);
    expect(byKey(data, 'Lincoln').order_value).toBe(60000);
    expect(byKey(data, 'ESAB').order_value).toBe(50000);
    // summing brand rows EXCEEDS the deduped total (fan-out)
    const sum = data.rows.reduce((s: number, r: any) => s + r.order_value, 0);
    expect(sum).toBeGreaterThan(data.totals.order_value);
    expect(data.totals.order_value).toBe(110000);
    // cost cannot be attributed to a brand -> null per row, totals.cost still present
    expect(byKey(data, 'MAC').cost).toBeNull();
    expect(data.totals.cost).toBe(7000);
  });
  it('groups by product with crm_products labels and fan-out', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'product' }))!;
    const p = byKey(data, PROD1);
    expect(p.label).toBe('MAC Welder 3000');  // resolved from crm_products
    expect(p.order_value).toBe(60000);         // D1 (won) has PROD1 line
    expect(p.quoted_value).toBe(130000);       // D1 active 100000 + D3 active 30000 (both carry PROD1)
    expect(p.cost).toBeNull();
    // the Lincoln line on D1 has no product_id/sku-less? it has sku SKU-LN -> its own product key
    expect(byKey(data, 'sku:sku-ln')).toBeTruthy();
  });
});

describe('buildBusinessReport — explicit filters narrow the deal set', () => {
  beforeEach(seed);
  it('engineer_id filter keeps only that owner\'s deals', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'account', engineer_id: U2 }))!;
    // only D2 (U2) survives -> only ACC2
    expect(data.rows.map((r: any) => r.key).sort()).toEqual([ACC2]);
    expect(data.totals.order_value).toBe(50000);
  });
  it('brand filter keeps only deals carrying that brand', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer', brand: 'ESAB' }))!;
    // only D2 has ESAB -> only U2
    expect(data.rows.map((r: any) => r.key)).toEqual([U2]);
  });
  it('account_id filter narrows to that account', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer', account_id: ACC2 }))!;
    expect(data.rows.map((r: any) => r.key)).toEqual([U2]);
    expect(data.filters.account_id).toBe(ACC2);
  });
});

describe('buildBusinessReport — scope=own|supervised', () => {
  beforeEach(seed);
  it('own restricts to the requester\'s deals', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer', scope: 'own', requesterId: U1 }))!;
    expect(data.scope).toBe('own');
    expect(data.rows.map((r: any) => r.key)).toEqual([U1]);
  });
  it('supervised restricts to the requester\'s reports via users.supervisor_id', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer', scope: 'supervised', requesterId: U1 }))!;
    // Bob reports to Alice -> only Bob's deals (D2)
    expect(data.rows.map((r: any) => r.key)).toEqual([U2]);
    expect(data.totals.order_value).toBe(50000);
  });
  it('supervised with no reports yields an empty set', async () => {
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer', scope: 'supervised', requesterId: U2 }))!;
    expect(data.rows).toEqual([]);
    expect(data.totals.orders_won).toBe(0);
  });
});

describe('buildBusinessReport — cost resilience', () => {
  beforeEach(seed);
  it('null cost everywhere when expense_claims is unreadable (no 500)', async () => {
    mockTables.expense_claims = { error: { message: 'column expense_claims.deal_id does not exist' } };
    const data = (await buildBusinessReport({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, group_by: 'engineer' }))!;
    expect(data.cost_available).toBe(false);
    expect(data.totals.cost).toBeNull();
    for (const r of data.rows) expect(r.cost).toBeNull();
    // other metrics unaffected
    expect(data.totals.order_value).toBe(110000);
  });
});
