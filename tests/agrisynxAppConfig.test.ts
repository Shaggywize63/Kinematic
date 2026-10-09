/**
 * Agrisynx app configuration (src/tools/agrisynx-app-config.ts) — Travel-only expenses, the app's tabs /
 * home tiles, and the hidden consent block — and the endpoints it uses:
 *
 *   - the planners are pure and idempotent;
 *   - what the tool sends passes the REAL expense-policy API (validator + normaliser) and comes back in
 *     GET /expenses/policy;
 *   - app_ui keys written by PATCH /clients/:id survive untouched and come back in /auth/me
 *     (`app_ui_config`), whatever keys they are (tabs.expenses, home.open_volume, ... or future ones);
 *   - the seed tool hides the consent keys on both lead types.
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
  requireAuth: (req: any, _res: any, next: any) => { req.user = req.user ?? { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: '55555555-5555-5555-5555-555555555555' }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as app from '../src/tools/agrisynx-app-config';
import * as forms from '../src/tools/agrisynx-lead-forms';
import * as policy from '../src/services/expenses/policy.service';
import * as v from '../src/validators/crm.validators';
import expensesRouter from '../src/routes/expenses.routes';
import clientRouter from '../src/routes/client.routes';
import { me } from '../src/controllers/auth.controller';

const ORG = '00000000-0000-0000-0000-0000000000aa';
// a well-formed v4 id: PATCH /clients/:id rejects anything else as "Invalid client ID"
const CLIENT = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const OTHER_CLIENT = '66666666-6666-6666-6666-666666666666';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const POLICY_ID = '77777777-7777-7777-7777-777777777777';

describe('the expense rules Agrisynx gets', () => {
  it('pins the category list to the server\'s', () => {
    expect([...app.CATEGORIES]).toEqual([...policy.CATEGORIES]);
  });
  it('disables every category but mileage, labels it Travel, and sets the three switches', () => {
    const r: any = app.planExpenseRules(undefined);
    for (const c of policy.CATEGORIES) expect({ c, enabled: r.categories[c].enabled }).toEqual({ c, enabled: c === 'mileage' });
    expect(r).toMatchObject({ category_labels: { mileage: 'Travel' }, route_fields: false, single_line: true, odometer_camera_only: true });
  });
  it('keeps everything else the policy already has: vehicle rates, limits, thresholds', () => {
    const existing = policy.normalizeRules({
      mileage_rate: 7, enforcement: 'block', vehicle_rates: [{ label: 'Bike', rate_per_km: 4 }],
      categories: { mileage: { per_day_limit: 900 }, food: { per_day_limit: 400 } },
    });
    const r: any = app.planExpenseRules(existing);
    expect(r).toMatchObject({ mileage_rate: 7, enforcement: 'block', vehicle_rates: [{ id: 'bike', label: 'Bike', rate_per_km: 4 }] });
    expect(r.categories.mileage).toMatchObject({ enabled: true, per_day_limit: 900 });
    expect(r.categories.food).toMatchObject({ enabled: false, per_day_limit: 400 });
  });
  it('adds to existing labels instead of replacing them, and does not mutate its input', () => {
    const existing = Object.freeze({ category_labels: Object.freeze({ food: 'Meals' }), categories: Object.freeze({}) });
    const r: any = app.planExpenseRules(existing);
    expect(r.category_labels).toEqual({ food: 'Meals', mileage: 'Travel' });
    expect(existing.category_labels).toEqual({ food: 'Meals' });
  });
  it('is idempotent', () => {
    const once = app.planExpenseRules(policy.normalizeRules({ mileage_rate: 9 }));
    expect(app.sameJson(app.planExpenseRules(once), once)).toBe(true);
    expect(app.sameJson(policy.normalizeRules(once), once)).toBe(true);      // and is exactly what the server stores
  });
  it('is detected as unchanged regardless of key order', () => {
    expect(app.sameJson({ a: 1, b: { c: [1, { x: 1, y: 2 }] } }, { b: { c: [1, { y: 2, x: 1 }] }, a: 1 })).toBe(true);
    expect(app.sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(app.sameJson(undefined, { a: 1 })).toBe(false);
  });
});

describe('which expense policy it edits', () => {
  const own = (o: any) => ({ client_id: CLIENT, is_active: true, ...o });
  it('creates one when the client has none (an org-wide policy does not count: it is shared)', () => {
    expect(app.choosePolicy([], CLIENT)).toEqual({ op: 'create' });
    expect(app.choosePolicy([{ id: 'o', name: 'Org', client_id: null, is_active: true }], CLIENT)).toEqual({ op: 'create' });
    expect(app.choosePolicy([{ id: 'x', name: 'Other client', client_id: OTHER_CLIENT, is_active: true }], CLIENT)).toEqual({ op: 'create' });
  });
  it('edits the client\'s only active policy in place', () => {
    expect(app.choosePolicy([own({ id: 'a', name: 'Field' }), own({ id: 'b', name: 'Old', is_active: false })], CLIENT)).toEqual({ op: 'update', id: 'a', name: 'Field' });
  });
  it('prefers its own by name, even when several are active', () => {
    const list = [own({ id: 'a', name: 'Field' }), own({ id: 'b', name: 'agrisynx FIELD policy' })];
    expect(app.choosePolicy(list, CLIENT)).toMatchObject({ op: 'update', id: 'b' });
  });
  it('will not guess between several active policies', () => {
    const r = app.choosePolicy([own({ id: 'a', name: 'A' }), own({ id: 'b', name: 'B' })], CLIENT);
    expect(r.op).toBe('ambiguous');
  });
  it('honours POLICY_ID, but never a policy shared with other clients', () => {
    const list = [own({ id: 'a', name: 'A' }), own({ id: 'b', name: 'B' }), { id: 'o', name: 'Org', client_id: null, is_active: true }];
    expect(app.choosePolicy(list, CLIENT, 'b')).toMatchObject({ op: 'update', id: 'b' });
    expect(app.choosePolicy(list, CLIENT, 'o')).toMatchObject({ op: 'shared', id: 'o' });
    expect(app.choosePolicy(list, CLIENT, 'zzz')).toEqual({ op: 'missing', id: 'zzz' });
  });
});

describe('the app tabs and home tiles', () => {
  it('sets tabs.expenses on, tabs.new_form off and home.open_volume off', () => {
    expect(app.planAppUi(undefined)).toEqual({ tabs: { expenses: true, new_form: false }, home: { open_volume: false } });
    expect(app.planAppUi(null)).toEqual({ tabs: { expenses: true, new_form: false }, home: { open_volume: false } });
  });
  it('leaves every other key alone, at every level', () => {
    const existing = { menu: { reports: false }, tabs: { leads: true, new_form: true }, home: { greeting: 'hi' }, crm_more: { x: 1 } };
    expect(app.planAppUi(existing)).toEqual({
      menu: { reports: false }, tabs: { leads: true, new_form: false, expenses: true }, home: { greeting: 'hi', open_volume: false }, crm_more: { x: 1 },
    });
    expect(existing.tabs).toEqual({ leads: true, new_form: true });          // input untouched
  });
  it('is idempotent', () => {
    const once = app.planAppUi({ tabs: { leads: true } });
    expect(app.sameJson(app.planAppUi(once), once)).toBe(true);
  });
  it('refuses to flatten a tabs / home value it does not understand', () => {
    expect(() => app.planAppUi({ tabs: ['expenses'] })).toThrow(/app_ui\.tabs/);
    expect(() => app.planAppUi({ home: 'yes' })).toThrow(/app_ui\.home/);
  });
});

describe('the consent block', () => {
  it('is hidden on both lead types, and the dealer marketing / WhatsApp boxes too', () => {
    const fo: any = app.planConsentSettings({}).config.field_overrides;
    for (const k of ['lead.data_consent@b2b', 'lead.data_consent@b2c', 'lead.marketing_consent@b2b', 'lead.whatsapp_consent@b2b']) {
      expect({ k, hidden: fo[k]?.hidden }).toEqual({ k, hidden: true });
    }
  });
  it('comes from the lead-form seed, so the two tools cannot disagree', () => {
    for (const k of app.CONSENT_OVERRIDE_KEYS) expect(app.CONSENT_OVERRIDES[k]).toEqual(forms.FIELD_OVERRIDES[k]);
  });
  it('keeps the admin\'s other overrides and every other config key', () => {
    const cfg = { field_overrides: { 'lead.phone': { label: 'Phone' } }, lead_form: { address_on_b2b: true }, consent: { lead_pii: { required: false } } };
    const patch = app.planConsentSettings(cfg);
    expect(Object.keys(patch.config)).toEqual(['field_overrides']);             // PATCH merges the rest shallowly
    expect((patch.config.field_overrides as any)['lead.phone']).toEqual({ label: 'Phone' });
  });
  it('carries the whole org-level config when the client has no row of its own yet, minus the overlay', () => {
    const cfg = { field_overrides: {}, lead_form: { address_on_b2b: true }, score_boost_signals: ['a'] };
    const patch: any = app.planConsentSettings(cfg, true);
    expect(patch.config.lead_form).toEqual({ address_on_b2b: true });
    expect('score_boost_signals' in patch.config).toBe(false);
  });
  it('is accepted by the settings API validator, and is idempotent', () => {
    const patch = app.planConsentSettings({});
    expect(v.settingsUpdateSchema.safeParse(patch).success).toBe(true);
    expect(app.sameJson(app.planConsentSettings(patch.config).config.field_overrides, patch.config.field_overrides)).toBe(true);
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
    const before = policy.normalizeRules({ mileage_rate: 8, vehicle_rates: [{ label: 'Two-wheeler', rate_per_km: 4 }], categories: { food: { per_day_limit: 300 } } });
    __mock.setDefault('expense_policies', { data: [stored(before)] });
    const list = await request(server).get('/expenses/policies');
    expect(list.status).toBe(200);
    const planned = app.planExpenseRules(list.body.data[0].rules);

    const res = await request(server).put(`/expenses/policies/${POLICY_ID}`).send({ rules: planned });
    expect(res.status).toBe(200);
    const saved = updates()[0].rules;
    expect(saved).toMatchObject({ category_labels: { mileage: 'Travel' }, route_fields: false, single_line: true, odometer_camera_only: true, mileage_rate: 8 });
    expect(saved.vehicle_rates).toEqual([{ id: 'two_wheeler', label: 'Two-wheeler', rate_per_km: 4 }]);
    for (const c of policy.CATEGORIES) expect(saved.categories[c].enabled).toBe(c === 'mileage');
    expect(saved.categories.food.per_day_limit).toBe(300);
    // what was stored is exactly what the tool will see next time: nothing left to change
    expect(app.sameJson(saved, planned)).toBe(true);
  });

  it('POST /expenses/policies with the create body is accepted', async () => {
    __mock.setDefault('expense_policies', { data: [stored(policy.normalizeRules({}))] });
    const res = await request(server).post('/expenses/policies')
      .send({ name: app.DEFAULT_POLICY_NAME, priority: 10, applies_to: { everyone: true }, rules: app.planExpenseRules(undefined) });
    expect(res.status).toBe(201);
    const insert = __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any))[0];
    expect(insert).toMatchObject({ name: 'Agrisynx field policy', priority: 10, client_id: CLIENT });
    expect(insert.rules).toMatchObject({ category_labels: { mileage: 'Travel' }, single_line: true });
  });
});

// ── F: app_ui keys survive the PATCH validator and the /auth/me round trip ───
describe('app_ui round trip', () => {
  const APP_UI = { tabs: { expenses: true, new_form: false }, home: { open_volume: false }, future: { anything: ['goes', { deeply: 1 }] } };
  const client = { id: CLIENT, org_id: ORG, name: 'Agrisynx', settings: { keep: 'me', app_ui: { tabs: { old: true } } } };
  beforeEach(() => __mock.reset());

  it('PATCH /clients/:id stores whatever keys app_ui carries, replacing app_ui and nothing else in settings', async () => {
    __mock.setDefault('clients', { data: [client] });
    const server = express();
    server.use(express.json());
    server.use('/clients', clientRouter);
    const res = await request(server).patch(`/clients/${CLIENT}`).send({ app_ui: APP_UI });
    expect(res.status).toBe(200);
    const writes = __mock.chainsFor('clients').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));
    const settingsWrite = writes.find((w) => w.settings);
    expect(settingsWrite.settings).toEqual({ keep: 'me', app_ui: APP_UI });        // exact: no key stripped, no key added
    expect(res.body.data.app_ui).toEqual(APP_UI);
  });

  it('PATCH /clients/:id without app_ui does not touch it', async () => {
    __mock.setDefault('clients', { data: [client] });
    const server = express();
    server.use(express.json());
    server.use('/clients', clientRouter);
    const res = await request(server).patch(`/clients/${CLIENT}`).send({ name: 'Agrisynx' });
    expect(res.status).toBe(200);
    const writes = __mock.chainsFor('clients').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));
    expect(writes.some((w) => w.settings)).toBe(false);
    expect(res.body.data.app_ui).toEqual({ tabs: { old: true } });
  });

  it('/auth/me hands the apps app_ui_config exactly as stored', async () => {
    __mock.setDefault('users', { data: [{ id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin', name: 'A', org_role_id: null }] });
    __mock.setDefault('clients', { data: [{ id: CLIENT, settings: { app_ui: APP_UI } }] });
    const server = express();
    server.use((req: any, _res, next) => { req.user = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' }; next(); });
    server.get('/me', me as any);
    const res = await request(server).get('/me');
    expect(res.status).toBe(200);
    expect(res.body.data.app_ui_config).toEqual(APP_UI);
    expect(res.body.data.app_ui_config.tabs.expenses).toBe(true);
    expect(res.body.data.app_ui_config.home.open_volume).toBe(false);
  });

  it('/auth/me gives {} (use the built-in defaults) for a client that has none', async () => {
    __mock.setDefault('users', { data: [{ id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin', name: 'A', org_role_id: null }] });
    __mock.setDefault('clients', { data: [{ id: CLIENT, settings: {} }] });
    const server = express();
    server.use((req: any, _res, next) => { req.user = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' }; next(); });
    server.get('/me', me as any);
    expect((await request(server).get('/me')).body.data.app_ui_config).toEqual({});
  });
});
