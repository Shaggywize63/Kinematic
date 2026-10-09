/**
 * Expense policy: the presentation-only rule keys the Agrisynx apps read from GET /expenses/policy ->
 * data.rules (category_labels, route_fields, single_line, odometer_camera_only).
 *
 * They default to today's behaviour, survive an admin save from an editor that has never heard of
 * them, are validated at the API edge, and are NOT enforced by the server (existing multi-line claims
 * stay editable).
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({
  AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as policy from '../src/services/expenses/policy.service';
import expensesRouter from '../src/routes/expenses.routes';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '55555555-5555-5555-5555-555555555555';
const REP = '11111111-1111-1111-1111-111111111111';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const POLICY_ID = '66666666-6666-6666-6666-666666666666';

const rulesOf = (o: any = {}) => policy.normalizeRules(o);
const pol = (o: Partial<policy.ExpensePolicy> = {}): policy.ExpensePolicy => ({ ...policy.BUILT_IN_POLICY, name: 'Agri policy', ...o });
const asAdmin = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' } as any;

// What Agrisynx will have configured.
const AGRI = {
  category_labels: { mileage: 'Travel' }, route_fields: false, single_line: true, odometer_camera_only: true,
};

describe('presentation rule keys: defaults', () => {
  it('reproduce today\'s behaviour when nothing is configured', () => {
    const r = rulesOf();
    expect(r.category_labels).toEqual({});
    expect(r.route_fields).toBe(true);
    expect(r.single_line).toBe(false);
    expect(r.odometer_camera_only).toBe(false);
  });
  it('are always present in the rules the apps receive', () => {
    const shaped = policy.toClientShape(pol());
    expect(shaped.rules).toMatchObject({ category_labels: {}, route_fields: true, single_line: false, odometer_camera_only: false });
  });
  it('carry the Agrisynx values through normalisation', () => {
    const r = rulesOf(AGRI);
    expect(r).toMatchObject(AGRI);
    expect(policy.toClientShape(pol({ rules: r })).rules).toMatchObject(AGRI);
  });
  it('are stable under repeated normalisation (every save re-normalises)', () => {
    const once = rulesOf(AGRI);
    expect(rulesOf(once)).toEqual(once);
  });
  it('only switch on for a real boolean', () => {
    expect(rulesOf({ single_line: 'true', odometer_camera_only: 1 })).toMatchObject({ single_line: false, odometer_camera_only: false });
    expect(rulesOf({ route_fields: 0, odometer_camera_only: true }).route_fields).toBe(true); // only an explicit false hides them
    expect(rulesOf({ route_fields: false }).route_fields).toBe(false);
  });
});

describe('category labels', () => {
  it('are trimmed, and a blank label means "no label"', () => {
    expect(policy.normalizeCategoryLabels({ mileage: '  Travel  ', food: '   ', fuel: '' })).toEqual({ mileage: 'Travel' });
  });
  it('keep known categories only', () => {
    expect(policy.normalizeCategoryLabels({ mileage: 'Travel', rocket: 'Zoom', constructor: 'x', __proto__: 'y' })).toEqual({ mileage: 'Travel' });
  });
  it('ignore anything that is not a string, and anything that is not an object', () => {
    expect(policy.normalizeCategoryLabels({ mileage: 7, food: null, fuel: ['x'] })).toEqual({});
    for (const bad of [null, undefined, 'Travel', 5, ['mileage']]) expect(policy.normalizeCategoryLabels(bad)).toEqual({});
  });
  it('are capped at 30 characters', () => {
    const out = policy.normalizeCategoryLabels({ mileage: 'x'.repeat(31) });
    expect(out.mileage).toHaveLength(30);
    expect(policy.normalizeCategoryLabels({ mileage: 'y'.repeat(30) }).mileage).toHaveLength(30);
  });
});

describe('the server does not enforce the presentation keys', () => {
  const lines = [
    { id: 'a', category: 'mileage', amount: 100, distance_km: 10, item_date: new Date().toISOString().slice(0, 10) },
    { id: 'b', category: 'mileage', amount: 120, distance_km: 12, item_date: new Date().toISOString().slice(0, 10), from_location: null, to_location: null },
  ];
  it('a single_line policy still accepts a claim with several lines', () => {
    const base = policy.evaluateAgainstPolicy(pol({ rules: rulesOf() }), lines).violations.map((v) => v.code);
    const agri = policy.evaluateAgainstPolicy(pol({ rules: rulesOf(AGRI) }), lines).violations.map((v) => v.code);
    expect(agri).toEqual(base);
  });
  it('category_not_allowed still works exactly as before (disabled categories are blocked)', () => {
    const r = rulesOf({ ...AGRI, categories: { food: { enabled: false } } });
    const v = policy.evaluateAgainstPolicy(pol({ rules: r }), [{ id: 'f', category: 'food', amount: 50, item_date: new Date().toISOString().slice(0, 10) }]).violations;
    expect(v.find((x) => x.code === 'category_not_allowed')).toMatchObject({ blocking: true, severity: 'high', item_id: 'f' });
  });
});

describe('an admin save keeps the presentation keys the editor did not send', () => {
  it('mergeUiRuleKeys: omitted keys keep their stored value, sent ones win', () => {
    const stored = rulesOf(AGRI);
    const merged = policy.mergeUiRuleKeys({ mileage_rate: 9 }, stored);
    expect(merged).toMatchObject({ mileage_rate: 9, ...AGRI });
    const overridden = policy.mergeUiRuleKeys({ route_fields: true, category_labels: {}, single_line: false }, stored);
    expect(overridden).toMatchObject({ route_fields: true, category_labels: {}, single_line: false, odometer_camera_only: true });
  });
  it('mergeUiRuleKeys: no rules sent keeps the stored ones; a create has nothing to merge', () => {
    const stored = rulesOf(AGRI);
    expect(policy.mergeUiRuleKeys(undefined, stored)).toBe(stored);
    expect(policy.mergeUiRuleKeys({ mileage_rate: 9 }, undefined)).toEqual({ mileage_rate: 9 });
    expect(policy.mergeUiRuleKeys(undefined, undefined)).toBeUndefined();
  });

  const row = (rules: any) => ({
    id: POLICY_ID, org_id: ORG, client_id: CLIENT, name: 'Agri policy', description: null, is_active: true, priority: 100,
    currency: 'INR', applies_to: { everyone: true }, effective_from: null, effective_to: null, deleted_at: null, rules,
  });
  const written = () => __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));

  beforeEach(() => { __mock.reset(); });

  it('updatePolicy with an old-style full `rules` (no new keys) keeps labels, single line, camera-only and route fields', async () => {
    __mock.setDefault('expense_policies', { data: [row(rulesOf(AGRI))] });
    // an editor from before these keys existed: sends every rule it knows, nothing else
    const oldEditorRules = { mileage_rate: 11, receipt_required_over: 400, enforcement: 'flag', categories: { food: { enabled: false } } };
    await policy.updatePolicy(asAdmin, POLICY_ID, { rules: oldEditorRules });
    expect(written()).toHaveLength(1);
    expect(written()[0].rules).toMatchObject({ mileage_rate: 11, receipt_required_over: 400, ...AGRI });
    expect(written()[0].rules.categories.food.enabled).toBe(false);
  });

  it('updatePolicy that does not send `rules` at all leaves every rule alone', async () => {
    __mock.setDefault('expense_policies', { data: [row(rulesOf(AGRI))] });
    await policy.updatePolicy(asAdmin, POLICY_ID, { name: 'Agri policy 2' });
    expect(written()[0].rules).toMatchObject(AGRI);
  });

  it('updatePolicy lets an admin change them on purpose, and clear the labels with {}', async () => {
    __mock.setDefault('expense_policies', { data: [row(rulesOf(AGRI))] });
    await policy.updatePolicy(asAdmin, POLICY_ID, { rules: { single_line: false, category_labels: {} } });
    expect(written()[0].rules).toMatchObject({ single_line: false, category_labels: {}, route_fields: false, odometer_camera_only: true });
  });

  it('createPolicy stores what is sent, and defaults the rest', async () => {
    __mock.setDefault('expense_policies', { data: [row(rulesOf(AGRI))] });
    await policy.createPolicy(asAdmin, { name: 'New', rules: { single_line: true } });
    const insert = __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any))[0];
    expect(insert.rules).toMatchObject({ single_line: true, route_fields: true, odometer_camera_only: false, category_labels: {} });
  });

  it('a duplicate carries them over', async () => {
    __mock.setDefault('expense_policies', { data: [row(rulesOf(AGRI))] });
    await policy.duplicatePolicy(asAdmin, POLICY_ID);
    const insert = __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any))[0];
    expect(insert.rules).toMatchObject(AGRI);
  });

  it('the legacy single-policy save (PUT /policy) keeps them', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const svc = require('../src/services/expenses/expenses.service') as typeof import('../src/services/expenses/expenses.service');
    __mock.setDefault('expense_policies', { data: [{ ...row(rulesOf(AGRI)), name: 'Default policy' }] });
    __mock.setDefault('users', { data: [] });
    await svc.saveDefaultPolicy(asAdmin, { mileage_rate: 15 });
    expect(written()[0].rules).toMatchObject({ mileage_rate: 15, ...AGRI });
  });
});

// ── through the real router ──────────────────────────────────────────────────
describe('the policy API', () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = req.headers['x-role'] === 'rep' ? { ...asAdmin, id: REP, role: 'executive' } : asAdmin; next(); });
  app.use('/expenses', expensesRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  beforeEach(() => {
    __mock.reset();
    __mock.setDefault('expense_policies', { data: [{
      id: POLICY_ID, org_id: ORG, client_id: CLIENT, name: 'Agri policy', is_active: true, priority: 100, currency: 'INR',
      applies_to: { everyone: true }, deleted_at: null, rules: rulesOf(AGRI),
    }] });
    __mock.setDefault('users', { data: [{ id: REP, role: 'executive', org_role_id: null, name: 'Asha' }] });
  });

  it('GET /expenses/policy hands the apps the keys in data.rules', async () => {
    const res = await request(app).get('/expenses/policy').set('x-role', 'rep');
    expect(res.status).toBe(200);
    expect(res.body.data.rules).toMatchObject(AGRI);
  });

  it('PUT /expenses/policies/:id accepts them', async () => {
    const res = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { ...AGRI, category_labels: { mileage: '  Travel ' } } });
    expect(res.status).toBe(200);
    const update = __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any))[0];
    expect(update.rules).toMatchObject(AGRI);
  });

  it('PUT /expenses/policies/:id with an old-style body keeps what is stored', async () => {
    const res = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { mileage_rate: 10 } });
    expect(res.status).toBe(200);
    const update = __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any))[0];
    expect(update.rules).toMatchObject({ mileage_rate: 10, ...AGRI });
  });

  it('refuses a category name over 30 characters, and wrongly typed switches', async () => {
    const long = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { category_labels: { mileage: 'x'.repeat(31) } } });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/30/);
    for (const k of ['route_fields', 'single_line', 'odometer_camera_only']) {
      const bad = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { [k]: 'yes' } });
      expect({ k, status: bad.status }).toEqual({ k, status: 400 });
    }
  });

  it('drops an unknown category name rather than failing, and treats a blank label as none', async () => {
    const res = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { category_labels: { mileage: 'Travel', rocket: 'Zoom', food: '  ' } } });
    expect(res.status).toBe(200);
    const update = __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any))[0];
    expect(update.rules.category_labels).toEqual({ mileage: 'Travel' });
  });
});
