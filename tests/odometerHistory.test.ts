/**
 * GET /expenses/odometer-history — the odometer lines a person has recorded, newest first.
 *
 * Driven against the Supabase double: asserts both the shape returned AND the query built (tenant and
 * client scoping, cancelled claims excluded, ordering, limit), who may ask for whom, and that it
 * degrades to [] on a database that never ran migrations/expense_odometer.sql.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  (m.client as any).storage = {
    from: jest.fn((bucket: string) => ({
      createSignedUrl: jest.fn(async (path: string) => ({ data: { signedUrl: `https://signed.test/${bucket}/${path}?t=1` }, error: null })),
    })),
  };
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({ AIService: { callKiniAI: jest.fn(), getFunctionalKey: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { odometerHistory } from '../src/services/expenses/odometerHistory.service';
import { _resetOdometerProbe } from '../src/services/expenses/vehicleAllowance';
import expensesRouter from '../src/routes/expenses.routes';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '55555555-5555-5555-5555-555555555555';
const REP = '11111111-1111-1111-1111-111111111111';
const REP2 = '12121212-1212-1212-1212-121212121212';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const CLAIM = '44444444-4444-4444-4444-444444444444';
const OTHER_ORG = '99999999-9999-9999-9999-999999999999';

const rep = { id: REP, org_id: ORG, client_id: CLIENT, role: 'executive' } as any;
const admin = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' } as any;
const orgAdmin = { id: ADMIN, org_id: ORG, client_id: null, role: 'admin' } as any;

const bucketUrl = (user: string, n: string, org = ORG) => `https://x.test/storage/v1/object/public/kinematic-receipts/${org}/${user}/${n}.jpg`;

const item = (over: any = {}) => ({
  id: 'l1', claim_id: CLAIM, item_date: '2026-10-06', vehicle_type: 'bike', odometer_start: '1000.0', odometer_end: 1042.5,
  distance_km: '42.50', amount: '170.00', odometer_start_photo_url: bucketUrl(REP, 'a'), odometer_end_photo_url: bucketUrl(REP, 'b'),
  created_at: '2026-10-06T10:00:00Z',
  claim: { claim_no: 'EXP-202610-1234', status: 'draft', user_id: REP, client_id: CLIENT, org_id: ORG },
  ...over,
});

const policyRow = (rules: any = { vehicle_rates: [{ id: 'bike', label: 'Two-wheeler', rate_per_km: 4 }, { id: 'car', label: 'Car', rate_per_km: 9 }] }) => ({
  id: 'p1', org_id: ORG, client_id: null, name: 'Agri', is_active: true, priority: 100, currency: 'INR',
  applies_to: { everyone: true }, deleted_at: null, rules,
});

function arrange(items: any[] = [item()], extra: { policies?: any[] } = {}) {
  __mock.setDefault('expense_claim_items', { data: items });
  __mock.setDefault('expense_policies', { data: extra.policies ?? [policyRow()] });
  __mock.setDefault('users', { data: [
    { id: REP, name: 'Asha', role: 'executive', org_role_id: null },
    { id: REP2, name: 'Bala', role: 'executive', org_role_id: null },
  ] });
}
/** The history query itself (the second chain on the items table; the first is the column probe). */
const historyChain = () => {
  const chains = __mock.chainsFor('expense_claim_items');
  return chains[chains.length - 1];
};
const opsOf = (method: string) => historyChain().ops.filter((o) => o.method === method).map((o) => o.args);

beforeEach(() => { __mock.reset(); _resetOdometerProbe(); });

describe('my own odometer history', () => {
  it('returns the documented shape, newest first, with names, vehicle labels and signed photo links', async () => {
    arrange([item(), item({ id: 'l2', vehicle_type: 'car', item_date: '2026-10-05', odometer_start_photo_url: null, odometer_end_photo_url: null })]);
    const rows = await odometerHistory(rep);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 'l1', claim_id: CLAIM, claim_no: 'EXP-202610-1234', claim_status: 'draft', user_id: REP, user_name: 'Asha',
      item_date: '2026-10-06', vehicle_type: 'bike', vehicle_label: 'Two-wheeler',
      odometer_start: 1000, odometer_end: 1042.5, distance_km: 42.5, amount: 170,
      start_photo_url: `https://signed.test/kinematic-receipts/${ORG}/${REP}/a.jpg?t=1`,
      end_photo_url: `https://signed.test/kinematic-receipts/${ORG}/${REP}/b.jpg?t=1`,
      created_at: '2026-10-06T10:00:00Z',
    });
    expect(rows[1]).toMatchObject({ vehicle_label: 'Car', start_photo_url: null, end_photo_url: null });
    // numbers are numbers, not the strings numeric columns can come back as
    expect(typeof rows[0].odometer_start).toBe('number');
    expect(typeof rows[0].amount).toBe('number');
  });

  it('builds a query that is scoped to this person, this org, with cancelled claims and empty lines left out', async () => {
    arrange();
    await odometerHistory(rep);
    const c = historyChain();
    expect(c.eqs).toMatchObject({ org_id: ORG, 'claim.org_id': ORG, 'claim.user_id': REP });
    expect(opsOf('neq')).toContainEqual(['claim.status', 'cancelled']);
    expect(c.ors).toContain('odometer_start.not.is.null,odometer_end.not.is.null');
    expect(String(opsOf('select')[0][0])).toMatch(/claim:expense_claims!inner\(/);
    // item_date desc, then created_at desc, then the limit
    expect(opsOf('order')).toEqual([['item_date', { ascending: false, nullsFirst: false }], ['created_at', { ascending: false }]]);
    expect(opsOf('limit')).toEqual([[50]]);
  });

  it('is not widened to the whole client for an ordinary caller', async () => {
    arrange();
    await odometerHistory(rep);
    expect(historyChain().eqs['claim.client_id']).toBeUndefined();
    expect(historyChain().eqs['claim.user_id']).toBe(REP);
  });

  it('applies the date range to the line date', async () => {
    arrange();
    await odometerHistory(rep, { from: '2026-10-01', to: '2026-10-31' });
    expect(opsOf('gte')).toContainEqual(['item_date', '2026-10-01']);
    expect(opsOf('lte')).toContainEqual(['item_date', '2026-10-31']);
  });

  it('refuses a range that ends before it starts', async () => {
    arrange();
    await expect(odometerHistory(rep, { from: '2026-10-31', to: '2026-10-01' })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  it('defaults the limit to 50 and caps it at 200', async () => {
    arrange();
    for (const [asked, used] of [[undefined, 50], [0, 50], [NaN, 50], [-5, 1], [10, 10], [200, 200], [201, 200], [5000, 200]] as const) {
      __mock.reset(); _resetOdometerProbe(); arrange();
      await odometerHistory(rep, { limit: asked as any });
      expect({ asked, used: opsOf('limit')[0][0] }).toEqual({ asked, used });
    }
  });

  it('allows asking for yourself by id', async () => {
    arrange();
    await expect(odometerHistory(rep, { user_id: REP })).resolves.toHaveLength(1);
    expect(historyChain().eqs['claim.user_id']).toBe(REP);
  });

  it('is empty (and cheap) when there is nothing', async () => {
    arrange([]);
    await expect(odometerHistory(rep)).resolves.toEqual([]);
  });
});

describe('vehicle labels', () => {
  it('fall back to the stored vehicle id when the policy no longer lists it', async () => {
    arrange([item({ vehicle_type: 'rocket' })]);
    expect((await odometerHistory(rep))[0]).toMatchObject({ vehicle_type: 'rocket', vehicle_label: 'rocket' });
  });
  it('fall back to the id when no policy has vehicle rates', async () => {
    arrange([item()], { policies: [policyRow({})] });
    expect((await odometerHistory(rep))[0].vehicle_label).toBe('bike');
  });
  it('are null for a line with no vehicle', async () => {
    arrange([item({ vehicle_type: null })]);
    expect((await odometerHistory(rep))[0]).toMatchObject({ vehicle_type: null, vehicle_label: null });
  });
  it('never fail the history when the policy cannot be read', async () => {
    arrange();
    __mock.setDefault('expense_policies', { data: null, error: { message: 'boom' } });
    expect((await odometerHistory(rep))[0]).toMatchObject({ vehicle_type: 'bike', vehicle_label: 'bike' });
  });
  it('come from each claimant\'s own governing policy', async () => {
    const specific = { ...policyRow({ vehicle_rates: [{ id: 'bike', label: 'Motorbike', rate_per_km: 5 }] }), id: 'p2', applies_to: { everyone: false, user_ids: [REP2], roles: [], org_role_ids: [] } };
    arrange([
      item({ id: 'a', claim: { claim_no: 'A', status: 'draft', user_id: REP, client_id: CLIENT, org_id: ORG } }),
      item({ id: 'b', claim: { claim_no: 'B', status: 'draft', user_id: REP2, client_id: CLIENT, org_id: ORG } }),
    ], { policies: [policyRow(), specific] });
    const rows = await odometerHistory(admin, { all: true });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.vehicle_label]))).toEqual({ a: 'Two-wheeler', b: 'Motorbike' });
    expect(rows.find((r) => r.id === 'b')!.user_name).toBe('Bala');
  });
});

describe('photo links', () => {
  it('are null when absent, passed through when external, and never signed across tenants', async () => {
    arrange([item({
      odometer_start_photo_url: 'https://cdn.example.com/o.jpg',
      odometer_end_photo_url: bucketUrl(REP, 'z', OTHER_ORG),
    })]);
    const [r] = await odometerHistory(rep);
    expect(r.start_photo_url).toBe('https://cdn.example.com/o.jpg');
    expect(r.end_photo_url).toBeNull();
  });
  it('signs every line, however many', async () => {
    arrange(Array.from({ length: 30 }, (_, i) => item({ id: `l${i}` })));
    const rows = await odometerHistory(rep, { limit: 30 });
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.start_photo_url && r.end_photo_url)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 30 }, (_, i) => `l${i}`)); // order kept
  });
});

describe('other people\'s history', () => {
  it('is refused for an ordinary user, whoever they ask about', async () => {
    arrange();
    await expect(odometerHistory(rep, { user_id: REP2 })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(odometerHistory(rep, { all: true })).rejects.toMatchObject({ statusCode: 403 });
    expect(__mock.chainsFor('expense_claim_items')).toHaveLength(0); // refused before reading anything
  });
  it('is refused for a field-exec on a flat tenant who carries an admin-ish legacy role', async () => {
    arrange();
    const flatRep = { ...rep, role: 'sub_admin', data_scope: 'own' };
    await expect(odometerHistory(flatRep, { all: true })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('lets an approver see one person, inside their own org and client', async () => {
    arrange();
    await odometerHistory(admin, { user_id: REP });
    expect(historyChain().eqs).toMatchObject({ org_id: ORG, 'claim.org_id': ORG, 'claim.client_id': CLIENT, 'claim.user_id': REP });
  });
  it('lets an approver see everybody (all=1), still inside their org and client', async () => {
    arrange();
    await odometerHistory(admin, { all: true });
    const eqs = historyChain().eqs;
    expect(eqs).toMatchObject({ org_id: ORG, 'claim.client_id': CLIENT });
    expect(eqs['claim.user_id']).toBeUndefined();
    expect(opsOf('neq')).toContainEqual(['claim.status', 'cancelled']);
  });
  it('an org-level approver with no client picked is bounded by the org only', async () => {
    arrange();
    await odometerHistory(orgAdmin, { all: true });
    expect(historyChain().eqs['claim.client_id']).toBeUndefined();
    expect(historyChain().eqs['org_id']).toBe(ORG);
  });
  it('never puts a user id into a raw .or() filter', async () => {
    arrange();
    await odometerHistory(admin, { user_id: REP });
    expect(historyChain().ors).toEqual(['odometer_start.not.is.null,odometer_end.not.is.null']);
  });
});

describe('a database without the odometer columns', () => {
  it('has no history, and the history query is never attempted', async () => {
    arrange();
    __mock.setDefault('expense_claim_items', { data: null, error: { message: 'column expense_claim_items.vehicle_type does not exist' } });
    await expect(odometerHistory(rep)).resolves.toEqual([]);
    expect(__mock.chainsFor('expense_claim_items')).toHaveLength(1); // only the column probe
  });
});

describe('a database error', () => {
  it('is a 500, not an empty list that hides it', async () => {
    arrange();
    __mock.queue('expense_claim_items', { data: [] });                           // column probe is fine
    __mock.queue('expense_claim_items', { data: null, error: { message: 'relation "x" does not exist' } });
    await expect(odometerHistory(rep)).rejects.toMatchObject({ statusCode: 500, code: 'DB' });
  });
});

describe('claim embedded as a list', () => {
  it('is handled (PostgREST may return an array for a to-one embed)', async () => {
    arrange([item({ claim: [{ claim_no: 'EXP-9', status: 'submitted', user_id: REP, client_id: CLIENT, org_id: ORG }] })]);
    expect((await odometerHistory(rep))[0]).toMatchObject({ claim_no: 'EXP-9', claim_status: 'submitted' });
  });
});

// ── through the real router ──────────────────────────────────────────────────
describe('GET /expenses/odometer-history', () => {
  const app = express();
  app.use((req: any, _res, next) => { req.user = req.headers['x-role'] === 'admin' ? admin : rep; next(); });
  app.use('/expenses', expensesRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  it('answers { success, data } with the caller\'s lines', async () => {
    arrange();
    const res = await request(app).get('/expenses/odometer-history');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: 'l1', vehicle_label: 'Two-wheeler', odometer_end: 1042.5 });
    expect(historyChain().eqs['claim.user_id']).toBe(REP);
  });

  it('is its own route, not read as a claim id', async () => {
    arrange();
    const res = await request(app).get('/expenses/odometer-history');
    expect(res.status).toBe(200);
    expect(__mock.chainsFor('expense_claims')).toHaveLength(0);
  });

  it('passes limit, from and to through', async () => {
    arrange();
    await request(app).get('/expenses/odometer-history').query({ limit: '7', from: '2026-10-01', to: '2026-10-09' });
    expect(opsOf('limit')).toEqual([[7]]);
    expect(opsOf('gte')).toContainEqual(['item_date', '2026-10-01']);
    expect(opsOf('lte')).toContainEqual(['item_date', '2026-10-09']);
  });

  it('ignores empty parameters', async () => {
    arrange();
    const res = await request(app).get('/expenses/odometer-history?from=&to=&user_id=&all=&limit=');
    expect(res.status).toBe(200);
    expect(opsOf('gte')).toHaveLength(0);
    expect(opsOf('limit')).toEqual([[50]]);
  });

  it('validates the dates and the user id', async () => {
    arrange();
    for (const qs of ['from=10/01/2026', 'to=yesterday', 'user_id=not-a-uuid', 'user_id=1;drop', 'all=maybe']) {
      const res = await request(app).get(`/expenses/odometer-history?${qs}`).set('x-role', 'admin');
      expect({ qs, status: res.status }).toEqual({ qs, status: 400 });
    }
    expect(__mock.chainsFor('expense_claim_items')).toHaveLength(0); // nothing was queried
  });

  it('is 403 for an ordinary user asking for somebody else, or for everybody', async () => {
    arrange();
    expect((await request(app).get(`/expenses/odometer-history?user_id=${REP2}`)).status).toBe(403);
    expect((await request(app).get('/expenses/odometer-history?all=1')).status).toBe(403);
    expect((await request(app).get('/expenses/odometer-history?all=true')).status).toBe(403);
  });

  it('lets an approver ask for everybody or one person', async () => {
    arrange();
    const all = await request(app).get('/expenses/odometer-history?all=1').set('x-role', 'admin');
    expect(all.status).toBe(200);
    expect(historyChain().eqs).toMatchObject({ 'claim.client_id': CLIENT });
    expect(historyChain().eqs['claim.user_id']).toBeUndefined();
    __mock.reset(); _resetOdometerProbe(); arrange();
    const one = await request(app).get(`/expenses/odometer-history?user_id=${REP2}`).set('x-role', 'admin');
    expect(one.status).toBe(200);
    expect(historyChain().eqs['claim.user_id']).toBe(REP2);
  });

  it('all=0 is the same as not asking', async () => {
    arrange();
    const res = await request(app).get('/expenses/odometer-history?all=0');
    expect(res.status).toBe(200);
    expect(historyChain().eqs['claim.user_id']).toBe(REP);
  });
});
