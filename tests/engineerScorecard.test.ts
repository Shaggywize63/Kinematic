/**
 * Engineer Scorecard aggregation (connected-B2B / Spark & Ray only).
 *
 * Exercises the aggregation math against a filtering Supabase mock: leads/orders/
 * value/brands grouped per user, owner→assigned_to fallback, the won-filter
 * (status='won' OR a `won` stage, close date inside the range), order value from
 * the line-item roll-up with amount fallback, quoted value over deals active in
 * range, distinct-day attendance (and its degrade-to-null path), the date-range
 * boundary, buckets, and the non-B2B short-circuit.
 */

// A filtering query-builder mock: honours eq / is / gte / lte / in so the
// range + scope filters are genuinely tested. `mock`-prefixed so the jest.mock
// factory may close over it.
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

import { buildEngineerScorecard, resolveRange } from '../src/services/crm/engineerScorecard.service';
import { SPARK_CLIENT_ID } from '../src/lib/b2bClients';

const ORG = 'org-1';
const U1 = '11111111-1111-4111-8111-111111111111'; // Alice
const U2 = '22222222-2222-4222-8222-222222222222'; // Bob
const OTHER_CLIENT = '99999999-9999-4999-8999-999999999999';
const S_WON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S_OPEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const FROM = '2026-11-01';
const TO = '2026-11-30';

function seedFullDataset() {
  mockTables = {
    users: {
      rows: [
        { id: U1, name: 'Alice', email: 'a@x.com', org_id: ORG, client_id: SPARK_CLIENT_ID, is_active: true },
        { id: U2, name: 'Bob', email: 'b@x.com', org_id: ORG, client_id: SPARK_CLIENT_ID, is_active: true },
        { id: 'inactive', name: 'Zed', org_id: ORG, client_id: SPARK_CLIENT_ID, is_active: false },
      ],
    },
    crm_leads: {
      rows: [
        { id: 'L1', owner_id: U1, assigned_to: null, status: 'new', created_at: '2026-11-05T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        { id: 'L2', owner_id: null, assigned_to: U2, status: 'qualified', created_at: '2026-11-10T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        { id: 'L3', owner_id: U1, assigned_to: null, status: 'new', created_at: '2026-10-20T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null }, // out of range
        // L4: U1, converted-in-range — this lead has BECOME a contact (crm_contacts C1 below).
        // The old report counted it in leads_count; it must now be excluded from leads and
        // surfaced as converted_leads_count instead.
        { id: 'L4', owner_id: U1, assigned_to: null, status: 'converted', created_at: '2026-11-07T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
      ],
    },
    crm_contacts: {
      rows: [
        // C1: the contact created when L4 converted — owner U1, in range.
        { id: 'C1', owner_id: U1, assigned_to: null, created_at: '2026-11-07T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // C2: a directly-created contact — owner U1, in range.
        { id: 'C2', owner_id: U1, assigned_to: null, created_at: '2026-11-12T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // C3: owner null, assigned_to U2 — exercises the owner_id→assigned_to fallback, in range.
        { id: 'C3', owner_id: null, assigned_to: U2, created_at: '2026-11-15T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // C4: owner U2, OUT of range -> excluded.
        { id: 'C4', owner_id: U2, assigned_to: null, created_at: '2026-10-25T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // C5: owner U1, in range but deleted -> excluded.
        { id: 'C5', owner_id: U1, assigned_to: null, created_at: '2026-11-18T06:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: '2026-11-19T00:00:00Z' },
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
        // D1: U1 won-in-range, has line order values
        { id: 'D1', owner_id: U1, assigned_to: null, status: 'won', stage_id: S_WON, amount: 100000, actual_close_date: '2026-11-08', created_at: '2026-11-01T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // D2: U2 won-in-range, NO line order values -> fallback to amount
        { id: 'D2', owner_id: U2, assigned_to: null, status: 'won', stage_id: S_WON, amount: 50000, actual_close_date: '2026-11-15', created_at: '2026-11-02T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // D3: U1 won but closed BEFORE range -> excluded from won + active
        { id: 'D3', owner_id: U1, assigned_to: null, status: 'won', stage_id: S_WON, amount: 999999, actual_close_date: '2026-10-30', created_at: '2026-10-01T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // D4: U2 open -> active (quoted + brands), not won
        { id: 'D4', owner_id: U2, assigned_to: null, status: 'open', stage_id: S_OPEN, amount: 30000, actual_close_date: null, created_at: '2026-11-03T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // D5: U1 won via STAGE TYPE (status not 'won'), in range, has line order values
        { id: 'D5', owner_id: U1, assigned_to: null, status: 'open', stage_id: S_WON, amount: 70000, actual_close_date: '2026-11-20', created_at: '2026-11-04T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: null },
        // D6: deleted -> excluded entirely
        { id: 'D6', owner_id: U1, assigned_to: null, status: 'won', stage_id: S_WON, amount: 123, actual_close_date: '2026-11-09', created_at: '2026-11-01T04:00:00Z', org_id: ORG, client_id: SPARK_CLIENT_ID, deleted_at: '2026-11-10T00:00:00Z' },
      ],
    },
    crm_deal_line_items: {
      rows: [
        { id: 'li1', deal_id: 'D1', org_id: ORG, custom_fields: { order_value: 40000, brand_name: 'MAC' } },
        { id: 'li2', deal_id: 'D1', org_id: ORG, custom_fields: { order_value: 20000, brand_name: 'Lincoln' } },
        { id: 'li3', deal_id: 'D4', org_id: ORG, custom_fields: { order_value: 5000, brand_name: 'ESAB' } },
        { id: 'li4', deal_id: 'D5', org_id: ORG, custom_fields: { order_value: 25000, brand_name: 'MAC' } },
      ],
    },
    attendance: {
      rows: [
        { user_id: U1, date: '2026-11-05', org_id: ORG, client_id: SPARK_CLIENT_ID },
        { user_id: U1, date: '2026-11-05', org_id: ORG, client_id: SPARK_CLIENT_ID }, // dup day
        { user_id: U1, date: '2026-11-06', org_id: ORG, client_id: SPARK_CLIENT_ID },
        { user_id: U2, date: '2026-11-10', org_id: ORG, client_id: SPARK_CLIENT_ID },
        { user_id: U1, date: '2026-10-31', org_id: ORG, client_id: SPARK_CLIENT_ID }, // out of range
      ],
    },
  };
}

const byUser = (data: any, uid: string) => data.engineers.find((e: any) => e.user_id === uid);

describe('resolveRange', () => {
  it('defaults to the IST calendar month and clamps granularity to month', () => {
    const r = resolveRange({});
    expect(r.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(r.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.granularity).toBe('month');
  });
  it('keeps valid dates + granularity and swaps an inverted range', () => {
    expect(resolveRange({ from: '2026-03-10', to: '2026-03-01', granularity: 'week' }))
      .toEqual({ from: '2026-03-01', to: '2026-03-10', granularity: 'week' });
    expect(resolveRange({ from: '2026-03-01', to: '2026-03-31', granularity: 'day' }).granularity).toBe('day');
    expect(resolveRange({ granularity: 'nonsense' }).granularity).toBe('month');
  });
});

describe('buildEngineerScorecard — non-B2B tenant', () => {
  beforeEach(seedFullDataset);
  it('returns null for a client outside the connected-B2B flow', async () => {
    expect(await buildEngineerScorecard({ orgId: ORG, clientId: OTHER_CLIENT, from: FROM, to: TO })).toBeNull();
  });
  it('returns null when there is no client in scope', async () => {
    expect(await buildEngineerScorecard({ orgId: ORG, clientId: null, from: FROM, to: TO })).toBeNull();
  });
});

describe('buildEngineerScorecard — aggregation math', () => {
  beforeEach(seedFullDataset);

  it('groups leads/orders/value/brands per engineer with the won-filter and date range', async () => {
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, granularity: 'month' }))!;
    expect(data).not.toBeNull();
    expect(data.range).toEqual({ from: FROM, to: TO, granularity: 'month' });

    const a = byUser(data, U1);
    expect(a.name).toBe('Alice');
    expect(a.leads_count).toBe(1);                 // L1 only; L3 out of range; L4 converted -> NOT a lead
    expect(a.converted_leads_count).toBe(1);       // L4
    expect(a.contacts_count).toBe(2);              // C1 + C2; C4 out of range (U2), C5 deleted
    expect(a.orders_won).toBe(2);                  // D1 (status won) + D5 (won via stage); D3 closed before range; D6 deleted
    expect(a.order_value).toBe(85000);             // D1 lines 40000+20000 + D5 line 25000
    expect(a.quoted_value).toBe(170000);           // active-in-range deals: D1 100000 + D5 70000
    expect(a.brands).toEqual(['Lincoln', 'MAC']);  // distinct, sorted, from active deals' lines

    const b = byUser(data, U2);
    expect(b.name).toBe('Bob');
    expect(b.leads_count).toBe(1);                 // L2 via assigned_to fallback
    expect(b.converted_leads_count).toBe(0);
    expect(b.contacts_count).toBe(1);              // C3 via assigned_to fallback; C4 out of range
    expect(b.orders_won).toBe(1);                  // D2
    expect(b.order_value).toBe(50000);             // D2 has no line order_value -> amount fallback
    expect(b.quoted_value).toBe(80000);            // D2 50000 + D4 30000
    expect(b.brands).toEqual(['ESAB']);            // D4 line brand
  });

  it('counts leads and contacts SEPARATELY — a converted lead is never counted as a lead', async () => {
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO }))!;
    const a = byUser(data, U1);
    // U1 has two crm_leads rows in range (L1 + L4) but L4 is converted (now a contact).
    // The over-count path is gone: leads_count is 1, not 2.
    expect(a.leads_count).toBe(1);
    expect(a.converted_leads_count).toBe(1);
    // Contacts come straight off crm_contacts, independent of the leads number.
    expect(a.contacts_count).toBe(2);
    // The previous (inflated) total is still fully recoverable.
    expect(a.leads_count + a.converted_leads_count).toBe(2);
    // Separation holds at the totals level too.
    expect(data.totals.leads_count).toBe(2);        // L1 (U1) + L2 (U2)
    expect(data.totals.contacts_count).toBe(3);     // C1 + C2 (U1) + C3 (U2)
    expect(data.totals.converted_leads_count).toBe(1);
  });

  it('degrades contacts_count to 0 when crm_contacts is unreadable (no 500, leads unaffected)', async () => {
    mockTables.crm_contacts = { error: { message: 'relation "crm_contacts" does not exist' } };
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO }))!;
    expect(byUser(data, U1).contacts_count).toBe(0);
    expect(byUser(data, U2).contacts_count).toBe(0);
    // leads + converted split is unaffected by the contacts failure.
    expect(byUser(data, U1).leads_count).toBe(1);
    expect(byUser(data, U1).converted_leads_count).toBe(1);
    expect(data.totals.contacts_count).toBe(0);
  });

  it('counts distinct attendance days in range', async () => {
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO }))!;
    expect(data.attendance_available).toBe(true);
    expect(byUser(data, U1).attendance_days).toBe(2); // 11-05 (dup) + 11-06; 10-31 out of range
    expect(byUser(data, U2).attendance_days).toBe(1);
  });

  it('degrades attendance_days to null when the attendance table is unreadable (no 500)', async () => {
    mockTables.attendance = { error: { message: 'relation "attendance" does not exist' } };
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO }))!;
    expect(data.attendance_available).toBe(false);
    expect(byUser(data, U1).attendance_days).toBeNull();
    expect(byUser(data, U2).attendance_days).toBeNull();
    // other metrics are unaffected
    expect(byUser(data, U1).orders_won).toBe(2);
  });

  it('rolls range totals across engineers', async () => {
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO }))!;
    expect(data.totals).toEqual({
      leads_count: 2,
      contacts_count: 3,
      converted_leads_count: 1,
      orders_won: 3,
      quoted_value: 250000,
      order_value: 135000,
      brands: ['ESAB', 'Lincoln', 'MAC'],
    });
  });

  it('breaks down each engineer by granularity buckets', async () => {
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, granularity: 'month' }))!;
    const a = byUser(data, U1);
    expect(a.buckets).toEqual([
      { bucket_start: '2026-11-01', leads_count: 1, contacts_count: 2, orders_won: 2, order_value: 85000 },
    ]);
    const b = byUser(data, U2);
    expect(b.buckets).toEqual([
      { bucket_start: '2026-11-01', leads_count: 1, contacts_count: 1, orders_won: 1, order_value: 50000 },
    ]);
  });

  it('splits buckets by day when granularity=day (won close date drives the order bucket)', async () => {
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO, granularity: 'day' }))!;
    const a = byUser(data, U1);
    // L1 created 11-05; C1 contact 11-07 (L4 converted excluded from leads); C2 contact 11-12; D1 won 11-08; D5 won 11-20
    expect(a.buckets).toEqual([
      { bucket_start: '2026-11-05', leads_count: 1, contacts_count: 0, orders_won: 0, order_value: 0 },
      { bucket_start: '2026-11-07', leads_count: 0, contacts_count: 1, orders_won: 0, order_value: 0 },
      { bucket_start: '2026-11-08', leads_count: 0, contacts_count: 0, orders_won: 1, order_value: 60000 },
      { bucket_start: '2026-11-12', leads_count: 0, contacts_count: 1, orders_won: 0, order_value: 0 },
      { bucket_start: '2026-11-20', leads_count: 0, contacts_count: 0, orders_won: 1, order_value: 25000 },
    ]);
  });

  it('keeps every active user of the client even with no activity', async () => {
    mockTables.crm_leads = { rows: [] };
    mockTables.crm_contacts = { rows: [] };
    mockTables.crm_deals = { rows: [] };
    mockTables.crm_deal_line_items = { rows: [] };
    const data = (await buildEngineerScorecard({ orgId: ORG, clientId: SPARK_CLIENT_ID, from: FROM, to: TO }))!;
    expect(data.engineers.map((e: any) => e.user_id).sort()).toEqual([U1, U2].sort());
    const a = byUser(data, U1);
    expect(a).toMatchObject({ leads_count: 0, contacts_count: 0, converted_leads_count: 0, orders_won: 0, quoted_value: 0, order_value: 0, brands: [] });
  });
});
