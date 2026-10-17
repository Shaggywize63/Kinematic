jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(String(req.user?.role).toLowerCase()) ? next() : res.status(403).json({ success: false, error: 'forbidden' }),
}));

import router from '../src/routes/companies.routes';

const supa = () => (global as any).__supa;
const ORG = '11111111-1111-4111-8111-111111111111';
const U = '44444444-4444-4444-8444-444444444444';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

/** Runs the matching route's handler stack (auth stubbed) and resolves with what it answered. */
function hit(method: 'get' | 'put', path: string, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const layer = (router as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
    if (!layer) return reject(new Error(`no route ${method} ${path}`));
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    const handlers = layer.route.stack.map((s: any) => s.handle);
    let i = 0;
    const next = (err?: any) => { if (err) return reject(err); const h = handlers[i++]; if (h) Promise.resolve(h(req, res, next)).catch(reject); };
    next();
  });
}

const admin = (over: any = {}) => ({ user: { id: 'a', org_id: ORG, role: 'admin' }, params: {}, body: {}, ...over });
beforeEach(() => supa().reset());

describe('GET /companies/all', () => {
  it('lists the org\'s companies for an admin, scoped to the org', async () => {
    supa().queue('clients', { data: [{ id: A, name: 'Gomant Traders LLP' }, { id: B, name: 'Royal Spirits North' }], error: null });
    const r = await hit('get', '/all', admin());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    expect(supa().chainsFor('clients')[0].eqs.org_id).toBe(ORG);
  });
  it('is closed to reps', async () => {
    const r = await hit('get', '/all', { user: { id: 'r', org_id: ORG, role: 'executive' } });
    expect(r.status).toBe(403);
    expect(supa().chains).toHaveLength(0);
  });
});

describe('GET /companies/users/:userId', () => {
  it('returns the user\'s assigned companies', async () => {
    supa().queue('users', { data: { id: U }, error: null });
    supa().queue('user_companies', { data: [{ client_id: A }, { client_id: B }], error: null });
    const r = await hit('get', '/users/:userId', admin({ params: { userId: U } }));
    expect(r.body.data).toEqual({ user_id: U, client_ids: [A, B] });
    expect(supa().chainsFor('users')[0].eqs).toMatchObject({ id: U, org_id: ORG });
  });
  it('404s a user outside the org and 400s a bad id, without reading assignments', async () => {
    supa().queue('users', { data: null, error: null });
    expect((await hit('get', '/users/:userId', admin({ params: { userId: U } }))).status).toBe(404);
    expect((await hit('get', '/users/:userId', admin({ params: { userId: 'nope' } }))).status).toBe(400);
    expect(supa().chainsFor('user_companies')).toHaveLength(0);
  });
});

describe('PUT /companies/users/:userId', () => {
  it('replaces the assignments after checking user and companies belong to the org', async () => {
    supa().queue('users', { data: { id: U }, error: null });
    supa().queue('clients', { data: [{ id: A }, { id: B }], error: null });
    const r = await hit('put', '/users/:userId', admin({ params: { userId: U }, body: { client_ids: [A, B, A] } }));
    expect(r.status).toBe(200);
    expect(r.body.data.client_ids).toEqual([A, B]);
    const ops = supa().chainsFor('user_companies').flatMap((c: any) => c.ops.map((o: any) => o.method));
    expect(ops).toContain('delete');
    expect(ops).toContain('insert');
  });
  it('refuses a company that is not in the org, and writes nothing', async () => {
    supa().queue('users', { data: { id: U }, error: null });
    supa().queue('clients', { data: [{ id: A }], error: null });
    const r = await hit('put', '/users/:userId', admin({ params: { userId: U }, body: { client_ids: [A, B] } }));
    expect(r.status).toBe(400);
    expect(supa().chainsFor('user_companies')).toHaveLength(0);
  });
  it('an empty list clears the assignments', async () => {
    supa().queue('users', { data: { id: U }, error: null });
    const r = await hit('put', '/users/:userId', admin({ params: { userId: U }, body: { client_ids: [] } }));
    expect(r.status).toBe(200);
    const ops = supa().chainsFor('user_companies').flatMap((c: any) => c.ops.map((o: any) => o.method));
    expect(ops).toContain('delete');
    expect(ops).not.toContain('insert');
  });
});

describe('GET /companies/report', () => {
  const q = { from: '2026-10-01', to: '2026-10-17' };
  it('totals each company and all of them together', async () => {
    supa().queue('clients', { data: [{ id: A, name: 'Gomant Traders LLP' }, { id: B, name: 'Royal Spirits North' }], error: null });
    supa().queue('orders', { data: [{ client_id: A, grand_total: 100 }, { client_id: A, grand_total: 50.5 }, { client_id: B, grand_total: 200 }], error: null });
    supa().queue('invoices', { data: [{ client_id: B, grand_total: 180 }], error: null });
    supa().queue('payments', { data: [{ client_id: A, amount: 60, mode: 'cash' }, { client_id: A, amount: 40, mode: 'upi' }, { client_id: B, amount: 10, mode: 'cash' }], error: null });
    supa().queue('returns', { data: [{ client_id: A, total_value: 25 }], error: null });
    const r = await hit('get', '/report', admin({ query: q }));
    expect(r.status).toBe(200);
    const [a, b] = r.body.data.companies;
    expect(a).toMatchObject({ client_id: A, orders: 2, order_value: 150.5, collected: 100, returns: 1, return_value: 25 });
    expect(a.collected_by_mode).toEqual({ cash: 60, upi: 40 });
    expect(b).toMatchObject({ client_id: B, orders: 1, invoices: 1, invoice_value: 180 });
    expect(r.body.data.total).toMatchObject({ orders: 3, order_value: 350.5, collected: 110, invoice_value: 180 });
    expect(r.body.data.total.collected_by_mode).toEqual({ cash: 70, upi: 40 });
  });
  it('scopes every query to the caller\'s org and the date window', async () => {
    await hit('get', '/report', admin({ query: q }));
    for (const t of ['clients', 'orders', 'invoices', 'payments', 'returns']) {
      expect(supa().chainsFor(t)[0].eqs.org_id).toBe(ORG);
    }
    const ops = supa().chainsFor('orders')[0].ops;
    expect(ops.find((o: any) => o.method === 'gte').args[1]).toBe('2026-10-01T00:00:00.000Z');
    expect(ops.find((o: any) => o.method === 'lt').args[1]).toBe('2026-10-18T00:00:00.000Z');
  });
  it('keeps rows without a company visible instead of dropping them', async () => {
    supa().queue('clients', { data: [{ id: A, name: 'Gomant Traders LLP' }], error: null });
    supa().queue('orders', { data: [{ client_id: null, grand_total: 70 }], error: null });
    const r = await hit('get', '/report', admin({ query: q }));
    expect(r.body.data.companies.map((c: any) => c.name)).toEqual(['Gomant Traders LLP', 'No company']);
    expect(r.body.data.total.order_value).toBe(70);
  });
  it('rejects a bad date range and non-admins', async () => {
    expect((await hit('get', '/report', admin({ query: { from: '2026-10-17', to: '2026-10-01' } }))).status).toBe(400);
    expect((await hit('get', '/report', admin({ query: { from: 'x' } }))).status).toBe(400);
    expect((await hit('get', '/report', { user: { id: 'r', org_id: ORG, role: 'executive' }, query: q })).status).toBe(403);
  });
});

describe('a client-pinned admin never sees or assigns other clients', () => {
  const C = '55555555-5555-4555-8555-555555555555';   // another client in the same org
  const scopedAdmin = (over: any = {}) => ({ user: { id: 'a', org_id: ORG, role: 'admin', client_id: A }, params: {}, body: {}, query: { from: '2026-10-01', to: '2026-10-17' }, ...over });

  it('/all is limited to their own company', async () => {
    await hit('get', '/all', scopedAdmin());
    const ops = supa().chainsFor('clients')[0].ops;
    expect(ops.find((o: any) => o.method === 'in').args).toEqual(['id', [A]]);
  });
  it('/all for an assigned-companies admin lists exactly those', async () => {
    await hit('get', '/all', scopedAdmin({ user: { id: 'a', org_id: ORG, role: 'admin', client_id: A, company_client_ids: [A, B] } }));
    expect(supa().chainsFor('clients')[0].ops.find((o: any) => o.method === 'in').args).toEqual(['id', [A, B]]);
  });
  it('an org-wide admin (no client) is not filtered', async () => {
    await hit('get', '/all', admin());
    expect(supa().chainsFor('clients')[0].ops.some((o: any) => o.method === 'in')).toBe(false);
  });
  it('the report reads only their companies, from every table', async () => {
    await hit('get', '/report', scopedAdmin());
    for (const t of ['clients', 'orders', 'invoices', 'payments', 'returns']) {
      const inOp = supa().chainsFor(t)[0].ops.find((o: any) => o.method === 'in');
      expect(inOp.args[1]).toEqual([A]);
    }
  });
  it('cannot assign a company that is not theirs, and writes nothing', async () => {
    const r = await hit('put', '/users/:userId', scopedAdmin({ params: { userId: U }, body: { client_ids: [C] } }));
    expect(r.status).toBe(403);
    expect(supa().chains).toHaveLength(0);
  });
  it('cannot read or edit a user who belongs to another client (looks like not found)', async () => {
    supa().queue('users', { data: { id: U, client_id: C }, error: null });
    expect((await hit('get', '/users/:userId', scopedAdmin({ params: { userId: U } }))).status).toBe(404);
    supa().queue('users', { data: { id: U, client_id: C }, error: null });
    supa().queue('clients', { data: [{ id: A }], error: null });
    expect((await hit('put', '/users/:userId', scopedAdmin({ params: { userId: U }, body: { client_ids: [A] } }))).status).toBe(404);
    expect(supa().chainsFor('user_companies')).toHaveLength(0);
  });
  it('replacing assignments only removes the ones they can see', async () => {
    supa().queue('users', { data: { id: U, client_id: A }, error: null });
    supa().queue('clients', { data: [{ id: A }], error: null });
    const r = await hit('put', '/users/:userId', scopedAdmin({ params: { userId: U }, body: { client_ids: [A] } }));
    expect(r.status).toBe(200);
    const del = supa().chainsFor('user_companies').find((c: any) => c.ops.some((o: any) => o.method === 'delete'));
    expect(del.ops.find((o: any) => o.method === 'in').args).toEqual(['client_id', [A]]);
  });
  it('hides assignments to companies they cannot see when reading a user', async () => {
    supa().queue('users', { data: { id: U, client_id: A }, error: null });
    supa().queue('user_companies', { data: [{ client_id: A }, { client_id: C }], error: null });
    const r = await hit('get', '/users/:userId', scopedAdmin({ params: { userId: U } }));
    expect(r.body.data.client_ids).toEqual([A]);
  });
});
