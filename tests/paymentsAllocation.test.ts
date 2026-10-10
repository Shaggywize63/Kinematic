/**
 * POST payments with invoice allocation (Gomant C2), driven through the real controller against the Supabase
 * double:
 *   - neither field            => legacy behaviour (empty applied_to_invoices, no extra reads)
 *   - auto_allocate            => oldest-first across the outlet's open invoices, invoice_no persisted, remainder on account
 *   - manual applied_to_invoices => validated against THIS org + outlet and the live balance (400 otherwise)
 *   - idempotent retry         => still the duplicate (409) response, not a fresh validation failure
 * Also covers the daily collection cap staying intact.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  m.client.rpc = jest.fn(async (name: string) => ({ data: name === 'gen_payment_no' ? 'PAY-261010-00001' : null, error: null }));
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { create } from '../src/controllers/distribution/payments.controller';

const supa = () => (global as any).__supa;

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTLET = '22222222-2222-4222-8222-222222222222';
const DIST = '33333333-3333-4333-8333-333333333333';
const INV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // oldest, 1000 (400 already paid) -> 600 open
const INV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // 500 open
const INV_FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function call(handler: any, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    handler(req, res, reject);
  });
}

const user = (o: Record<string, unknown> = {}) => ({ id: 'rep-1', org_id: ORG, client_id: 'client-1', role: 'sub_admin', ...o });
const request = (body: Record<string, unknown>, o: { headers?: Record<string, string>; user?: any } = {}) => ({
  user: o.user ?? user(), body, headers: o.headers ?? {}, query: {}, params: {}, ip: '127.0.0.1',
});

/** Seeds: outlet has an assigned distributor; two issued invoices; one earlier cleared payment of 400 on INV_A. */
function seed(opts: { insertError?: { code?: string; message: string }; existingKey?: boolean } = {}) {
  supa().setDefault('outlet_distribution_ext', { data: { assigned_distributor_id: DIST } });
  supa().setDefault('invoices', {
    data: [
      { id: INV_A, invoice_no: 'INV-1', outlet_id: OUTLET, distributor_id: DIST, grand_total: 1000, issued_at: '2026-09-01T05:00:00Z', status: 'issued' },
      { id: INV_B, invoice_no: 'INV-2', outlet_id: OUTLET, distributor_id: DIST, grand_total: 500, issued_at: '2026-09-10T05:00:00Z', status: 'issued' },
    ],
  });
  supa().setDefault('distributors', { data: [{ id: DIST, payment_terms_days: 0 }] });
  supa().setDefault('payments', (chain: any) => {
    if (chain.ops.some((o: any) => o.method === 'insert')) {
      if (opts.insertError) return { data: null, error: opts.insertError };
      const row = chain.ops.find((o: any) => o.method === 'insert').args[0];
      return { data: { id: 'pay-new', ...row } };
    }
    if ('idempotency_key' in chain.eqs) return { data: opts.existingKey ? [{ id: 'pay-old' }] : [] };
    // loadOutletInvoiceBalances: the outlet's earlier cleared/pending payments (+ a bounced one that must not count)
    return {
      data: [
        { id: 'p0', status: 'cleared', applied_to_invoices: [{ invoice_id: INV_A, amount: 400 }] },
        { id: 'p1', status: 'bounced', applied_to_invoices: [{ invoice_id: INV_B, amount: 500 }] },
      ],
    };
  });
}

const inserted = (): any => {
  const c = supa().chainsFor('payments').find((ch: any) => ch.ops.some((o: any) => o.method === 'insert'));
  return c ? c.ops.find((o: any) => o.method === 'insert').args[0] : null;
};
const readsInvoices = () => supa().chainsFor('invoices').length > 0;

beforeEach(() => { supa().reset(); supa().client.rpc.mockClear(); });

describe('payments.create - legacy callers (no allocation fields)', () => {
  it('stores an empty applied_to_invoices and never reads invoices / payments for balances', async () => {
    seed();
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 250 }));
    expect(r.status).toBe(201);
    expect(inserted().applied_to_invoices).toEqual([]);
    expect(inserted()).toMatchObject({ org_id: ORG, outlet_id: OUTLET, distributor_id: DIST, amount: 250, status: 'cleared' });
    expect(readsInvoices()).toBe(false);
  });

  it('keeps the ledger CR for cleared payments (unchanged)', async () => {
    seed();
    await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 250 }));
    expect(supa().client.rpc).toHaveBeenCalledWith('post_ledger_entry', expect.objectContaining({ p_cr: 250, p_outlet: OUTLET }));
  });
});

describe('payments.create - auto_allocate', () => {
  it('allocates oldest-first, persists invoice_no, and nets off earlier payments (bounced ones do not count)', async () => {
    seed();
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 800, auto_allocate: true }));
    expect(r.status).toBe(201);
    expect(inserted().applied_to_invoices).toEqual([
      { invoice_id: INV_A, invoice_no: 'INV-1', amount: 600 },
      { invoice_id: INV_B, invoice_no: 'INV-2', amount: 200 },
    ]);
    // the response is the payment row, as today
    expect(r.body.data.applied_to_invoices).toHaveLength(2);
    expect(r.body.data.amount).toBe(800);
  });

  it('leaves the remainder on account when the amount exceeds all open balances', async () => {
    seed();
    await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 5000, auto_allocate: true }));
    const entries = inserted().applied_to_invoices;
    expect(entries.map((e: any) => e.amount)).toEqual([600, 500]);
    expect(inserted().amount).toBe(5000); // full amount recorded; 3900 is unallocated / on account
  });

  it('scopes the balance reads to the caller\'s org and the payment\'s outlet', async () => {
    seed();
    await call(create, request({ outlet_id: OUTLET, mode: 'upi', amount: 100, auto_allocate: true }));
    expect(supa().chainsFor('invoices')[0].eqs).toMatchObject({ org_id: ORG, outlet_id: OUTLET });
  });

  it('auto_allocate:false behaves like the legacy path', async () => {
    seed();
    await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 100, auto_allocate: false }));
    expect(inserted().applied_to_invoices).toEqual([]);
    expect(readsInvoices()).toBe(false);
  });

  it('manual entries win over auto_allocate when both are sent', async () => {
    seed();
    await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 300, auto_allocate: true, applied_to_invoices: [{ invoice_id: INV_B, amount: 300 }] }));
    expect(inserted().applied_to_invoices).toEqual([{ invoice_id: INV_B, invoice_no: 'INV-2', amount: 300 }]);
  });
});

describe('payments.create - manual applied_to_invoices', () => {
  it('accepts a valid allocation and stamps the server invoice_no (a client-sent one is ignored)', async () => {
    seed();
    const r = await call(create, request({
      outlet_id: OUTLET, mode: 'cash', amount: 700,
      applied_to_invoices: [{ invoice_id: INV_A, invoice_no: 'FORGED', amount: 600 }, { invoice_id: INV_B, amount: 100 }],
    }));
    expect(r.status).toBe(201);
    expect(inserted().applied_to_invoices).toEqual([
      { invoice_id: INV_A, invoice_no: 'INV-1', amount: 600 },
      { invoice_id: INV_B, invoice_no: 'INV-2', amount: 100 },
    ]);
  });

  it('400 when an invoice does not belong to the outlet / org', async () => {
    seed();
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 100, applied_to_invoices: [{ invoice_id: INV_FOREIGN, amount: 100 }] }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/do not belong to this outlet/);
    expect(r.body.details.invoice_ids).toEqual([INV_FOREIGN]);
    expect(inserted()).toBeNull();
  });

  it('400 when an amount exceeds the invoice balance (net of earlier payments)', async () => {
    seed();
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 700, applied_to_invoices: [{ invoice_id: INV_A, amount: 700 }] }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceeds the outstanding balance/);
    expect(inserted()).toBeNull();
  });

  it('400 when allocations exceed the payment amount', async () => {
    seed();
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 100, applied_to_invoices: [{ invoice_id: INV_A, amount: 600 }] }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceeds the payment amount/);
  });

  it('400 on a malformed entry (non-uuid invoice_id) before touching the DB', async () => {
    seed();
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 100, applied_to_invoices: [{ invoice_id: 'nope', amount: 100 }] }));
    expect(r.status).toBe(400);
    expect(supa().chains).toHaveLength(0);
  });
});

describe('payments.create - idempotency + caps stay intact', () => {
  it('a retry of an already-recorded allocated payment returns the duplicate 409 (not a 400 from stale balances)', async () => {
    seed({ existingKey: true });
    const r = await call(create, request(
      { outlet_id: OUTLET, mode: 'cash', amount: 600, applied_to_invoices: [{ invoice_id: INV_A, amount: 600 }] },
      { headers: { 'idempotency-key': 'k-1' } },
    ));
    expect(r.status).toBe(409);
    expect(inserted()).toBeNull();
    expect(readsInvoices()).toBe(false);
  });

  it('the DB unique violation still maps to 409 and the key is stored on the row', async () => {
    seed({ insertError: { code: '23505', message: 'duplicate key' } });
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 50 }, { headers: { 'idempotency-key': 'k-2' } }));
    expect(r.status).toBe(409);
    expect(inserted().idempotency_key).toBe('k-2');
  });

  it('first submit with a key stores it on the row', async () => {
    seed();
    const r = await call(create, request({ outlet_id: OUTLET, mode: 'cash', amount: 600, auto_allocate: true }, { headers: { 'idempotency-key': 'k-3' } }));
    expect(r.status).toBe(201);
    expect(inserted().idempotency_key).toBe('k-3');
  });

  it('the salesman daily collection cap still blocks (403) before any allocation work', async () => {
    seed();
    supa().setDefault('salesman_ext', { data: { daily_collection_cap: 1000 } });
    // existing select-amount query on payments (salesman_id scoped) reports 900 already collected today
    supa().setDefault('payments', (chain: any) => {
      if ('salesman_id' in chain.eqs) return { data: [{ amount: 900 }] };
      return { data: [] };
    });
    const r = await call(create, request(
      { outlet_id: OUTLET, mode: 'cash', amount: 200, auto_allocate: true },
      { user: user({ role: 'field_executive' }) },
    ));
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Daily collection cap/);
    expect(readsInvoices()).toBe(false);
  });
});
