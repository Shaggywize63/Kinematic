/**
 * Sales / Collection rupee targets (crm_settings.config.targets, crm_targets monthly *_amount metrics,
 * crm_target_entries) — driven against the Supabase double.
 *
 * What is pinned here: the config schema and the gating by enabled type; the admin endpoints taking an
 * optional `type`; progress math, target resolution order and IST month boundaries; the entries API
 * (validation limits, who may see whose, the 24 h delete window); and the pre-migration behaviour.
 * (That requests WITHOUT a type are unchanged is pinned separately in targetsLeads.test.ts.)
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock, RecordedChain } from './helpers/supabaseMock';
import { fakeTable } from './helpers/fakeTable';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers['x-test-user'] ?? '{}'));
    next();
  },
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as v from '../src/validators/crm.validators';
import * as te from '../src/services/crm/targetEntries.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '55555555-5555-5555-5555-555555555555';
const OTHER_CLIENT = '99999999-9999-9999-9999-999999999999';
const ROLE = '66666666-6666-6666-6666-666666666666';
const LEVEL = '77777777-7777-7777-7777-777777777777';
const REP = '11111111-1111-1111-1111-111111111111';
const REP2 = '12121212-1212-1212-1212-121212121212';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const LEAD = '88888888-8888-8888-8888-888888888888';
const ENTRY = '44444444-4444-4444-4444-444444444444';

const BOTH = { targets: { types: [{ key: 'sales' }, { key: 'collection' }] } };
const SALES_ONLY = { targets: { types: [{ key: 'sales', label: 'Order target' }] } };

const admin = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' };
const rep = { id: REP, org_id: ORG, client_id: CLIENT, role: 'executive', org_role_id: ROLE, org_role_data_scope: 'own' };
const actorOf = (u: any) => ({ id: u.id, org_id: u.org_id, client_id: u.client_id, role: u.role, data_scope: u.org_role_data_scope ?? null });

/** crm_settings: the config for a client's own row, with an optional org-level default. */
function settings(byClient: Record<string, unknown | null>, orgDefault: unknown | null = null) {
  __mock.setDefault('crm_settings', (chain) => {
    const orgLevel = chain.ops.some((o) => o.method === 'is' && o.args[0] === 'client_id');
    const cfg = orgLevel ? orgDefault : byClient[String(chain.eqs['client_id'])] ?? null;
    return { data: cfg ? [{ config: cfg }] : [] };
  });
}
const entry = (o: any = {}) => ({
  id: ENTRY, org_id: ORG, client_id: CLIENT, user_id: REP, kind: 'sales', amount: 1000, entry_date: '2026-01-15', lead_id: null, note: null,
  created_by: REP, created_at: '2026-01-15T10:00:00.000Z', deleted_at: null, ...o,
});
const trow = (o: any = {}) => ({ org_id: ORG, user_id: null, org_role_id: null, hierarchy_level_id: null, client_id: CLIENT, metric: 'sales_amount', period: 'monthly', target_value: 100000, ...o });
const opsOf = (c: RecordedChain, m: string) => c.ops.filter((o) => o.method === m).map((o) => o.args);
const insertsOf = (table: string) => __mock.chainsFor(table).flatMap((c) => opsOf(c, 'insert').map((a) => a[0] as any));
const updatesOf = (table: string) => __mock.chainsFor(table).flatMap((c) => opsOf(c, 'update').map((a) => a[0] as any));
/** The last query against a table (the one the operation under test made, after any schema probe). */
const lastChain = (table: string) => { const c = __mock.chainsFor(table); return c[c.length - 1]; };

/** A table that does not exist yet: every query errors. */
const noTable = () => __mock.setDefault('crm_target_entries', { data: null, error: { message: 'relation "crm_target_entries" does not exist' } });

const at = (iso: string) => Date.parse(iso);
// 23:30 IST on 31 Jan, and 00:30 IST on 1 Feb — the same UTC calendar day.
const JAN31_2330_IST = at('2026-01-31T18:00:00Z');
const FEB01_0030_IST = at('2026-01-31T19:00:00Z');

beforeEach(() => { __mock.reset(); te._resetTargetEntriesProbe(); });

// ── config ───────────────────────────────────────────────────────────────────
describe('config.targets in the settings schema', () => {
  const ok = (targets: unknown) => v.settingsUpdateSchema.safeParse({ config: { targets } });
  it('accepts sales, collection, both, labels, and an empty / absent block', () => {
    expect(ok({ types: [{ key: 'sales' }, { key: 'collection' }] }).success).toBe(true);
    expect(ok({ types: [{ key: 'sales', label: 'Order target' }] }).success).toBe(true);
    expect(ok({ types: [] }).success).toBe(true);
    expect(ok({}).success).toBe(true);
    expect(ok(null).success).toBe(true);                                  // null clears it
    expect(v.settingsUpdateSchema.safeParse({ config: { field_overrides: {} } }).success).toBe(true);
  });
  it('rejects an unknown type, a duplicate, more than two, and unknown keys (.strict())', () => {
    expect(ok({ types: [{ key: 'leads' }] }).success).toBe(false);
    expect(ok({ types: [{ key: 'sales' }, { key: 'sales' }] }).success).toBe(false);
    expect(ok({ types: [{ key: 'sales' }, { key: 'collection' }, { key: 'sales' }] }).success).toBe(false);
    expect(ok({ types: [{ key: 'sales', colour: 'red' }] }).success).toBe(false);
    expect(ok({ types: [], extra: 1 }).success).toBe(false);
    expect(ok({ types: 'sales' }).success).toBe(false);
    expect(ok('sales').success).toBe(false);
  });
  it('limits a label to 1..40 characters', () => {
    expect(ok({ types: [{ key: 'sales', label: 'x'.repeat(40) }] }).success).toBe(true);
    expect(ok({ types: [{ key: 'sales', label: 'x'.repeat(41) }] }).success).toBe(false);
    expect(ok({ types: [{ key: 'sales', label: '   ' }] }).success).toBe(false);
  });
  it('reports a problem against targets, and still validates lead_form beside it', () => {
    const r = ok({ types: [{ key: 'nope' }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path.slice(0, 2)).toEqual(['config', 'targets']);
    const both = v.settingsUpdateSchema.safeParse({ config: { targets: { types: [] }, lead_form: { nonsense: true } } });
    expect(both.success).toBe(false);
    if (!both.success) expect(both.error.issues[0].path.slice(0, 2)).toEqual(['config', 'lead_form']);
  });
});

describe('target types', () => {
  it('default their labels, and carry the metric, period and unit', () => {
    expect(te.normalizeTargetTypes(BOTH.targets)).toEqual([
      { key: 'sales', label: 'Sales target', metric: 'sales_amount', period: 'monthly', unit: 'INR' },
      { key: 'collection', label: 'Collection target', metric: 'collection_amount', period: 'monthly', unit: 'INR' },
    ]);
  });
  it('use the configured label (trimmed, cut at 40), and fall back when it is unusable', () => {
    const t = te.normalizeTargetTypes({ types: [{ key: 'sales', label: '  Order target ' }, { key: 'collection', label: 'y'.repeat(50) }] });
    expect(t[0].label).toBe('Order target');
    expect(t[1].label).toHaveLength(40);
    expect(te.normalizeTargetTypes({ types: [{ key: 'sales', label: '  ' }] })[0].label).toBe('Sales target');
    expect(te.normalizeTargetTypes({ types: [{ key: 'sales', label: 5 }] })[0].label).toBe('Sales target');
  });
  it('drop unknown keys and repeats, and are empty for anything that is not a list', () => {
    expect(te.normalizeTargetTypes({ types: [{ key: 'bogus' }, { key: 'sales' }, { key: 'sales', label: 'again' }, null, 'sales'] }).map((t) => t.key)).toEqual(['sales']);
    for (const bad of [undefined, null, {}, { types: {} }, { types: 'sales' }, 'x', 5, []]) expect(te.normalizeTargetTypes(bad)).toEqual([]);
  });
});

// ── gating by enabled type ───────────────────────────────────────────────────
describe('GET /crm/targets/types', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  const get = (u: object = rep) => request(app).get('/crm/targets/types').set('x-test-user', JSON.stringify(u));

  it('lists the enabled types with metric / period / unit', async () => {
    settings({ [CLIENT]: { targets: { types: [{ key: 'sales', label: 'Order target' }, { key: 'collection' }] } } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { types: [
      { key: 'sales', label: 'Order target', metric: 'sales_amount', period: 'monthly', unit: 'INR' },
      { key: 'collection', label: 'Collection target', metric: 'collection_amount', period: 'monthly', unit: 'INR' },
    ] } });
  });
  it('is [] when the client has not configured targets (and for any config that is not a list of types)', async () => {
    for (const cfg of [null, {}, { targets: {} }, { targets: { types: [] } }, { lead_form: { segment_labels: { b2b: 'Dealer' } } }]) {
      __mock.reset(); settings({ [CLIENT]: cfg });
      expect({ cfg, body: (await get()).body }).toEqual({ cfg, body: { success: true, data: { types: [] } } });
    }
  });
  it('reads the client\'s own settings row, else the org-level default, never another client\'s', async () => {
    settings({ [CLIENT]: null, [OTHER_CLIENT]: BOTH }, SALES_ONLY);
    expect((await get()).body.data.types.map((t: any) => t.key)).toEqual(['sales']);          // org default
    __mock.reset();
    settings({ [CLIENT]: { targets: { types: [{ key: 'collection' }] } }, [OTHER_CLIENT]: BOTH }, SALES_ONLY);
    expect((await get()).body.data.types.map((t: any) => t.key)).toEqual(['collection']);     // own row wins
    __mock.reset();
    settings({ [OTHER_CLIENT]: BOTH });
    expect((await get()).body.data.types).toEqual([]);
  });
});

describe('resolveTargetType', () => {
  beforeEach(() => settings({ [CLIENT]: SALES_ONLY }));
  it('is undefined (and reads nothing) when no type is asked for', async () => {
    for (const none of [undefined, null, '']) expect(await te.resolveTargetType(ORG, CLIENT, none)).toBeUndefined();
    expect(__mock.chains).toHaveLength(0);
  });
  it('gives the spec of an enabled type', async () => {
    const r = await te.resolveTargetType(ORG, CLIENT, 'sales');
    expect(r?.spec).toEqual({ metric: 'sales_amount', period: 'monthly' });
    expect(r?.type.label).toBe('Order target');
  });
  it('refuses a type the client has not enabled, an unknown one, and anything odd, with TARGET_TYPE_NOT_ENABLED', async () => {
    for (const bad of ['collection', 'leads', 'SALES', ['sales'], 5, {}]) {
      await expect(te.resolveTargetType(ORG, CLIENT, bad)).rejects.toMatchObject({ statusCode: 400, code: 'TARGET_TYPE_NOT_ENABLED' });
    }
  });
});

// ── the admin endpoints, with a type ─────────────────────────────────────────
describe('/crm/targets admin endpoints with a type', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  const as = (u: object) => ({ 'x-test-user': JSON.stringify(u) });
  const code = (res: request.Response) => res.body?.error?.code;
  beforeEach(() => { settings({ [CLIENT]: BOTH }); __mock.setDefault('crm_targets', { data: [] }); });

  it('GET / lists the monthly rupee rows for that type, in the same shape', async () => {
    __mock.setDefault('crm_targets', { data: [trow({ target_value: 500000 }), trow({ user_id: REP, target_value: 90000 }), trow({ org_role_id: ROLE, target_value: 200000 })] });
    const res = await request(app).get('/crm/targets?type=sales').set(as(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ default_target: 500000, per_level: [{ hierarchy_level_id: ROLE, target_value: 200000 }], per_user: [{ user_id: REP, target_value: 90000 }] });
    expect(lastChain('crm_targets').eqs).toMatchObject({ org_id: ORG, metric: 'sales_amount', period: 'monthly', client_id: CLIENT });
    await request(app).get('/crm/targets?type=collection').set(as(admin));
    expect(lastChain('crm_targets').eqs.metric).toBe('collection_amount');
  });

  it('every admin endpoint answers 400 TARGET_TYPE_NOT_ENABLED for a type the client has not enabled', async () => {
    __mock.reset(); settings({ [CLIENT]: SALES_ONLY });
    const reqs = [
      request(app).get('/crm/targets?type=collection').set(as(admin)),
      request(app).get('/crm/targets/levels?type=collection').set(as(admin)),
      request(app).get('/crm/targets/leaderboard?type=collection').set(as(rep)),
      request(app).get('/crm/targets/leaderboard-role?type=collection').set(as(admin)),
      request(app).put('/crm/targets').set(as(admin)).send({ type: 'collection', all: true, target_value: 5 }),
      request(app).get('/crm/targets?type=bogus').set(as(admin)),
    ];
    for (const res of await Promise.all(reqs)) expect({ status: res.status, code: code(res) }).toEqual({ status: 400, code: 'TARGET_TYPE_NOT_ENABLED' });
    expect(insertsOf('crm_targets')).toHaveLength(0);
  });

  it('and for a client that configured nothing', async () => {
    __mock.reset(); settings({ [CLIENT]: {} });
    for (const res of [await request(app).get('/crm/targets?type=sales').set(as(admin)), await request(app).put('/crm/targets').set(as(admin)).send({ type: 'sales', all: true, target_value: 5 })]) {
      expect({ status: res.status, code: code(res) }).toEqual({ status: 400, code: 'TARGET_TYPE_NOT_ENABLED' });
    }
  });

  it('GET /levels?type= still returns the org roles (they are shared across target types)', async () => {
    __mock.setDefault('org_roles', { data: [{ id: ROLE, name: 'Dealer Rep' }] });
    const res = await request(app).get('/crm/targets/levels?type=sales').set(as(admin));
    expect(res.body).toEqual({ success: true, data: [{ id: ROLE, name: 'Dealer Rep' }] });
  });

  describe('PUT /', () => {
    const put = (body: object, u: object = admin) => request(app).put('/crm/targets').set(as(u)).send(body);
    const newRow = () => { __mock.queue('crm_targets', { data: [] }); __mock.setDefault('crm_targets', { data: [{ id: 'new' }] }); };

    it('stores a monthly rupee row with the type\'s metric, flooring to whole rupees', async () => {
      newRow();
      const res = await put({ type: 'sales', user_id: REP, target_value: 250000.9 });
      expect(res.status).toBe(200);
      expect(insertsOf('crm_targets')[0]).toEqual({
        org_id: ORG, client_id: CLIENT, user_id: REP, org_role_id: null, hierarchy_level_id: null,
        metric: 'sales_amount', period: 'monthly', target_value: 250000, created_by: ADMIN,
      });
      expect(__mock.chainsFor('crm_targets')[0].eqs).toMatchObject({ metric: 'sales_amount', period: 'monthly', user_id: REP });
    });
    it('sets the collection default with all:true, and a role target from hierarchy_level_id', async () => {
      newRow();
      await put({ type: 'collection', all: true, target_value: 1000000 });
      expect(insertsOf('crm_targets')[0]).toMatchObject({ metric: 'collection_amount', period: 'monthly', user_id: null, org_role_id: null, target_value: 1000000 });
      __mock.reset(); settings({ [CLIENT]: BOTH }); newRow();
      await put({ type: 'sales', hierarchy_level_id: ROLE, target_value: 70000 });
      expect(insertsOf('crm_targets')[0]).toMatchObject({ metric: 'sales_amount', org_role_id: ROLE, target_value: 70000 });
    });
    it('updates the existing row for that metric in place', async () => {
      __mock.setDefault('crm_targets', { data: [{ id: 'existing' }] });
      await put({ type: 'sales', all: true, target_value: 5 });
      expect(updatesOf('crm_targets')[0]).toMatchObject({ target_value: 5 });
      expect(insertsOf('crm_targets')).toHaveLength(0);
    });
    it('accepts 0 and exactly 1,000,000,000, and a numeric string', async () => {
      for (const [sent, stored] of [[0, 0], [1_000_000_000, 1_000_000_000], ['1500.7', 1500]] as const) {
        __mock.reset(); settings({ [CLIENT]: BOTH }); newRow();
        const res = await put({ type: 'sales', all: true, target_value: sent });
        expect({ sent, status: res.status }).toEqual({ sent, status: 200 });
        expect(insertsOf('crm_targets')[0].target_value).toBe(stored);
      }
    });
    it('refuses a negative, an over-limit, a non-number and a blank value with 400 VALIDATION, writing nothing', async () => {
      for (const bad of [-1, -0.5, 1_000_000_001, 1e12, 'abc', '', '  ', true, [5], { a: 1 }, Infinity]) {
        __mock.reset(); settings({ [CLIENT]: BOTH }); newRow();
        const res = await put({ type: 'sales', all: true, target_value: bad as any });
        expect({ bad: JSON.stringify(bad), status: res.status }).toEqual({ bad: JSON.stringify(bad), status: 400 });
        expect(insertsOf('crm_targets')).toHaveLength(0);
        expect(updatesOf('crm_targets')).toHaveLength(0);
      }
    });
    it('still requires target_value', async () => {
      const res = await put({ type: 'sales', all: true });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/target_value is required/);
    });
    it('validates the ids it is scoped to', async () => {
      for (const body of [{ user_id: 'not-a-uuid' }, { org_role_id: '1;drop' }, { hierarchy_level_id: 5 }]) {
        const res = await put({ type: 'sales', target_value: 5, ...body });
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
      expect(insertsOf('crm_targets')).toHaveLength(0);
    });
    it('keeps the existing guards: managers only, and not a frontline champion', async () => {
      expect((await put({ type: 'sales', all: true, target_value: 5 }, rep)).status).toBe(403);
      expect((await put({ type: 'sales', all: true, target_value: 5 }, { ...admin, org_role_name: 'Consumer Champion', org_role_data_scope: 'own' })).status).toBe(403);
      expect(insertsOf('crm_targets')).toHaveLength(0);
    });
  });

  describe('GET /leaderboard?type=', () => {
    const Dealer = { id: REP, name: 'Asha', email: null, city: null, org_role_id: ROLE, hierarchy_level_id: null, role: 'executive', client_id: CLIENT, org_id: ORG };
    const Dealer2 = { id: REP2, name: 'Bala', email: null, city: null, org_role_id: ROLE, hierarchy_level_id: null, role: 'executive', client_id: CLIENT, org_id: ORG };
    const NoRole = { id: ADMIN, name: 'Admin', email: null, city: null, org_role_id: null, hierarchy_level_id: null, role: 'admin', client_id: CLIENT, org_id: ORG };
    beforeEach(() => {
      __mock.setDefault('users', fakeTable([Dealer, Dealer2, NoRole]));
      __mock.setDefault('org_roles', { data: [{ id: ROLE, name: 'Dealer Rep' }] });
      __mock.setDefault('crm_targets', fakeTable([trow({ target_value: 100000 }), trow({ user_id: REP2, target_value: 40000 }), trow({ metric: 'collection_amount', target_value: 7 })]));
    });

    it('is the rupee board for the current month: rows { user_id, name, role, target, achieved, pct }', async () => {
      const month = te.istMonth();
      __mock.setDefault('crm_target_entries', fakeTable([
        entry({ id: 'a', user_id: REP, amount: 30000.5, entry_date: month.start }),
        entry({ id: 'b', user_id: REP, amount: 19999.5, entry_date: month.end }),
        entry({ id: 'c', user_id: REP2, amount: 40000, entry_date: month.start }),
        entry({ id: 'd', user_id: REP, kind: 'collection', amount: 999999, entry_date: month.start }),     // other type
        entry({ id: 'e', user_id: REP, amount: 777, entry_date: month.start, deleted_at: '2026-01-02T00:00:00Z' }), // deleted
        entry({ id: 'f', user_id: REP, amount: 555, entry_date: te.addDays(month.start, -1) }),            // last month
        entry({ id: 'g', user_id: REP, amount: 444, entry_date: month.start, client_id: OTHER_CLIENT }),   // other client
      ]));
      const res = await request(app).get('/crm/targets/leaderboard?type=sales').set(as(admin));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d).toMatchObject({ type: 'sales', label: 'Sales target', metric: 'sales_amount', period: 'monthly', period_start: month.start, period_end: month.end });
      // best first. The client default (100000) applies to everyone without their own target, so the
      // role-less admin is on the board too (as on the lead board, anyone with a target is kept).
      expect(d.entries).toEqual([
        { user_id: REP, name: 'Asha', role: 'Dealer Rep', target: 100000, achieved: 50000, pct: 50 },
        { user_id: REP2, name: 'Bala', role: 'Dealer Rep', target: 40000, achieved: 40000, pct: 100 },
        { user_id: ADMIN, name: 'Admin', role: 'admin', target: 100000, achieved: 0, pct: 0 },
      ]);
      expect(d.stats).toMatchObject({ participants: 3, total_target: 240000, total_achieved: 90000, meeting_target: 1, target_participants: 3,
        top_performer: { name: 'Asha', achieved: 50000 }, lowest_performer: { name: 'Admin', achieved: 0 } });
      // the board is bounded to this client and this month
      const q = lastChain('crm_target_entries');
      expect(q.eqs).toMatchObject({ org_id: ORG, client_id: CLIENT });
      expect(opsOf(q, 'gte')).toContainEqual(['entry_date', month.start]);
      expect(opsOf(q, 'lte')).toContainEqual(['entry_date', month.end]);
      expect(opsOf(q, 'in')).toContainEqual(['kind', ['sales']]);
    });

    it('gives null target / pct to someone with no target, and drops a no-role, no-target, no-entries user', async () => {
      __mock.setDefault('crm_targets', fakeTable([trow({ user_id: REP, target_value: 100 })]));
      __mock.setDefault('crm_target_entries', fakeTable([entry({ user_id: REP2, amount: 12, entry_date: te.istMonth().start })]));
      const rows = (await request(app).get('/crm/targets/leaderboard?type=sales').set(as(admin))).body.data.entries;
      expect(rows.map((r: any) => r.user_id)).toEqual([REP2, REP]);                   // Admin (no role / target / entries) is gone
      expect(rows[0]).toMatchObject({ user_id: REP2, target: null, achieved: 12, pct: null });
      expect(rows[1]).toMatchObject({ user_id: REP, target: 100, achieved: 0, pct: 0 });
    });

    it('is a board of zeros before the migration', async () => {
      noTable();
      const res = await request(app).get('/crm/targets/leaderboard?type=sales').set(as(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.entries.every((r: any) => r.achieved === 0)).toBe(true);
    });

    it('pins a non-manager viewer to their own role, like the lead board', async () => {
      __mock.setDefault('crm_target_entries', fakeTable([]));
      await request(app).get('/crm/targets/leaderboard?type=sales').set(as(rep));
      expect(__mock.chainsFor('users')[0].eqs).toMatchObject({ org_role_id: ROLE, client_id: CLIENT });
    });
  });
});

// ── progress ─────────────────────────────────────────────────────────────────
describe('target resolution', () => {
  const rows = [
    trow({ client_id: null, target_value: 1 }),                       // org-wide default
    trow({ target_value: 2 }),                                        // client default
    trow({ hierarchy_level_id: LEVEL, target_value: 3 }),
    trow({ org_role_id: ROLE, target_value: 4 }),
    trow({ user_id: REP, target_value: 5 }),
  ];
  const who = { user_id: REP, org_role_id: ROLE, hierarchy_level_id: LEVEL };
  it('goes user > role > level > default', () => {
    expect(te.resolveTarget(rows, who, CLIENT)).toEqual({ target: 5, source: 'user' });
    expect(te.resolveTarget(rows.slice(0, 4), who, CLIENT)).toEqual({ target: 4, source: 'role' });
    expect(te.resolveTarget(rows.slice(0, 3), who, CLIENT)).toEqual({ target: 3, source: 'level' });
    expect(te.resolveTarget(rows.slice(0, 2), who, CLIENT)).toEqual({ target: 2, source: 'default' });
  });
  it('lets the client\'s own row beat an org-wide one of the same scope, and ignores another client\'s', () => {
    expect(te.resolveTarget([trow({ client_id: null, target_value: 9 }), trow({ client_id: CLIENT, target_value: 6 })], who, CLIENT).target).toBe(6);
    expect(te.resolveTarget([trow({ client_id: CLIENT, target_value: 6 }), trow({ client_id: null, target_value: 9 })], who, CLIENT).target).toBe(6);
    expect(te.resolveTarget([trow({ client_id: OTHER_CLIENT, target_value: 9 })], who, CLIENT)).toEqual({ target: null, source: null });
  });
  it('only the org-wide rows apply when no client is in scope', () => {
    expect(te.resolveTarget(rows, who, null)).toEqual({ target: 1, source: 'default' });
  });
  it('is nobody else\'s person / role / level', () => {
    expect(te.resolveTarget([trow({ user_id: REP2, target_value: 8 }), trow({ org_role_id: LEVEL, target_value: 8 })], who, CLIENT)).toEqual({ target: null, source: null });
  });
  it('has no target when nothing applies, and a winning 0 clears the target for that person', () => {
    expect(te.resolveTarget([], who, CLIENT)).toEqual({ target: null, source: null });
    expect(te.resolveTarget([trow({ org_role_id: ROLE, target_value: 4 }), trow({ user_id: REP, target_value: 0 })], who, CLIENT)).toEqual({ target: null, source: null });
  });
  it('reads a numeric-string target (numeric columns can come back as text)', () => {
    expect(te.resolveTarget([trow({ target_value: '250000' })], who, CLIENT).target).toBe(250000);
  });
});

describe('the IST calendar', () => {
  it('rolls the day over at 00:00 IST (18:30 UTC), not at UTC midnight', () => {
    expect(te.istDate(at('2026-01-31T18:29:59.999Z'))).toBe('2026-01-31');   // 23:59:59.999 IST
    expect(te.istDate(at('2026-01-31T18:30:00.000Z'))).toBe('2026-02-01');   // 00:00 IST
    expect(te.istDate(JAN31_2330_IST)).toBe('2026-01-31');
    expect(te.istDate(FEB01_0030_IST)).toBe('2026-02-01');                   // still 31 Jan in UTC
    expect(te.istDate(at('2026-02-01T00:10:00Z'))).toBe('2026-02-01');
  });
  it('spans the whole calendar month', () => {
    expect(te.istMonth(JAN31_2330_IST)).toEqual({ start: '2026-01-01', end: '2026-01-31' });
    expect(te.istMonth(FEB01_0030_IST)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(te.istMonth(at('2028-02-10T06:00:00Z'))).toEqual({ start: '2028-02-01', end: '2028-02-29' });   // leap year
    expect(te.istMonth(at('2026-04-30T19:00:00Z'))).toEqual({ start: '2026-05-01', end: '2026-05-31' });
    expect(te.istMonth(at('2026-12-31T20:00:00Z'))).toEqual({ start: '2027-01-01', end: '2027-01-31' });   // year end
    expect(te.istMonth(at('2026-12-15T06:00:00Z'))).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
  it('adds days across month ends', () => {
    expect(te.addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(te.addDays('2026-02-01', -31)).toBe('2026-01-01');
    expect(te.addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('knows a real date from 2026-02-31', () => {
    expect(te.isRealDate('2026-02-28')).toBe(true);
    expect(te.isRealDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '26-01-01', '2026-1-1', '']) expect(te.isRealDate(bad)).toBe(false);
  });
});

describe('progress', () => {
  const entries = [
    entry({ id: '1', amount: 1000, entry_date: '2026-01-31' }),
    entry({ id: '2', amount: 500, entry_date: '2026-02-01' }),
    entry({ id: '3', amount: 250, entry_date: '2026-01-10' }),
    entry({ id: '4', amount: 7, kind: 'collection', entry_date: '2026-01-10' }),
    entry({ id: '5', amount: 99, entry_date: '2026-01-10', deleted_at: '2026-01-11T00:00:00Z' }),
    entry({ id: '6', amount: 88, entry_date: '2026-01-10', user_id: REP2 }),
  ];
  const arrange = (cfg: unknown = BOTH, targetRows: any[] = [trow({ org_role_id: ROLE, target_value: 2000 })]) => {
    settings({ [CLIENT]: cfg });
    __mock.setDefault('users', { data: [{ org_role_id: ROLE, hierarchy_level_id: null }] });
    __mock.setDefault('crm_targets', fakeTable(targetRows));
    __mock.setDefault('crm_target_entries', fakeTable(entries));
  };
  const progress = (now: number) => te.myProgress(actorOf(rep), now);

  it('is the caller\'s running total of non-deleted entries of each kind this month, against the resolved target', async () => {
    arrange();
    const p = await progress(at('2026-01-20T06:00:00Z'));
    expect(p).toEqual({
      period_start: '2026-01-01', period_end: '2026-01-31',
      types: [
        { key: 'sales', label: 'Sales target', target: 2000, achieved: 1250, pct: 63, source: 'role' },
        { key: 'collection', label: 'Collection target', target: null, achieved: 7, pct: null, source: null },
      ],
    });
  });

  it('counts an entry on the last evening of the month (23:30 IST on the 31st) to that month, and not to the next', async () => {
    arrange();
    const jan = await progress(JAN31_2330_IST);
    expect([jan.period_start, jan.period_end]).toEqual(['2026-01-01', '2026-01-31']);
    expect(jan.types[0].achieved).toBe(1250);                            // 31 Jan (1000) + 10 Jan (250); the 1 Feb entry is not here yet
  });
  it('and starts a fresh month at 00:30 IST on the 1st, although UTC is still the 31st', async () => {
    arrange();
    const feb = await progress(FEB01_0030_IST);
    expect([feb.period_start, feb.period_end]).toEqual(['2026-02-01', '2026-02-28']);
    expect(feb.types[0].achieved).toBe(500);                             // only the 1 Feb entry
    expect(feb.types[1].achieved).toBe(0);
  });
  it('queries the caller\'s own entries, in this client, between the first and last day of the IST month', async () => {
    arrange();
    await progress(FEB01_0030_IST);
    const q = lastChain('crm_target_entries');
    expect(q.eqs).toMatchObject({ org_id: ORG, client_id: CLIENT, user_id: REP });
    expect(opsOf(q, 'gte')).toContainEqual(['entry_date', '2026-02-01']);
    expect(opsOf(q, 'lte')).toContainEqual(['entry_date', '2026-02-28']);
    expect(opsOf(q, 'is')).toContainEqual(['deleted_at', null]);
    expect(q.ops.some((o) => o.method === 'range')).toBe(true);          // not capped at 1000 rows
  });

  it('rounds the percentage, and may exceed 100', async () => {
    arrange(BOTH, [trow({ target_value: 3 })]);
    expect((await progress(JAN31_2330_IST)).types[0]).toMatchObject({ target: 3, achieved: 1250, pct: 41667, source: 'default' });
    __mock.reset(); te._resetTargetEntriesProbe();
    arrange(BOTH, [trow({ target_value: 3000 })]);
    expect((await progress(JAN31_2330_IST)).types[0].pct).toBe(42);      // 1250 / 3000 = 41.67
  });
  it('adds paise exactly (0.1 + 0.2)', async () => {
    arrange();
    __mock.setDefault('crm_target_entries', fakeTable([entry({ amount: '0.10', entry_date: '2026-01-05' }), entry({ id: 'x', amount: 0.2, entry_date: '2026-01-06' })]));
    expect((await progress(JAN31_2330_IST)).types[0].achieved).toBe(0.3);
  });
  it('follows the resolution order through the real rows (user over role over default)', async () => {
    arrange(BOTH, [trow({ target_value: 1 }), trow({ org_role_id: ROLE, target_value: 2 }), trow({ user_id: REP, target_value: 3 })]);
    expect((await progress(JAN31_2330_IST)).types[0]).toMatchObject({ target: 3, source: 'user' });
    expect(lastChain('crm_targets').ops.find((o) => o.method === 'in')?.args).toEqual(['metric', ['sales_amount', 'collection_amount']]);
    expect(lastChain('crm_targets').eqs).toMatchObject({ org_id: ORG, period: 'monthly' });
  });
  it('only reports the enabled types', async () => {
    arrange(SALES_ONLY);
    const p = await progress(JAN31_2330_IST);
    expect(p.types.map((t) => t.key)).toEqual(['sales']);
    expect(p.types[0].label).toBe('Order target');
  });
  it('is just the period with no types when the client has no targets config, and reads no targets or entries', async () => {
    for (const cfg of [null, {}, { targets: { types: [] } }]) {
      __mock.reset(); te._resetTargetEntriesProbe(); arrange(cfg);
      expect(await progress(JAN31_2330_IST)).toEqual({ period_start: '2026-01-01', period_end: '2026-01-31', types: [] });
      expect(__mock.chainsFor('crm_targets')).toHaveLength(0);
      expect(__mock.chainsFor('crm_target_entries')).toHaveLength(0);
    }
  });
  it('before the migration: achieved 0 (the target is still shown), no error', async () => {
    arrange();
    noTable();
    const p = await progress(JAN31_2330_IST);
    expect(p.types[0]).toMatchObject({ target: 2000, achieved: 0, pct: 0 });
    expect(__mock.chainsFor('crm_target_entries')).toHaveLength(1);       // only the schema probe
  });

  describe('GET /crm/targets/progress', () => {
    const app = express();
    app.use(express.json());
    app.use('/crm', crmRouter);
    it('is open to any CRM user and answers { success, data }', async () => {
      arrange();
      const res = await request(app).get('/crm/targets/progress').set('x-test-user', JSON.stringify(rep));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.period_start).toMatch(/^\d{4}-\d{2}-01$/);
      expect(res.body.data.period_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.body.data.types.map((t: any) => t.key)).toEqual(['sales', 'collection']);
      expect(Object.keys(res.body.data.types[0]).sort()).toEqual(['achieved', 'key', 'label', 'pct', 'source', 'target']);
    });
    it('is empty, not an error, for a client with no config', async () => {
      arrange({});
      const res = await request(app).get('/crm/targets/progress').set('x-test-user', JSON.stringify(rep));
      expect(res.status).toBe(200);
      expect(res.body.data.types).toEqual([]);
    });
  });
});

// ── entries: logging ─────────────────────────────────────────────────────────
describe('logging an entry', () => {
  const arrange = (cfg: unknown = BOTH, extra: { leads?: any[] } = {}) => {
    settings({ [CLIENT]: cfg });
    __mock.setDefault('crm_target_entries', fakeTable([]));
    __mock.setDefault('crm_leads', fakeTable(extra.leads ?? [{ id: LEAD, org_id: ORG, client_id: CLIENT, deleted_at: null, first_name: 'Ramesh', last_name: 'Sharma', company: 'Sharma Agro' }]));
    __mock.setDefault('users', fakeTable([{ id: REP, name: 'Asha' }]));
  };
  const log = (input: any, now = at('2026-01-20T06:00:00Z'), u: any = rep) => te.createEntry(actorOf(u), input, now);

  it('stores the caller\'s entry and answers in the list shape', async () => {
    arrange();
    const e = await log({ kind: 'sales', amount: 12500.5, lead_id: LEAD, note: '  First order  ' });
    expect(insertsOf('crm_target_entries')[0]).toEqual({
      org_id: ORG, client_id: CLIENT, user_id: REP, kind: 'sales', amount: 12500.5, entry_date: '2026-01-20', lead_id: LEAD, note: 'First order', created_by: REP,
    });
    expect(e).toEqual({
      id: 'new-id', kind: 'sales', amount: 12500.5, entry_date: '2026-01-20', lead_id: LEAD, lead_name: 'Ramesh Sharma',
      note: 'First order', user_id: REP, user_name: 'Asha', created_at: '2026-01-15T10:00:00.000Z',
    });
  });
  it('needs no lead and no note', async () => {
    arrange();
    const e = await log({ kind: 'collection', amount: 100 });
    expect(insertsOf('crm_target_entries')[0]).toMatchObject({ lead_id: null, note: null, kind: 'collection' });
    expect(e).toMatchObject({ lead_id: null, lead_name: null, note: null });
  });
  it('defaults the date to today in IST — not the UTC day', async () => {
    arrange();
    await log({ kind: 'sales', amount: 1 }, JAN31_2330_IST);
    await log({ kind: 'sales', amount: 1 }, FEB01_0030_IST);
    expect(insertsOf('crm_target_entries').map((r) => r.entry_date)).toEqual(['2026-01-31', '2026-02-01']);
  });

  it('only for an enabled type: 400 TARGET_TYPE_NOT_ENABLED, nothing stored', async () => {
    arrange(SALES_ONLY);
    await expect(log({ kind: 'collection', amount: 5 })).rejects.toMatchObject({ statusCode: 400, code: 'TARGET_TYPE_NOT_ENABLED' });
    __mock.reset(); te._resetTargetEntriesProbe(); arrange({});
    await expect(log({ kind: 'sales', amount: 5 })).rejects.toMatchObject({ statusCode: 400, code: 'TARGET_TYPE_NOT_ENABLED' });
    expect(insertsOf('crm_target_entries')).toHaveLength(0);
  });

  describe('the date window', () => {
    const today = '2026-02-01';
    beforeEach(arrange as () => void);
    it('allows today and up to 31 days back, not tomorrow and not 32 days back', async () => {
      for (const date of [today, '2026-01-31', '2026-01-01']) {
        await expect(log({ kind: 'sales', amount: 1, entry_date: date }, FEB01_0030_IST)).resolves.toMatchObject({ entry_date: date });
      }
      for (const date of ['2026-02-02', '2025-12-31', '2026-03-01']) {
        await expect(log({ kind: 'sales', amount: 1, entry_date: date }, FEB01_0030_IST)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
      }
    });
    it('measures "today" in IST: at 23:30 IST on 31 Jan, 1 Feb is the future; at 00:30 IST it is today', async () => {
      await expect(log({ kind: 'sales', amount: 1, entry_date: '2026-02-01' }, JAN31_2330_IST)).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(log({ kind: 'sales', amount: 1, entry_date: '2026-02-01' }, FEB01_0030_IST)).resolves.toBeDefined();
    });
  });

  it('the lead must exist in the same org AND client (and not be deleted)', async () => {
    arrange();
    await log({ kind: 'sales', amount: 1, lead_id: LEAD });
    const lookup = __mock.chainsFor('crm_leads')[0];
    expect(lookup.eqs).toMatchObject({ id: LEAD, org_id: ORG, client_id: CLIENT });
    expect(opsOf(lookup, 'is')).toContainEqual(['deleted_at', null]);
    for (const lead of [{ client_id: OTHER_CLIENT }, { org_id: '99999999-0000-0000-0000-000000000000' }, { deleted_at: '2026-01-01T00:00:00Z' }]) {
      __mock.reset(); te._resetTargetEntriesProbe();
      arrange(BOTH, { leads: [{ id: LEAD, org_id: ORG, client_id: CLIENT, deleted_at: null, ...lead }] });
      await expect(log({ kind: 'sales', amount: 1, lead_id: LEAD })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
      expect(insertsOf('crm_target_entries')).toHaveLength(0);
    }
  });

  it('before the migration: 409 TARGET_ENTRIES_NOT_ENABLED and nothing is attempted', async () => {
    arrange();
    noTable();
    await expect(log({ kind: 'sales', amount: 1 })).rejects.toMatchObject({ statusCode: 409, code: 'TARGET_ENTRIES_NOT_ENABLED' });
    expect(insertsOf('crm_target_entries')).toHaveLength(0);
  });
  it('rechecks soon after a negative probe, so applying the migration takes effect without a restart', async () => {
    arrange();
    noTable();
    await expect(log({ kind: 'sales', amount: 1 })).rejects.toMatchObject({ code: 'TARGET_ENTRIES_NOT_ENABLED' });
    __mock.setDefault('crm_target_entries', fakeTable([]));
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try { await expect(log({ kind: 'sales', amount: 1 })).resolves.toBeDefined(); } finally { spy.mockRestore(); }
  });
});

describe('POST /crm/targets/entries', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  const post = (body: object, u: object = rep) => request(app).post('/crm/targets/entries').set('x-test-user', JSON.stringify(u)).send(body);
  beforeEach(() => {
    settings({ [CLIENT]: BOTH });
    __mock.setDefault('crm_target_entries', fakeTable([]));
    __mock.setDefault('crm_leads', fakeTable([{ id: LEAD, org_id: ORG, client_id: CLIENT, deleted_at: null, first_name: 'Ramesh', last_name: null, company: 'Sharma Agro' }]));
    __mock.setDefault('users', fakeTable([{ id: REP, name: 'Asha' }]));
  });
  const today = () => te.istDate();

  it('answers 201 { success, data } for the caller, ignoring any user_id in the body', async () => {
    const res = await post({ kind: 'sales', amount: 5000, lead_id: LEAD, note: 'x', user_id: REP2 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ kind: 'sales', amount: 5000, entry_date: today(), lead_id: LEAD, lead_name: 'Ramesh', note: 'x', user_id: REP });
    expect(insertsOf('crm_target_entries')[0]).toMatchObject({ user_id: REP, created_by: REP, client_id: CLIENT });
  });
  it('rounds the amount to 2 decimals', async () => {
    expect((await post({ kind: 'sales', amount: 100.456 })).body.data.amount).toBe(100.46);
    expect((await post({ kind: 'sales', amount: 0.01 })).body.data.amount).toBe(0.01);
  });
  it('validates every field, with 400 VALIDATION and nothing stored', async () => {
    const bad: Array<[string, object]> = [
      ['no kind', { amount: 5 }],
      ['unknown kind', { kind: 'leads', amount: 5 }],
      ['no amount', { kind: 'sales' }],
      ['zero', { kind: 'sales', amount: 0 }],
      ['negative', { kind: 'sales', amount: -5 }],
      ['rounds to zero', { kind: 'sales', amount: 0.004 }],
      ['over the cap', { kind: 'sales', amount: 1_000_000_001 }],
      ['a string amount', { kind: 'sales', amount: '500' }],
      ['null amount', { kind: 'sales', amount: null }],
      ['bad lead id', { kind: 'sales', amount: 5, lead_id: 'nope' }],
      ['injection in lead id', { kind: 'sales', amount: 5, lead_id: `${LEAD},owner_id.eq.x` }],
      ['long note', { kind: 'sales', amount: 5, note: 'n'.repeat(501) }],
      ['non-string note', { kind: 'sales', amount: 5, note: 5 }],
      ['bad date format', { kind: 'sales', amount: 5, entry_date: '05/01/2026' }],
      ['impossible date', { kind: 'sales', amount: 5, entry_date: '2026-02-31' }],
      ['future date', { kind: 'sales', amount: 5, entry_date: '2999-01-01' }],
      ['too old', { kind: 'sales', amount: 5, entry_date: '2000-01-01' }],
    ];
    for (const [label, body] of bad) {
      const res = await post(body);
      expect({ label, status: res.status, code: res.body?.error?.code }).toEqual({ label, status: 400, code: 'VALIDATION' });
    }
    expect(insertsOf('crm_target_entries')).toHaveLength(0);
  });
  it('takes the limits exactly: 1,000,000,000 and a 500-character note', async () => {
    expect((await post({ kind: 'sales', amount: 1_000_000_000, note: 'n'.repeat(500) })).status).toBe(201);
  });
  it('400 TARGET_TYPE_NOT_ENABLED for a type this client has not enabled', async () => {
    __mock.reset(); te._resetTargetEntriesProbe(); settings({ [CLIENT]: SALES_ONLY });
    const res = await post({ kind: 'collection', amount: 5 });
    expect({ status: res.status, code: res.body.error.code }).toEqual({ status: 400, code: 'TARGET_TYPE_NOT_ENABLED' });
  });
  it('409 TARGET_ENTRIES_NOT_ENABLED before the migration', async () => {
    noTable();
    const res = await post({ kind: 'sales', amount: 5 });
    expect({ status: res.status, code: res.body.error.code }).toEqual({ status: 409, code: 'TARGET_ENTRIES_NOT_ENABLED' });
  });
});

// ── entries: reading ─────────────────────────────────────────────────────────
describe('listing entries', () => {
  const all = [
    entry({ id: 'e1', entry_date: '2026-01-10', created_at: '2026-01-10T08:00:00Z', amount: 100 }),
    entry({ id: 'e2', entry_date: '2026-01-12', created_at: '2026-01-12T08:00:00Z', amount: 200, lead_id: LEAD }),
    entry({ id: 'e3', entry_date: '2026-01-12', created_at: '2026-01-12T09:00:00Z', amount: 300, kind: 'collection' }),
    entry({ id: 'e4', entry_date: '2026-01-11', user_id: REP2, amount: 400 }),
    entry({ id: 'e5', entry_date: '2026-01-13', amount: 500, deleted_at: '2026-01-13T10:00:00Z' }),
    entry({ id: 'e6', entry_date: '2026-01-14', amount: 600, client_id: OTHER_CLIENT, user_id: REP2 }),
  ];
  const arrange = (cfg: unknown = BOTH) => {
    settings({ [CLIENT]: cfg });
    __mock.setDefault('crm_target_entries', fakeTable(all));
    __mock.setDefault('crm_leads', fakeTable([{ id: LEAD, first_name: 'Ramesh', last_name: 'Sharma', company: 'Sharma Agro' }]));
    __mock.setDefault('users', fakeTable([{ id: REP, name: 'Asha' }, { id: REP2, name: 'Bala' }]));
  };
  const list = (q: any = {}, u: any = rep) => te.listEntries(actorOf(u), q);
  const ids = (rows: any[]) => rows.map((r) => r.id);

  it('is the caller\'s own, newest first, in the documented shape', async () => {
    arrange();
    const rows = await list();
    expect(ids(rows)).toEqual(['e3', 'e2', 'e1']);                    // date desc, then created_at desc; not deleted, not REP2's, not another client's
    expect(rows[1]).toEqual({
      id: 'e2', kind: 'sales', amount: 200, entry_date: '2026-01-12', lead_id: LEAD, lead_name: 'Ramesh Sharma', note: null,
      user_id: REP, user_name: 'Asha', created_at: '2026-01-12T08:00:00Z',
    });
    expect(rows[0]).toMatchObject({ kind: 'collection', lead_id: null, lead_name: null });
    const q = lastChain('crm_target_entries');
    expect(q.eqs).toMatchObject({ org_id: ORG, client_id: CLIENT, user_id: REP });
    expect(opsOf(q, 'is')).toContainEqual(['deleted_at', null]);
  });
  it('filters by kind and by date range', async () => {
    arrange();
    expect(ids(await list({ kind: 'collection' }))).toEqual(['e3']);
    expect(ids(await list({ from: '2026-01-11', to: '2026-01-12' }))).toEqual(['e3', 'e2']);
    expect(ids(await list({ from: '2026-01-13' }))).toEqual([]);
  });
  it('refuses a range that ends before it starts', async () => {
    arrange();
    await expect(list({ from: '2026-02-01', to: '2026-01-01' })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });
  it('defaults the limit to 50, caps it at 200, and never goes below 1', async () => {
    for (const [asked, used] of [[undefined, 50], [0, 50], [NaN, 50], [-3, 1], [7, 7], [200, 200], [999, 200]] as const) {
      __mock.reset(); te._resetTargetEntriesProbe(); arrange();
      await list({ limit: asked as any });
      expect({ asked, used: opsOf(lastChain('crm_target_entries'), 'limit')[0][0] }).toEqual({ asked, used });
    }
  });
  it('only shows kinds the client has enabled, even for entries logged earlier', async () => {
    arrange(SALES_ONLY);
    expect(ids(await list())).toEqual(['e2', 'e1']);
    expect(await list({ kind: 'collection' })).toEqual([]);          // not enabled: empty, not an error
  });
  it('is [] when the client has no targets config, and reads no entries', async () => {
    arrange({});
    expect(await list()).toEqual([]);
    expect(__mock.chainsFor('crm_target_entries')).toHaveLength(0);
  });
  it('is [] before the migration', async () => {
    arrange();
    noTable();
    expect(await list()).toEqual([]);
  });

  describe('whose entries', () => {
    it('an ordinary user may name themselves, but not anyone else or everyone: 403', async () => {
      arrange();
      expect(ids(await list({ user_id: REP }))).toEqual(['e3', 'e2', 'e1']);
      await expect(list({ user_id: REP2 })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      await expect(list({ all: true })).rejects.toMatchObject({ statusCode: 403 });
      await expect(list({ all: true, user_id: REP2 })).rejects.toMatchObject({ statusCode: 403 });
    });
    it('is refused for roles that are not admin-class, and for an own-scope field exec carrying an admin role', async () => {
      arrange();
      await expect(list({ all: true }, { ...rep, role: 'supervisor' })).rejects.toMatchObject({ statusCode: 403 });
      await expect(list({ all: true }, { ...rep, role: 'sub_admin', org_role_data_scope: 'own' })).rejects.toMatchObject({ statusCode: 403 });
    });
    it('an approver sees everybody in their org and client (all=1), or one person (user_id)', async () => {
      arrange();
      expect(ids(await list({ all: true }, admin))).toEqual(['e3', 'e2', 'e4', 'e1']);       // not the deleted one, not the other client's
      expect(lastChain('crm_target_entries').eqs).toMatchObject({ org_id: ORG, client_id: CLIENT });
      expect(lastChain('crm_target_entries').eqs.user_id).toBeUndefined();
      expect(ids(await list({ user_id: REP2 }, admin))).toEqual(['e4']);
      expect(lastChain('crm_target_entries').eqs.user_id).toBe(REP2);
      expect((await list({ all: true }, admin)).find((r) => r.id === 'e4')?.user_name).toBe('Bala');
    });
    it('an approver is still bounded by their client', async () => {
      arrange();
      const rows = await list({ all: true, user_id: REP2 }, admin);
      expect(ids(rows)).not.toContain('e6');
    });
    it('never puts an id into a raw .or() filter', async () => {
      arrange();
      await list({ user_id: REP2 }, admin);
      expect(lastChain('crm_target_entries').ors).toEqual([]);
    });
  });

  describe('GET /crm/targets/entries', () => {
    const app = express();
    app.use(express.json());
    app.use('/crm', crmRouter);
    const get = (qs: string, u: object = rep) => request(app).get(`/crm/targets/entries${qs}`).set('x-test-user', JSON.stringify(u));
    beforeEach(() => arrange());

    it('answers { success, data: [...] }', async () => {
      const res = await get('');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(ids(res.body.data)).toEqual(['e3', 'e2', 'e1']);
    });
    it('passes kind / from / to / limit through', async () => {
      const res = await get('?kind=sales&from=2026-01-10&to=2026-01-12&limit=1');
      expect(ids(res.body.data)).toEqual(['e2']);
    });
    it('ignores empty parameters and takes all=1 / true / 0 from an approver', async () => {
      expect((await get('?kind=&from=&to=&user_id=&all=&limit=')).status).toBe(200);
      expect(ids((await get('?all=1', admin)).body.data)).toEqual(['e3', 'e2', 'e4', 'e1']);
      expect(ids((await get('?all=true', admin)).body.data)).toEqual(['e3', 'e2', 'e4', 'e1']);
      expect(ids((await get('?all=0', admin)).body.data)).toEqual([]);                          // admin's own: none
    });
    it('validates the parameters: 400', async () => {
      for (const qs of ['?kind=leads', '?from=yesterday', '?to=2026-02-31', '?user_id=nope', '?user_id=1;drop', '?all=maybe']) {
        const res = await get(qs, admin);
        expect({ qs, status: res.status }).toEqual({ qs, status: 400 });
      }
    });
    it('403 for an ordinary user asking for others', async () => {
      expect((await get(`?user_id=${REP2}`)).status).toBe(403);
      expect((await get('?all=1')).status).toBe(403);
    });
    it('is [] with no targets config', async () => {
      __mock.reset(); te._resetTargetEntriesProbe(); arrange({});
      const res = await get('');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });
});

// ── entries: deleting ────────────────────────────────────────────────────────
describe('deleting an entry', () => {
  const created = '2026-01-20T06:00:00.000Z';
  const HOUR = 3_600_000;
  const arrange = (rows: any[] = [entry({ created_at: created })]) => {
    settings({ [CLIENT]: BOTH });
    __mock.setDefault('crm_target_entries', fakeTable(rows));
  };
  const del = (u: any = rep, now = at(created) + HOUR, id = ENTRY) => te.deleteEntry(actorOf(u), id, now);
  const softDeleted = () => updatesOf('crm_target_entries');

  it('lets the owner delete within 24 hours, as a soft delete', async () => {
    arrange();
    await expect(del(rep, at(created) + 23 * HOUR + 59 * 60_000)).resolves.toEqual({ id: ENTRY });
    expect(softDeleted()).toHaveLength(1);
    expect(softDeleted()[0]).toEqual({ deleted_at: new Date(at(created) + 23 * HOUR + 59 * 60_000).toISOString() });
    expect(__mock.chainsFor('crm_target_entries').flatMap((c) => c.ops).some((o) => o.method === 'delete')).toBe(false);   // never a hard delete
  });
  it('is exactly 24 hours: allowed at 24 h, refused a millisecond after', async () => {
    arrange();
    await expect(del(rep, at(created) + 24 * HOUR)).resolves.toBeDefined();
    __mock.reset(); te._resetTargetEntriesProbe(); arrange();
    await expect(del(rep, at(created) + 24 * HOUR + 1)).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(softDeleted()).toHaveLength(0);
  });
  it('refuses the owner after 24 hours but lets an approver delete any time', async () => {
    arrange();
    await expect(del(rep, at(created) + 72 * HOUR)).rejects.toMatchObject({ statusCode: 403 });
    await expect(del(admin, at(created) + 72 * HOUR)).resolves.toEqual({ id: ENTRY });
  });
  it('refuses another ordinary user, even inside the window', async () => {
    arrange();
    await expect(del({ ...rep, id: REP2 })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(softDeleted()).toHaveLength(0);
  });
  it('lets an approver delete someone else\'s entry, but not an own-scope exec with an admin role', async () => {
    arrange();
    await expect(del(admin)).resolves.toBeDefined();
    __mock.reset(); te._resetTargetEntriesProbe(); arrange();
    await expect(del({ ...rep, id: REP2, role: 'sub_admin', org_role_data_scope: 'own' })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('404 when there is no such entry, it is already deleted, or it is in another client / org', async () => {
    for (const rows of [[], [entry({ created_at: created, deleted_at: '2026-01-20T07:00:00Z' })], [entry({ created_at: created, client_id: OTHER_CLIENT })],
      [entry({ created_at: created, org_id: '99999999-0000-0000-0000-000000000000' })]]) {
      __mock.reset(); te._resetTargetEntriesProbe(); arrange(rows);
      await expect(del(admin)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(softDeleted()).toHaveLength(0);
    }
  });
  it('looks the entry up inside the caller\'s org and client', async () => {
    arrange();
    await del(admin);
    const lookup = __mock.chainsFor('crm_target_entries').find((c) => c.single)!;
    expect(lookup.eqs).toMatchObject({ id: ENTRY, org_id: ORG, client_id: CLIENT });
    expect(opsOf(lookup, 'is')).toContainEqual(['deleted_at', null]);
    const upd = __mock.chainsFor('crm_target_entries').find((c) => c.ops.some((o) => o.method === 'update'))!;
    expect(upd.eqs).toMatchObject({ id: ENTRY, org_id: ORG });
  });
  it('404 before the migration', async () => {
    arrange(); noTable();
    await expect(del()).rejects.toMatchObject({ statusCode: 404 });
  });

  describe('DELETE /crm/targets/entries/:id', () => {
    const app = express();
    app.use(express.json());
    app.use('/crm', crmRouter);
    const send = (id: string, u: object = rep) => request(app).delete(`/crm/targets/entries/${id}`).set('x-test-user', JSON.stringify(u));
    it('answers { success, data: { id } } for a recent entry of your own', async () => {
      arrange([entry({ created_at: new Date().toISOString() })]);
      const res = await send(ENTRY);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { id: ENTRY } });
    });
    it('403 after 24 hours for the owner, 200 for an approver', async () => {
      arrange([entry({ created_at: new Date(Date.now() - 25 * HOUR).toISOString() })]);
      expect((await send(ENTRY)).status).toBe(403);
      expect((await send(ENTRY, admin)).status).toBe(200);
    });
    it('404 for an unknown entry, 400 for a malformed id', async () => {
      arrange([]);
      expect((await send(ENTRY)).status).toBe(404);
      expect((await send('not-a-uuid')).status).toBe(400);
    });
  });
});

// ── nothing changes for a request without a type ─────────────────────────────
describe('the lead targets do not read the rupee-target config', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  it('a request without a type (or with an empty one) never touches crm_settings or the entries table', async () => {
    __mock.setDefault('crm_targets', { data: [trow({ metric: 'leads_created', period: 'daily', target_value: 4 })] });
    __mock.setDefault('org_roles', { data: [] });
    for (const qs of ['', '?type=']) {
      __mock.reset();
      __mock.setDefault('crm_targets', { data: [trow({ metric: 'leads_created', period: 'daily', target_value: 4 })] });
      __mock.setDefault('org_roles', { data: [] });
      const res = await request(app).get(`/crm/targets${qs}`).set('x-test-user', JSON.stringify(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.default_target).toBe(4);
      expect(__mock.chainsFor('crm_settings')).toHaveLength(0);
      expect(__mock.chainsFor('crm_target_entries')).toHaveLength(0);
      expect(__mock.chainsFor('crm_targets')[0].eqs).toMatchObject({ metric: 'leads_created', period: 'daily' });
      const levels = await request(app).get(`/crm/targets/levels${qs}`).set('x-test-user', JSON.stringify(admin));
      expect(levels.status).toBe(200);
      expect(__mock.chainsFor('crm_settings')).toHaveLength(0);
    }
  });
});
