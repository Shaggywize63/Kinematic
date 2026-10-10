/**
 * Rep outlet list + per-outlet outstanding (Gomant C2), and the order-create distributor resolution that the
 * collections flow relies on. Driven through the real handlers against the Supabase double.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  m.client.rpc = jest.fn(async () => ({ data: null, error: null }));
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { myOutlets, outletOutstanding } from '../src/controllers/distribution/salesman.controller';
import { buildPriceContext } from '../src/controllers/distribution/orders.controller';
import router from '../src/routes/distribution/salesman.routes';

const supa = () => (global as any).__supa;

const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT = '99999999-9999-4999-8999-999999999999';
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const S3 = '00000000-0000-4000-8000-000000000003';
const DIST = '33333333-3333-4333-8333-333333333333';
const INV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
const req = (o: { query?: any; params?: any; headers?: any; user?: any } = {}) => ({
  user: o.user ?? { id: 'rep-1', org_id: ORG, client_id: CLIENT, role: 'field_executive' },
  query: o.query ?? {}, params: o.params ?? {}, headers: o.headers ?? {}, body: {},
});
const store = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, store_code: `C-${name}`, address: `${name} road`, phone: '9999900000', city_id: 'c1', cities: { name: 'Hyderabad' }, ...extra,
});

beforeEach(() => supa().reset());

describe('GET /salesman/outlets', () => {
  function seed(opts: { planned?: Array<{ store_id: string; visit_order: number }> } = {}) {
    supa().setDefault('route_plans', { data: [{ id: 'rp1', route_plan_outlets: opts.planned ?? [{ store_id: S2, visit_order: 2 }, { store_id: S1, visit_order: 1 }] }] });
    supa().setDefault('stores', (chain: any) => {
      const hasIn = chain.ops.some((o: any) => o.method === 'in');
      // planned lookup comes back in arbitrary order; the rest is by name
      return { data: hasIn ? [store(S2, 'Beta'), store(S1, 'Alpha')] : [store(S3, 'Gamma')] };
    });
    supa().setDefault('outlet_distribution_ext', { data: [
      { outlet_id: S1, assigned_distributor_id: DIST, current_balance: '1500.5' },
      { outlet_id: S2, assigned_distributor_id: null, current_balance: 0 },
    ] });
    supa().setDefault('distributors', { data: [{ id: DIST, name: 'Gomant Foods' }] });
  }

  it('returns the contract shape, today\'s route outlets first (visit order), then the rest by name', async () => {
    seed();
    const r = await call(myOutlets, req());
    expect(r.status).toBe(200);
    expect(r.body.data.map((o: any) => o.id)).toEqual([S1, S2, S3]);
    expect(r.body.data[0]).toEqual({
      id: S1, name: 'Alpha', code: 'C-Alpha', address: 'Alpha road', city: 'Hyderabad', phone: '9999900000',
      distributor_id: DIST, distributor_name: 'Gomant Foods', outstanding_balance: 1500.5,
    });
    // no distribution ext row / no assigned distributor => nulls and a 0 balance, never undefined
    expect(r.body.data[1]).toMatchObject({ distributor_id: null, distributor_name: null, outstanding_balance: 0 });
    expect(r.body.data[2]).toMatchObject({ distributor_id: null, distributor_name: null, outstanding_balance: 0 });
  });

  it('is scoped to the caller\'s org + client (strict) and only active outlets', async () => {
    seed();
    await call(myOutlets, req());
    for (const c of supa().chainsFor('stores')) {
      expect(c.eqs).toMatchObject({ org_id: ORG, client_id: CLIENT, is_active: true });
    }
    expect(supa().chainsFor('route_plans')[0].eqs).toMatchObject({ user_id: 'rep-1' });
    expect(supa().chainsFor('distributors')[0].eqs).toMatchObject({ org_id: ORG });
  });

  it('org admins without a JWT client use the X-Client-Id picker (strict); with neither it is org-wide', async () => {
    seed();
    const admin = { id: 'a1', org_id: ORG, client_id: null, role: 'admin' };
    await call(myOutlets, req({ user: admin, headers: { 'x-client-id': CLIENT } }));
    expect(supa().chainsFor('stores')[0].eqs.client_id).toBe(CLIENT);

    supa().reset(); seed();
    await call(myOutlets, req({ user: admin }));
    expect('client_id' in supa().chainsFor('stores')[0].eqs).toBe(false);
  });

  it('a JWT-pinned client wins over a spoofed X-Client-Id header', async () => {
    seed();
    await call(myOutlets, req({ headers: { 'x-client-id': '88888888-8888-4888-8888-888888888888' } }));
    expect(supa().chainsFor('stores')[0].eqs.client_id).toBe(CLIENT);
  });

  it('searches name OR code with a sanitised term (no PostgREST injection)', async () => {
    seed();
    await call(myOutlets, req({ query: { search: 'ab,company.eq.x%(' } }));
    const ors = supa().chainsFor('stores')[0].ors;
    expect(ors).toEqual(['name.ilike.%abcompany.eq.x%,store_code.ilike.%abcompany.eq.x%']);
  });

  it('clamps limit to 1..100 (default 50)', async () => {
    seed({ planned: [] });
    const lim = () => supa().chainsFor('stores').pop().ops.find((o: any) => o.method === 'limit')?.args[0];
    await call(myOutlets, req({ query: { limit: '500' } }));
    expect(lim()).toBe(100);
    supa().reset(); seed({ planned: [] });
    await call(myOutlets, req({ query: { limit: '0' } }));
    expect(lim()).toBe(1);
    supa().reset(); seed({ planned: [] });
    await call(myOutlets, req({ query: {} }));
    expect(lim()).toBe(50);
  });

  it('with no route plan today it is just the name-ordered list (and excludes nothing)', async () => {
    seed({ planned: [] });
    const r = await call(myOutlets, req());
    expect(r.body.data.map((o: any) => o.id)).toEqual([S3]);
    expect(supa().chainsFor('stores')[0].ops.some((o: any) => o.method === 'not')).toBe(false);
  });

  it('does not duplicate a planned outlet in the "rest" page', async () => {
    seed();
    supa().setDefault('stores', (chain: any) => ({ data: chain.ops.some((o: any) => o.method === 'in') ? [store(S1, 'Alpha')] : [store(S1, 'Alpha'), store(S3, 'Gamma')] }));
    const r = await call(myOutlets, req());
    expect(r.body.data.map((o: any) => o.id)).toEqual([S1, S3]);
  });
});

describe('GET /salesman/outlets/:outletId/outstanding', () => {
  const invoices = [
    { id: INV_B, invoice_no: 'INV-2', outlet_id: S1, distributor_id: DIST, grand_total: 500, issued_at: '2026-09-10T05:00:00Z', status: 'issued' },
    { id: INV_A, invoice_no: 'INV-1', outlet_id: S1, distributor_id: DIST, grand_total: 1000, issued_at: '2026-09-01T05:00:00Z', status: 'issued' },
  ];
  function seed(o: { ledger?: number | null; credit?: number | null; outlet?: boolean } = {}) {
    supa().setDefault('stores', { data: o.outlet === false ? [] : [{ id: S1, name: 'Alpha' }] });
    supa().setDefault('invoices', { data: invoices });
    supa().setDefault('payments', { data: [
      { id: 'p0', status: 'cleared', applied_to_invoices: [{ invoice_id: INV_A, amount: 400 }] },
      { id: 'p1', status: 'bounced', applied_to_invoices: [{ invoice_id: INV_B, amount: 500 }] },
      { id: 'p2', status: 'pending', applied_to_invoices: [{ invoice_id: INV_A, amount: 100 }] },
    ] });
    supa().setDefault('distributors', { data: [{ id: DIST, payment_terms_days: 30 }] });
    supa().setDefault('ledger_entries', { data: o.ledger === null ? [] : [{ running_balance: o.ledger ?? 1234 }] });
    supa().setDefault('outlet_distribution_ext', { data: o.credit === undefined ? { credit_limit: 50000 } : o.credit === null ? null : { credit_limit: o.credit } });
  }

  it('returns the contract shape: ledger balance, credit limit, open invoices oldest first with derived paid', async () => {
    seed();
    const r = await call(outletOutstanding, req({ params: { outletId: S1 } }));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      outlet_id: S1, outlet_name: 'Alpha', balance: 1234, credit_limit: 50000,
      open_invoices: [
        { invoice_id: INV_A, invoice_no: 'INV-1', invoice_date: '2026-09-01', due_date: '2026-10-01', total: 1000, paid: 500, balance: 500 },
        { invoice_id: INV_B, invoice_no: 'INV-2', invoice_date: '2026-09-10', due_date: '2026-10-10', total: 500, paid: 0, balance: 500 },
      ],
    });
  });

  it('falls back to the sum of open invoice balances when the outlet has no ledger rows', async () => {
    seed({ ledger: null });
    const r = await call(outletOutstanding, req({ params: { outletId: S1 } }));
    expect(r.body.data.balance).toBe(1000);
  });

  it('lists only invoices with balance > 0 and returns credit_limit null when none is configured', async () => {
    seed({ credit: 0 });
    supa().setDefault('payments', { data: [{ id: 'p0', status: 'cleared', applied_to_invoices: [{ invoice_id: INV_A, amount: 1000 }] }] });
    const r = await call(outletOutstanding, req({ params: { outletId: S1 } }));
    expect(r.body.data.open_invoices.map((i: any) => i.invoice_id)).toEqual([INV_B]);
    expect(r.body.data.credit_limit).toBeNull();
    supa().reset(); seed({ credit: null });
    expect((await call(outletOutstanding, req({ params: { outletId: S1 } }))).body.data.credit_limit).toBeNull();
  });

  it('404 for an outlet outside the caller\'s org / client (tenant isolation), scoping on org + client', async () => {
    seed({ outlet: false });
    const r = await call(outletOutstanding, req({ params: { outletId: S1 } }));
    expect(r.status).toBe(404);
    expect(supa().chainsFor('stores')[0].eqs).toMatchObject({ id: S1, org_id: ORG, client_id: CLIENT });
    expect(supa().chainsFor('invoices')).toHaveLength(0);
  });

  it('400 for a non-uuid outlet id without touching the DB', async () => {
    const r = await call(outletOutstanding, req({ params: { outletId: 'abc' } }));
    expect(r.status).toBe(400);
    expect(supa().chains).toHaveLength(0);
  });
});

describe('route registration (existing outlet routes keep working)', () => {
  const routes = (router as any).stack.filter((l: any) => l.route).map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  it('registers the new endpoints alongside the existing /outlets/:id/* ones', () => {
    expect(routes).toEqual(expect.arrayContaining([
      'GET /outlets', 'GET /outlets/:outletId/outstanding', 'GET /outlets/:id/cart-suggest', 'GET /outlets/:id/catalogue', 'POST /payments',
    ]));
  });
});

describe('order create resolves the distributor from the outlet when none is sent', () => {
  const user = { org_id: ORG, client_id: CLIENT };
  function seed(ext: Record<string, unknown> | null) {
    supa().setDefault('stores', { data: { id: S1, name: 'Alpha', lat: 1, lng: 2, city_id: 'c1' } });
    supa().setDefault('outlet_distribution_ext', { data: ext });
    supa().setDefault('distributors', { data: { id: DIST, state_code: '36', place_of_supply: '36', region: 'ALL', customer_class: 'GT', is_active: true } });
  }

  it('uses outlet_distribution_ext.assigned_distributor_id when distributor_id is absent', async () => {
    seed({ assigned_distributor_id: DIST, customer_class: 'MT' });
    const ctx = await buildPriceContext(user, S1);
    expect(ctx.distributor.id).toBe(DIST);
    expect(ctx.customer_class).toBe('MT');
    expect(supa().chainsFor('distributors')[0].eqs).toMatchObject({ id: DIST, org_id: ORG });
  });

  it('an explicit distributor_id still wins (existing behaviour)', async () => {
    seed({ assigned_distributor_id: '44444444-4444-4444-8444-444444444444' });
    await buildPriceContext(user, S1, DIST);
    expect(supa().chainsFor('distributors')[0].eqs.id).toBe(DIST);
  });

  it('rejects with NO_DISTRIBUTOR when neither is available', async () => {
    seed(null);
    await expect(buildPriceContext(user, S1)).rejects.toMatchObject({ code: 'NO_DISTRIBUTOR' });
  });
});
