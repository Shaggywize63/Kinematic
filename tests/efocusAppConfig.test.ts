/**
 * eFocus app configuration (src/tools/efocus-app-config.ts) — GPS travel on check-out + the Expenses tab —
 * and the endpoints it uses:
 *
 *   - the planners are pure and idempotent;
 *   - what the tool sends passes the REAL expense-policy API (validator + normaliser) and comes back in
 *     GET /expenses/policy with gps_distance + the vehicle rates the check-out prompt needs;
 *   - app_ui.tabs.expenses written by PATCH /clients/:id survives untouched and comes back in /auth/me.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({ AIService: { callKiniAI: jest.fn(), getFunctionalKey: jest.fn() } }));
jest.mock('../src/lib/entitlements', () => ({
  ...jest.requireActual('../src/lib/entitlements'),
  resolveEntitlements: jest.fn().mockResolvedValue({ enabled_modules: ['crm', 'field_expenses'], enabled_packages: ['crm'] }),
}));
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => { req.user = req.user ?? { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a' }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as app from '../src/tools/efocus-app-config';
import * as policy from '../src/services/expenses/policy.service';
import expensesRouter from '../src/routes/expenses.routes';
import clientRouter from '../src/routes/client.routes';
import { me } from '../src/controllers/auth.controller';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const OTHER_CLIENT = '66666666-6666-6666-6666-666666666666';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const POLICY_ID = '77777777-7777-7777-7777-777777777777';

describe('the expense rules eFocus gets', () => {
  it('pins the category list to the server\'s', () => {
    expect([...app.CATEGORIES]).toEqual([...policy.CATEGORIES]);
  });
  it('turns GPS travel on, labels mileage Travel, and enables travel + the out-of-pocket categories', () => {
    const r: any = app.planExpenseRules(undefined, [{ label: 'Bike', rate_per_km: 4 }]);
    expect(r.gps_distance).toBe(true);
    expect(r.category_labels).toMatchObject({ mileage: 'Travel' });
    expect(r.categories.mileage.enabled).toBe(true);
    expect(r.categories.food.enabled).toBe(true);
    expect(r.categories.travel.enabled).toBe(false);  // GPS mileage is the "Travel" line; the free-text 'travel' stays off
    expect(r.vehicle_rates).toEqual([{ label: 'Bike', rate_per_km: 4 }]);
  });
  it('keeps the policy\'s existing vehicle rates and never overwrites them with the env seed', () => {
    const existing = policy.normalizeRules({ mileage_rate: 7, vehicle_rates: [{ label: 'Car', rate_per_km: 10 }] });
    const r: any = app.planExpenseRules(existing, [{ label: 'Bike', rate_per_km: 4 }]);
    expect(r.vehicle_rates).toEqual([{ id: 'car', label: 'Car', rate_per_km: 10 }]);  // kept, not replaced
    expect(r.mileage_rate).toBe(7);
  });
  it('seeds the rates from the env only when the policy has none', () => {
    const r: any = app.planExpenseRules({ categories: {} }, [{ label: 'Bike', rate_per_km: 4 }]);
    expect(r.vehicle_rates).toEqual([{ label: 'Bike', rate_per_km: 4 }]);
    const none: any = app.planExpenseRules({ categories: {} }, []);
    expect('vehicle_rates' in none).toBe(false);  // nothing to set; main() then refuses rather than guess a rate
  });
  it('adds to existing labels instead of replacing them, and does not mutate its input', () => {
    const existing = Object.freeze({ category_labels: Object.freeze({ food: 'Meals' }), categories: Object.freeze({}), vehicle_rates: Object.freeze([{ label: 'Bike', rate_per_km: 4 }]) });
    const r: any = app.planExpenseRules(existing);
    expect(r.category_labels).toEqual({ food: 'Meals', mileage: 'Travel' });
    expect(existing.category_labels).toEqual({ food: 'Meals' });
  });
  it('is idempotent and exactly what the server stores', () => {
    const once = app.planExpenseRules(policy.normalizeRules({ vehicle_rates: [{ label: 'Bike', rate_per_km: 4 }] }));
    expect(app.sameJson(app.planExpenseRules(once), once)).toBe(true);
    expect(app.sameJson(policy.normalizeRules(once), once)).toBe(true);
  });
  it('rulesCanPrompt is true only with gps_distance AND a vehicle', () => {
    expect(app.rulesCanPrompt(app.planExpenseRules(undefined, [{ label: 'Bike', rate_per_km: 4 }]))).toBe(true);
    expect(app.rulesCanPrompt(app.planExpenseRules(undefined, []))).toBe(false);
  });
});

describe('VEHICLE_RATES parsing', () => {
  it('reads a clean rates array and drops junk entries', () => {
    expect(app.parseVehicleRates('[{"label":" Two-wheeler ","rate_per_km":4},{"label":"Car","rate_per_km":10}]'))
      .toEqual([{ label: 'Two-wheeler', rate_per_km: 4 }, { label: 'Car', rate_per_km: 10 }]);
    expect(app.parseVehicleRates('[{"label":"","rate_per_km":4},{"rate_per_km":5},{"label":"X","rate_per_km":"nope"}]')).toEqual([]);
  });
  it('is empty (not an error) for absent or invalid input', () => {
    expect(app.parseVehicleRates(undefined)).toEqual([]);
    expect(app.parseVehicleRates('')).toEqual([]);
    expect(app.parseVehicleRates('not json')).toEqual([]);
    expect(app.parseVehicleRates('{"label":"x"}')).toEqual([]);
  });
});

describe('which expense policy it edits', () => {
  const own = (o: any) => ({ client_id: CLIENT, is_active: true, ...o });
  it('creates one when the client has none (an org-wide policy is shared, not the client\'s)', () => {
    expect(app.choosePolicy([], CLIENT)).toEqual({ op: 'create' });
    expect(app.choosePolicy([{ id: 'o', name: 'Org', client_id: null, is_active: true }], CLIENT)).toEqual({ op: 'create' });
    expect(app.choosePolicy([{ id: 'x', name: 'Other', client_id: OTHER_CLIENT, is_active: true }], CLIENT)).toEqual({ op: 'create' });
  });
  it('edits the client\'s only active policy, prefers its own by name, and will not guess between several', () => {
    expect(app.choosePolicy([own({ id: 'a', name: 'Field' })], CLIENT)).toEqual({ op: 'update', id: 'a', name: 'Field' });
    expect(app.choosePolicy([own({ id: 'a', name: 'Field' }), own({ id: 'b', name: 'eFocus FIELD policy' })], CLIENT)).toMatchObject({ op: 'update', id: 'b' });
    expect(app.choosePolicy([own({ id: 'a', name: 'A' }), own({ id: 'b', name: 'B' })], CLIENT).op).toBe('ambiguous');
  });
  it('honours POLICY_ID, but never a policy shared with other clients', () => {
    const list = [own({ id: 'a', name: 'A' }), { id: 'o', name: 'Org', client_id: null, is_active: true }];
    expect(app.choosePolicy(list, CLIENT, 'a')).toMatchObject({ op: 'update', id: 'a' });
    expect(app.choosePolicy(list, CLIENT, 'o')).toMatchObject({ op: 'shared', id: 'o' });
    expect(app.choosePolicy(list, CLIENT, 'zzz')).toEqual({ op: 'missing', id: 'zzz' });
  });
});

describe('the Expenses tab', () => {
  it('sets tabs.expenses on and leaves every other key alone, at every level', () => {
    expect(app.planAppUi(undefined)).toEqual({ tabs: { expenses: true } });
    const existing = { menu: { reports: false }, tabs: { leads: true }, home: { greeting: 'hi' } };
    expect(app.planAppUi(existing)).toEqual({ menu: { reports: false }, tabs: { leads: true, expenses: true }, home: { greeting: 'hi' } });
    expect(existing.tabs).toEqual({ leads: true });
  });
  it('is idempotent and refuses to flatten a tabs value it does not understand', () => {
    const once = app.planAppUi({ tabs: { leads: true } });
    expect(app.sameJson(app.planAppUi(once), once)).toBe(true);
    expect(() => app.planAppUi({ tabs: ['expenses'] })).toThrow(/app_ui\.tabs/);
  });
});

// ── the tool end to end (against a fake API) ─────────────────────────────────
describe('running the tool', () => {
  const API = 'https://api.test';
  const RATES = '[{"label":"Two-wheeler","rate_per_km":4}]';
  const settledRules = () => app.planExpenseRules(undefined, app.parseVehicleRates(RATES));

  function fakeApi(policies: any[], client: any) {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
      const path = String(url).replace(API, '');
      const method = init.method || 'GET';
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      const reply = (json: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
      if (method === 'GET' && path === '/api/v1/expenses/policies') return reply({ data: policies });
      if (method === 'GET' && path === '/api/v1/clients') return reply({ data: [client] });
      return reply({ success: true });
    });
    return calls;
  }
  async function run(args: string[], policies: any[], client: any, env: Record<string, string> = {}) {
    const calls = fakeApi(policies, client);
    const logs: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const argv = process.argv;
    const keys = ['TOKEN', 'CLIENT_ID', 'API_URL', 'PROJECT', 'VEHICLE_RATES', 'POLICY_ID'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.argv = ['node', 'efocus-app-config.ts', ...args];
    Object.assign(process.env, { TOKEN: 't', CLIENT_ID: CLIENT, API_URL: API, PROJECT: 'kinematic', ...env });
    let error: Error | null = null;
    try { await app.main(); } catch (e) { error = e as Error; } finally {
      process.argv = argv; log.mockRestore();
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    return { calls, logs, error };
  }
  const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== 'GET');
  const ownPolicy = (rules: any) => ({ id: 'p1', name: 'eFocus field policy', client_id: CLIENT, is_active: true, rules });

  it('dry run with VEHICLE_RATES: says what it would do and writes nothing', async () => {
    const { calls, logs } = await run(['--dry-run'], [], { id: CLIENT, settings: {} }, { VEHICLE_RATES: RATES });
    expect(writes(calls)).toEqual([]);
    expect(logs.join('\n')).toMatch(/create expense policy "eFocus field policy"/);
    expect(logs.join('\n')).toMatch(/tabs\.expenses=on/);
    expect(logs).toContain('Dry run only — nothing was changed.');
  });

  it('real run: creates the GPS policy and turns the Expenses tab on', async () => {
    const { calls } = await run([], [], { id: CLIENT, settings: {} }, { VEHICLE_RATES: RATES });
    const w = writes(calls);
    const post = w.find((c) => c.path === '/api/v1/expenses/policies');
    expect(post?.method).toBe('POST');
    expect(post?.body).toMatchObject({ name: 'eFocus field policy', priority: 10, applies_to: { everyone: true } });
    expect(post?.body.rules).toMatchObject({ gps_distance: true, vehicle_rates: [{ label: 'Two-wheeler', rate_per_km: 4 }] });
    const patch = w.find((c) => c.path === `/api/v1/clients/${CLIENT}`);
    expect(patch?.method).toBe('PATCH');
    expect(patch?.body.app_ui.tabs.expenses).toBe(true);
  });

  it('refuses to create a policy with no vehicle rate to price travel', async () => {
    const { error, calls } = await run([], [], { id: CLIENT, settings: {} }, {});
    expect(error?.message).toMatch(/VEHICLE_RATES/);
    expect(writes(calls)).toEqual([]);  // bailed before writing anything
  });

  it('keeps an existing policy\'s rates (no VEHICLE_RATES needed) and is idempotent when all set', async () => {
    const settled = app.planExpenseRules(policy.normalizeRules({ vehicle_rates: [{ label: 'Car', rate_per_km: 10 }] }));
    const { calls, logs } = await run([], [ownPolicy(settled)], { id: CLIENT, settings: { app_ui: app.planAppUi(undefined) } }, {});
    expect(writes(calls)).toEqual([]);
    expect(logs).toContain('expense policy "eFocus field policy": already up to date');
    expect(logs).toContain('app_ui: already up to date');
  });
});

// ── the policy API accepts exactly what the tool sends ───────────────────────
describe('what the tool sends to the expense policy API', () => {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => { req.user = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' }; next(); });
  server.use('/expenses', expensesRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  server.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  const stored = (rules: any) => ({
    id: POLICY_ID, org_id: ORG, client_id: CLIENT, name: 'Field policy', is_active: true, priority: 100, currency: 'INR',
    applies_to: { everyone: true }, deleted_at: null, rules,
  });
  const updates = () => __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));
  beforeEach(() => __mock.reset());

  it('PUT /expenses/policies/:id with the planned rules is accepted, stored, and served to the apps', async () => {
    const before = policy.normalizeRules({ vehicle_rates: [{ label: 'Two-wheeler', rate_per_km: 4 }], categories: { food: { per_day_limit: 300 } } });
    __mock.setDefault('expense_policies', { data: [stored(before)] });
    const list = await request(server).get('/expenses/policies');
    expect(list.status).toBe(200);
    const planned = app.planExpenseRules(list.body.data[0].rules);
    expect(app.rulesCanPrompt(planned)).toBe(true);

    const res = await request(server).put(`/expenses/policies/${POLICY_ID}`).send({ rules: planned });
    expect(res.status).toBe(200);
    const saved = updates()[0].rules;
    expect(saved).toMatchObject({ gps_distance: true, category_labels: { mileage: 'Travel' } });
    expect(saved.vehicle_rates).toEqual([{ id: 'two_wheeler', label: 'Two-wheeler', rate_per_km: 4 }]);
    expect(saved.categories.mileage.enabled).toBe(true);
    expect(saved.categories.food.per_day_limit).toBe(300);
    expect(app.sameJson(saved, planned)).toBe(true);  // nothing left to change next time
  });
});

// ── app_ui.tabs.expenses survives the PATCH validator and the /auth/me round trip ──
describe('the Expenses tab round trip', () => {
  const client = { id: CLIENT, org_id: ORG, name: 'eFocus', settings: { keep: 'me', app_ui: { tabs: { old: true } } } };
  beforeEach(() => __mock.reset());

  it('PATCH /clients/:id stores tabs.expenses, replacing app_ui and nothing else in settings', async () => {
    __mock.setDefault('clients', { data: [client] });
    const server = express();
    server.use(express.json());
    server.use('/clients', clientRouter);
    const appUi = app.planAppUi(client.settings.app_ui);
    const res = await request(server).patch(`/clients/${CLIENT}`).send({ app_ui: appUi });
    expect(res.status).toBe(200);
    const w = __mock.chainsFor('clients').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));
    const settingsWrite = w.find((x) => x.settings);
    expect(settingsWrite.settings).toEqual({ keep: 'me', app_ui: { tabs: { old: true, expenses: true } } });
    expect(res.body.data.app_ui.tabs.expenses).toBe(true);
  });

  it('/auth/me hands the apps app_ui_config with tabs.expenses true', async () => {
    __mock.setDefault('users', { data: [{ id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin', name: 'A', org_role_id: null }] });
    __mock.setDefault('clients', { data: [{ id: CLIENT, settings: { app_ui: { tabs: { expenses: true } } } }] });
    const server = express();
    server.use((req: any, _res, next) => { req.user = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' }; next(); });
    server.get('/me', me as any);
    const res = await request(server).get('/me');
    expect(res.status).toBe(200);
    expect(res.body.data.app_ui_config.tabs.expenses).toBe(true);
  });
});
