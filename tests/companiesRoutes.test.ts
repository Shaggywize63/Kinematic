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
