jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { createOutlet, myOutlets } from '../src/controllers/distribution/salesman.controller';
import { setStoreApproval, storesCtrl } from '../src/controllers/management.controller';

const supa = () => (global as any).__supa;
const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const STORE = '55555555-5555-4555-8555-555555555555';

function call(handler: any, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

const reqFor = (role: string, over: Record<string, unknown> = {}) => ({
  user: { id: USER, org_id: ORG, client_id: CLIENT, role },
  headers: {}, query: {}, params: {}, body: {}, ...over,
});
const insertOf = (table = 'stores') => supa().chainsFor(table).flatMap((c: any) => c.ops).find((o: any) => o.method === 'insert')?.args[0];

beforeEach(() => supa().reset());

describe('POST /salesman/outlets', () => {
  const body = { name: 'Mapusa Mini Mart', phone: '9822012345', lat: 15.59, lng: 73.81, store_type: 'off_trade' };

  it('a rep proposes an outlet: stored as pending, stamped with who made it, with a generated code', async () => {
    supa().queue('stores', { data: { id: STORE, approval_status: 'pending' }, error: null });
    const r = await call(createOutlet, reqFor('executive', { body }));
    expect(r.status).toBe(201);
    const row = insertOf();
    expect(row).toMatchObject({ name: 'Mapusa Mini Mart', approval_status: 'pending', created_by: USER, org_id: ORG, client_id: CLIENT, is_active: true });
    expect(row.store_code).toMatch(/^OUT-[A-Z2-9]{6}$/);
  });

  it('a manager adding one is approved straight away', async () => {
    supa().queue('stores', { data: { id: STORE, approval_status: 'approved' }, error: null });
    await call(createOutlet, reqFor('admin', { body }));
    expect(insertOf().approval_status).toBe('approved');
  });

  it('cannot smuggle an approval, a client or an id in through the body', async () => {
    supa().queue('stores', { data: { id: STORE }, error: null });
    await call(createOutlet, reqFor('executive', { body: { ...body, approval_status: 'approved', client_id: OTHER, id: STORE, created_by: OTHER } }));
    const row = insertOf();
    expect(row.approval_status).toBe('pending');
    expect(row.client_id).toBe(CLIENT);
    expect(row.created_by).toBe(USER);
    expect(row.id).toBeUndefined();
  });

  it('refuses a bad outlet without touching the database', async () => {
    const r = await call(createOutlet, reqFor('executive', { body: { phone: '9822012345' } }));
    expect(r.status).toBe(400);
    expect(supa().chains).toHaveLength(0);
  });
});

describe('PATCH /stores/:id/approval', () => {
  it('a rep cannot approve', async () => {
    const r = await call(setStoreApproval, reqFor('executive', { params: { id: STORE }, body: { status: 'approved' } }));
    expect(r.status).toBe(403);
    expect(supa().chains).toHaveLength(0);
  });

  it('rejecting needs a reason; the status must be approved or rejected', async () => {
    expect((await call(setStoreApproval, reqFor('admin', { params: { id: STORE }, body: { status: 'rejected' } }))).status).toBe(400);
    expect((await call(setStoreApproval, reqFor('admin', { params: { id: STORE }, body: { status: 'pending' } }))).status).toBe(400);
    expect((await call(setStoreApproval, reqFor('admin', { params: { id: 'nope' }, body: { status: 'approved' } }))).status).toBe(404);
    expect(supa().chains).toHaveLength(0);
  });

  it('a manager approves within their org, recording who and when', async () => {
    supa().queue('stores', { data: { id: STORE, approval_status: 'approved' }, error: null });
    const r = await call(setStoreApproval, reqFor('admin', { params: { id: STORE }, body: { status: 'approved' } }));
    expect(r.status).toBe(200);
    const ch = supa().chainsFor('stores')[0];
    const upd = ch.ops.find((o: any) => o.method === 'update').args[0];
    expect(upd).toMatchObject({ approval_status: 'approved', approved_by: USER, rejection_reason: null });
    expect(typeof upd.approved_at).toBe('string');
    expect(ch.eqs).toMatchObject({ id: STORE, org_id: ORG, client_id: CLIENT });
  });

  it('a rejection keeps the reason for the rep to read', async () => {
    supa().queue('stores', { data: { id: STORE }, error: null });
    await call(setStoreApproval, reqFor('admin', { params: { id: STORE }, body: { status: 'rejected', reason: ' Duplicate of OUT-ABC123 ' } }));
    expect(supa().chainsFor('stores')[0].ops.find((o: any) => o.method === 'update').args[0])
      .toMatchObject({ approval_status: 'rejected', rejection_reason: 'Duplicate of OUT-ABC123' });
  });
});

describe('outlet lists respect approval', () => {
  it("the rep's order/collection picker only returns approved outlets", async () => {
    supa().queue('route_plans', { data: [], error: null });
    supa().queue('stores', { data: [], error: null });
    await call(myOutlets, reqFor('executive'));
    const ch = supa().chainsFor('stores')[0];
    expect(ch.eqs.approval_status).toBe('approved');
  });

  it('the stores list shows approved plus the caller\'s own proposals by default', async () => {
    supa().queue('stores', { data: [], error: null });
    await call(storesCtrl.list, reqFor('executive'));
    expect(supa().chainsFor('stores')[0].ors.join(' ')).toContain(`approval_status.eq.approved,created_by.eq.${USER}`);
  });

  it('only an approver can ask for pending ones', async () => {
    supa().queue('stores', { data: [], error: null });
    await call(storesCtrl.list, reqFor('admin', { query: { approval_status: 'pending' } }));
    expect(supa().chainsFor('stores')[0].eqs.approval_status).toBe('pending');

    supa().reset();
    supa().queue('stores', { data: [], error: null });
    await call(storesCtrl.list, reqFor('executive', { query: { approval_status: 'pending' } }));
    const ch = supa().chainsFor('stores')[0];
    expect(ch.eqs.approval_status).toBeUndefined();
    expect(ch.ors.join(' ')).toContain('created_by');
  });
});

describe('plain edits cannot change approval', () => {
  it('a store update drops the approval fields from the body', async () => {
    supa().queue('stores', { data: { id: STORE }, error: null });
    await call(storesCtrl.update, reqFor('admin', {
      params: { id: STORE }, body: { name: 'New name', approval_status: 'approved', approved_by: OTHER, created_by: OTHER },
    }));
    const upd = supa().chainsFor('stores')[0].ops.find((o: any) => o.method === 'update').args[0];
    expect(upd.name).toBe('New name');
    expect(upd.approval_status).toBeUndefined();
    expect(upd.approved_by).toBeUndefined();
    expect(upd.created_by).toBeUndefined();
  });
});
