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

describe('the rupee targets config', () => {
  it('enables sales and collection with their default labels', () => {
    expect(app.planTargetsConfig(undefined)).toEqual({ types: [{ key: 'sales' }, { key: 'collection' }] });
    expect(app.planTargetsConfig(null)).toEqual({ types: [{ key: 'sales' }, { key: 'collection' }] });
    expect(app.planTargetsConfig({ types: [] })).toEqual({ types: [{ key: 'sales' }, { key: 'collection' }] });
  });
  it('keeps a type that is already there, with its position and label, and adds only what is missing', () => {
    expect(app.planTargetsConfig({ types: [{ key: 'collection', label: 'Recovery' }] }))
      .toEqual({ types: [{ key: 'collection', label: 'Recovery' }, { key: 'sales' }] });
    expect(app.planTargetsConfig({ types: [{ key: 'sales', label: 'Orders' }, { key: 'collection' }] }))
      .toEqual({ types: [{ key: 'sales', label: 'Orders' }, { key: 'collection' }] });
  });
  it('keeps any other key in config.targets, and does not mutate its input', () => {
    const existing = Object.freeze({ types: Object.freeze([]) as unknown as unknown[], future: { x: 1 } });
    expect(app.planTargetsConfig(existing)).toMatchObject({ future: { x: 1 } });
  });
  it('is idempotent, and is accepted by the settings API validator', () => {
    const once = app.planTargetsConfig(undefined);
    expect(app.sameJson(app.planTargetsConfig(once), once)).toBe(true);
    expect(v.settingsUpdateSchema.safeParse({ config: { targets: once } }).success).toBe(true);
  });
  it('is read back as both types by the server', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { normalizeTargetTypes } = require('../src/services/crm/targetEntries.service') as typeof import('../src/services/crm/targetEntries.service');
    expect(normalizeTargetTypes(app.planTargetsConfig(undefined)).map((t) => t.key)).toEqual(['sales', 'collection']);
  });
});

describe('admin-only lead owners (lead_form.owner_assignment)', () => {
  it("sets owner_assignment to 'admin_only' on a client with no lead_form yet", () => {
    expect(app.OWNER_ASSIGNMENT).toBe('admin_only');
    for (const none of [undefined, null, {}, 'junk', [], 3]) expect(app.planLeadForm(none)).toEqual({ owner_assignment: 'admin_only' });
  });
  it('keeps every other lead_form key (the endpoint replaces lead_form as a whole), and does not mutate its input', () => {
    const existing = Object.freeze({ segment_labels: { b2b: 'Dealer', b2c: 'Farmers' }, address_on_b2b: true, schedule_visit: { segments: ['b2b'] }, future: { x: 1 } });
    expect(app.planLeadForm(existing)).toEqual({ ...existing, owner_assignment: 'admin_only' });
    expect('owner_assignment' in existing).toBe(false);
  });
  it('turns a cleared (null) or different value back on', () => {
    expect(app.planLeadForm({ owner_assignment: null })).toEqual({ owner_assignment: 'admin_only' });
    expect(app.planLeadForm({ owner_assignment: 'anyone' })).toEqual({ owner_assignment: 'admin_only' });
  });
  it('is idempotent, and is detected as unchanged regardless of key order', () => {
    const once = app.planLeadForm({ address_on_b2b: true });
    expect(app.sameJson(app.planLeadForm(once), once)).toBe(true);
    expect(app.sameJson(app.planLeadForm({ owner_assignment: 'admin_only', address_on_b2b: true }), once)).toBe(true);
    expect(app.sameJson(app.planLeadForm({ address_on_b2b: true }), { address_on_b2b: true })).toBe(false);   // a client without it needs the write
  });
  it('is accepted by the settings API validator, next to the lead-form seed\'s own keys', () => {
    const seeded = app.planLeadForm(forms.LEAD_FORM);
    expect(v.settingsUpdateSchema.safeParse({ config: { lead_form: seeded } }).success).toBe(true);
    expect(v.settingsUpdateSchema.safeParse({ config: { lead_form: app.planLeadForm(undefined) } }).success).toBe(true);
  });
  it('is read as on by the server (what the enforcement looks at)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isAdminOnlyOwnerAssignment } = require('../src/services/crm/leadFormConfig') as typeof import('../src/services/crm/leadFormConfig');
    expect(isAdminOnlyOwnerAssignment(app.planLeadForm(undefined) as any)).toBe(true);
  });
  it('survives the lead-form seed being run afterwards (either order keeps both)', () => {
    const afterApp = app.planCrmSettings({}).config;                                  // app-config first
    const afterForms = forms.planSettings(afterApp);                                  // then the lead-form seed
    expect(afterForms.config.lead_form).toEqual({ ...forms.LEAD_FORM, owner_assignment: 'admin_only' });
    expect(app.planLeadForm(afterForms.config.lead_form)).toEqual(afterForms.config.lead_form);   // and app-config again: no change
  });
});

describe('the whole CRM settings patch (consent block + targets + lead owners)', () => {
  it('carries all three, valid for the settings API, and nothing else when the client has its own row', () => {
    const patch = app.planCrmSettings({ field_overrides: { 'lead.phone': { label: 'Mobile' } }, lead_form: { address_on_b2b: true } });
    expect(Object.keys(patch.config).sort()).toEqual(['field_overrides', 'lead_form', 'targets']);
    expect((patch.config.field_overrides as any)['lead.phone']).toEqual({ label: 'Mobile' });
    expect((patch.config.field_overrides as any)['lead.data_consent@b2b']).toEqual({ hidden: true, required: false });
    expect(patch.config.targets).toEqual({ types: [{ key: 'sales' }, { key: 'collection' }] });
    expect(patch.config.lead_form).toEqual({ address_on_b2b: true, owner_assignment: 'admin_only' });
    expect(v.settingsUpdateSchema.safeParse(patch).success).toBe(true);
  });
  it('carries the inherited org-level config across when the client has no row of its own, with ours on top', () => {
    const patch: any = app.planCrmSettings({ lead_form: { address_on_b2b: true }, targets: { types: [{ key: 'sales', label: 'Orders' }] }, score_boost_signals: ['a'] }, true);
    expect(patch.config.lead_form).toEqual({ address_on_b2b: true, owner_assignment: 'admin_only' });
    expect(patch.config.targets).toEqual({ types: [{ key: 'sales', label: 'Orders' }, { key: 'collection' }] });
    expect('score_boost_signals' in patch.config).toBe(false);
  });
  it('detects each part as done or not, so a re-run writes nothing', () => {
    const row = { field_overrides: { 'lead.phone': { label: 'Mobile' } }, lead_form: { address_on_b2b: true }, consent: { lead_pii: { required: false } } };
    const first: any = app.planCrmSettings(row);
    expect(app.sameJson(first.config.lead_form, row.lead_form)).toBe(false);
    expect(app.sameJson(first.config.targets, undefined)).toBe(false);
    const applied = { ...row, ...first.config };                                       // PATCH merges top-level keys
    const second: any = app.planCrmSettings(applied);
    for (const k of ['field_overrides', 'lead_form', 'targets']) expect({ k, same: app.sameJson(second.config[k], applied[k]) }).toEqual({ k, same: true });
    expect(applied.consent).toEqual(row.consent);                                      // and what it does not manage is untouched
  });
  it('is idempotent: planning from its own output changes nothing', () => {
    const once = app.planCrmSettings({});
    const twice = app.planCrmSettings(once.config);
    expect(app.sameJson(twice, once)).toBe(true);
  });
});

// ── the tool end to end (against a fake API), dry run and real run ───────────
describe('running the tool', () => {
  const API = 'https://api.test';
  const CID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
  const settled = {
    policies: [{ id: 'p1', name: 'Agrisynx field policy', client_id: CID, is_active: true, rules: app.planExpenseRules(undefined) }],
    client: { id: CID, settings: { app_ui: app.planAppUi(undefined) } },
  };
  const settledConfig = (): any => app.planCrmSettings({}).config;

  /** A fake API: returns the canned reads and records every call. */
  function fakeApi(settingsRow: any) {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
      const path = String(url).replace(API, '');
      const method = init.method || 'GET';
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      const reply = (json: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
      if (method === 'GET' && path === '/api/v1/expenses/policies') return reply({ data: settled.policies });
      if (method === 'GET' && path === '/api/v1/clients') return reply({ data: [settled.client] });
      if (method === 'GET' && path === '/api/v1/crm/settings') return reply({ data: settingsRow });
      return reply({ success: true });
    });
    return calls;
  }
  async function run(args: string[], settingsRow: any) {
    const calls = fakeApi(settingsRow);
    const logs: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const argv = process.argv;
    const keys = ['TOKEN', 'CLIENT_ID', 'API_URL', 'PROJECT'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.argv = ['node', 'agrisynx-app-config.ts', ...args];
    Object.assign(process.env, { TOKEN: 't', CLIENT_ID: CID, API_URL: API, PROJECT: 'kinematic' });
    try { await app.main(); } finally {
      process.argv = argv; log.mockRestore();
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    return { calls, logs };
  }
  const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== 'GET');

  it('dry run: says it would turn admin-only lead owners on, and writes nothing', async () => {
    const { calls, logs } = await run(['--dry-run'], { id: 'cs-1', client_id: CID, config: { lead_form: { segment_labels: { b2b: 'Dealer' } } } });
    expect(writes(calls)).toEqual([]);
    expect(logs).toContain("[dry-run] update settings: only an admin may choose a lead's owner (config.lead_form.owner_assignment=admin_only)");
    expect(logs).toContain('Dry run only — nothing was changed.');
  });
  it('real run: one settings PATCH carries lead_form with the existing keys kept and owner_assignment on', async () => {
    const { calls } = await run([], { id: 'cs-1', client_id: CID, config: { lead_form: { segment_labels: { b2b: 'Dealer' }, address_on_b2b: true } } });
    const patches = writes(calls).filter((c) => c.path === '/api/v1/crm/settings');
    expect(patches).toHaveLength(1);
    expect(patches[0].method).toBe('PATCH');
    expect(patches[0].body.config.lead_form).toEqual({ segment_labels: { b2b: 'Dealer' }, address_on_b2b: true, owner_assignment: 'admin_only' });
    expect(v.settingsUpdateSchema.safeParse(patches[0].body).success).toBe(true);
  });
  it('is idempotent: when everything is already set it says so and writes nothing', async () => {
    const { calls, logs } = await run([], { id: 'cs-1', client_id: CID, config: settledConfig() });
    expect(writes(calls)).toEqual([]);
    expect(logs).toContain('lead owners: already admin-only');
    expect(logs).toContain('lead consent block: already hidden');
    expect(logs).toContain('targets: sales + collection already enabled');
  });
  it('writes the settings again when only the lead owners are missing', async () => {
    const { owner_assignment: _drop, ...leadForm } = settledConfig().lead_form;
    const { calls, logs } = await run([], { id: 'cs-1', client_id: CID, config: { ...settledConfig(), lead_form: leadForm } });
    expect(logs).toContain('lead consent block: already hidden');
    expect(writes(calls).map((c) => c.path)).toEqual(['/api/v1/crm/settings']);
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
