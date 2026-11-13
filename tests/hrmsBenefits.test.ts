/**
 * HRMS phase 7 (the Benefits module on the server), driven over HTTP through the real router and services against the
 * in-memory PostgREST double (tests/helpers/hrmsFakeDb.ts, which also stands in for the three plpgsql functions
 * hrms_benefit_register_claim / hrms_benefit_move_claim / hrms_benefit_send_to_payroll). Covers the service layer: the
 * gate, scoping, the bootstrap shape, plan CRUD + idempotency, the enrolment upsert with the dashboard's eligibility /
 * window / dependant / flex refusals, claim register (ref assignment) + the move state machine with every refusal, the
 * send-to-payroll replace semantics + the frozen-run refusal + the exact ported deduction amounts, window extend +
 * reminders, and 503 HRMS_NOT_READY. The SQL itself (constraints, fks, the three functions end to end) is proven by the
 * PGlite harness named in the final report; the pure math is proven exactly in tests/hrmsBenefitsMath.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { logger } from '../src/lib/logger';

jest.mock('../src/lib/supabase', () => {
  const { createHrmsFakeDb } = require('./helpers/hrmsFakeDb');
  const db = createHrmsFakeDb();
  return { __db: db, supabaseAdmin: db.client, supabase: db.client, getUserClient: () => db.client };
});

import hrmsRouter from '../src/routes/hrms.routes';
import type { HrmsFakeDb, Row } from './helpers/hrmsFakeDb';
import { MASTER, ORG, OTHER_ORG, seedCompany, seedPeople, uid } from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/benefits';

let people: Record<string, Row>;
beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const t = (name: string): Row[] => (fake.tables[name] ??= []);
const ok = (res: request.Response, status = 200) => { expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined }); return res.body.data; };
const refused = (res: request.Response, status: number, code: string, error?: string | RegExp) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, code });
  if (typeof error === 'string') expect(res.body.error).toBe(error);
  else if (error) expect(res.body.error).toMatch(error);
};
const STAMP = { org_id: ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const COVER = '2026-01-01';

// ── the controlled plan catalogue (round numbers; same as the math test) ──────
const HEALTH = {
  kind: 'health', name: 'Group health', provider: 'Sample', auto: false,
  tiers: [{ id: 'h5', label: '5L', sumInsured: 500000, annualPremium: { self: 7200, spouse: 7200, child: 3600, parent: 12000 } }],
  employer_share_pct: { self: 100, spouse: 50, child: 50, parent: 0 },
  dependants: { maxSpouse: 1, maxChildren: 2, childMaxAge: 25, maxParents: 2, parentMaxAge: 80 },
  tax_note: 'indicative', cover_start: COVER, renews_on: '2026-12-31',
};
const ACCIDENT = { kind: 'accident', name: 'Group accident', provider: 'Sample', auto: true, tiers: [{ id: 'a10', label: '10L', annualPremium: { self: 1200 } }], employer_share_pct: { self: 100 }, tax_note: 'x', cover_start: COVER, renews_on: '2026-12-31' };
const MEAL = { kind: 'meal', name: 'Meal coupons', provider: 'Sample', auto: false, tiers: [{ id: 'm0', label: 'None', monthlyAmount: 0 }, { id: 'm1', label: '1200', monthlyAmount: 1200 }], employer_share_pct: { self: 0 }, tax_note: 'x', cover_start: COVER, renews_on: '2026-12-31' };

/** Push the plan catalogue straight into the table (the create PATH is tested separately). */
function seedPlans(org = ORG): void {
  const s = { org_id: org, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
  let n = 300;
  for (const p of [HEALTH, ACCIDENT, MEAL]) t('hrms_benefit_plans').push({ id: uid(++n, 'p'), flex_monthly: null, baskets: null, summary: '', auto: !!(p as any).auto, ...p, ...s });
}

const enrolBody = (over: Row = {}) => ({ employee_id: people.aarav!.id, status: 'enrolled', health_tier: 'h5', dependants: [], meal_tier: 'm1', flex: {}, ...over });
const submit = (over: Row = {}) => api().post(`${P}/enrolments`).send(enrolBody(over));
const AARAV_DEPS = [{ id: 'd1', name: 'Spouse A', relation: 'spouse', dob: '1985-01-01' }, { id: 'd2', name: 'Child A', relation: 'child', dob: '2015-01-01' }];

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use Benefits, and which rows it reaches', () => {
  const routes: Array<[string, string, any?]> = [
    ['get', '/bootstrap'],
    ['post', '/plans', {}], ['put', `/plans/${uid(1)}`, {}], ['delete', `/plans/${uid(1)}`],
    ['post', '/enrolments', {}], ['delete', `/enrolments/${uid(1)}`],
    ['post', '/claims', {}], ['post', `/claims/${uid(1)}/move`, {}],
    ['put', '/window', {}], ['post', '/window/extend', {}], ['post', '/reminders', {}], ['post', '/send-to-payroll', {}],
  ];
  const callEach = async () => {
    const out: number[] = [];
    for (const [m, p, body] of routes) out.push((await (api() as any)[m](`${P}${p}`).send(body)).status);
    return out;
  };

  it('answers 403 to anyone but the master admin as themselves, on every route, and never reaches the database', async () => {
    for (const who of [
      { ...MASTER, email: 'someone@example.com' },
      { ...MASTER, impersonated_by: { id: 'x' } },
      { ...MASTER, acting_as_org: OTHER_ORG },
      { id: 'c', org_id: ORG, email: 'ops@client.com', role: 'admin', client_id: 'c1', enabled_modules: ['finance', 'hrms'] },
    ]) {
      fake.log.length = 0; fake.rpcLog.length = 0; user = who;
      expect(await callEach()).toEqual(routes.map(() => 403));
      expect(fake.log).toHaveLength(0);
      expect(fake.rpcLog).toHaveLength(0);
    }
  });

  it('answers 401 with no user', async () => {
    user = undefined;
    expect((await api().get(`${P}/bootstrap`)).status).toBe(401);
  });

  it('scopes every select on org_id and client_id IS NULL, and the atomic functions carry the org', async () => {
    seedPlans();
    await submit({ dependants: AARAV_DEPS });
    await api().post(`${P}/claims`).send({ employee_id: people.aarav!.id, patient: 'Self', relation: 'self', kind: 'cashless', hospital: 'City Care', claimed: 20000 });
    await api().get(`${P}/bootstrap`);
    const tables = ['hrms_benefit_plans', 'hrms_benefit_enrolments', 'hrms_benefit_claims', 'hrms_benefit_config'];
    const queries = fake.log.filter((q) => tables.includes(q.table) && q.op === 'select');
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const q of queries) {
      const eqOrg = q.filters.find((f) => f.t === 'eq' && f.col === 'org_id');
      const nullClient = q.filters.find((f) => f.t === 'is' && f.col === 'client_id' && f.val === null);
      expect({ table: q.table, org: eqOrg?.val, clientNull: !!nullClient }).toEqual({ table: q.table, org: ORG, clientNull: true });
    }
    for (const call of fake.rpcLog.filter((c) => c.name.startsWith('hrms_benefit_'))) expect(call.args.p_org).toBe(ORG);
  });

  it('ignores X-Client-Id entirely; every written row carries client_id NULL', async () => {
    const CLIENT = '99999999-9999-4999-8999-999999999999';
    seedPlans();
    await submit({ dependants: AARAV_DEPS }).set('X-Client-Id', CLIENT);
    await api().post(`${P}/send-to-payroll`).send({ month: '2026-11' }).set('X-Client-Id', CLIENT);
    for (const q of fake.log) expect(JSON.stringify(q.filters)).not.toContain(CLIENT);
    for (const tbl of ['hrms_benefit_enrolments', 'hrms_benefit_config', 'hrms_adjustments']) for (const r of t(tbl)) expect(r.client_id).toBeNull();
  });

  it("never sees another org's benefits, and a command on another org's row is a 404", async () => {
    const other = { org_id: OTHER_ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
    t('hrms_benefit_plans').push({ id: uid(81, 'b'), kind: 'health', name: 'Theirs', summary: '', provider: 'x', auto: false, tiers: [], employer_share_pct: {}, dependants: null, flex_monthly: null, baskets: null, tax_note: '', cover_start: COVER, renews_on: '2026-12-31', ...other });
    seedPlans();
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(b.plans.every((p: Row) => p.name !== 'Theirs')).toBe(true);
    refused(await api().put(`${P}/plans/${uid(81, 'b')}`).send({ name: 'Hacked' }), 404, 'NOT_FOUND', 'That plan is not in the catalogue.');
    expect(t('hrms_benefit_plans').find((r) => r.id === uid(81, 'b'))!.name).toBe('Theirs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bootstrap', () => {
  it('returns the documented keys; a new org is empty with a default window', async () => {
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(Object.keys(b).sort()).toEqual(['claims', 'enrolments', 'plans', 'reminders', 'sent', 'server_time', 'window']);
    expect([b.plans.length, b.enrolments.length, b.claims.length]).toEqual([0, 0, 0]);
    expect(Object.keys(b.window).sort()).toEqual(['closes_on', 'extensions', 'opens_on']);
    expect(b.window.opens_on <= b.window.closes_on).toBe(true);
    expect([b.reminders, b.sent]).toEqual([{}, {}]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('plans (POST|PUT|DELETE /plans[/:id])', () => {
  it('creates a plan with the exact wire shape and the nested camelCase pass-through', async () => {
    const plan = ok(await api().post(`${P}/plans`).send(HEALTH), 201);
    expect(Object.keys(plan).sort()).toEqual(['auto', 'baskets', 'cover_start', 'created_at', 'dependants', 'employer_share_pct', 'flex_monthly', 'id', 'kind', 'name', 'provider', 'renews_on', 'summary', 'tax_note', 'tiers', 'updated_at'].sort());
    expect(plan).toMatchObject({ kind: 'health', name: 'Group health', cover_start: COVER, renews_on: '2026-12-31', flex_monthly: null, baskets: null });
    expect(plan.tiers[0]).toMatchObject({ id: 'h5', label: '5L', sumInsured: 500000, annualPremium: { self: 7200, spouse: 7200, child: 3600, parent: 12000 } });
    expect(plan.employer_share_pct).toEqual({ self: 100, spouse: 50, child: 50, parent: 0 });
    expect(plan.dependants).toEqual({ maxSpouse: 1, maxChildren: 2, childMaxAge: 25, maxParents: 2, parentMaxAge: 80 });
  });

  it('POST /plans/:id creates with the path id and is idempotent (200 with the same row)', async () => {
    const CID = 'aaaa0000-0000-4000-8000-000000000055';
    const a = ok(await api().post(`${P}/plans/${CID}`).send(HEALTH), 201);
    expect(a.id).toBe(CID);
    const again = ok(await api().post(`${P}/plans/${CID}`).send({ ...HEALTH, name: 'Changed' }), 200);
    expect([again.id, again.name]).toEqual([CID, 'Group health']);
    expect(t('hrms_benefit_plans')).toHaveLength(1);
  });

  it('updates partially and clears a nullable field, and deletes', async () => {
    const flex = ok(await api().post(`${P}/plans`).send({ kind: 'flex', name: 'Flex', provider: 'x', tiers: [], employer_share_pct: { self: 100 }, flex_monthly: 2500, baskets: [{ id: 'learning', label: 'Learning' }], tax_note: 'x', cover_start: COVER, renews_on: '2026-12-31' }), 201);
    const up = ok(await api().put(`${P}/plans/${flex.id}`).send({ flex_monthly: 3000, dependants: null }));
    expect([up.flex_monthly, up.dependants, up.name]).toEqual([3000, null, 'Flex']);
    ok(await api().delete(`${P}/plans/${flex.id}`));
    expect(t('hrms_benefit_plans')).toHaveLength(0);
  });

  it('validates the kind enum and a non-empty name', async () => {
    refused(await api().post(`${P}/plans`).send({ ...HEALTH, kind: 'dental' }), 400, 'VALIDATION');
    refused(await api().post(`${P}/plans`).send({ ...HEALTH, name: '   ' }), 400, 'VALIDATION', 'Enter a name for the plan.');
    refused(await api().put(`${P}/plans/${uid(9)}`).send({ name: 'x' }), 404, 'NOT_FOUND', 'That plan is not in the catalogue.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('enrolments (submitEnrolment, upsert by employee)', () => {
  beforeEach(() => seedPlans());

  it('enrols a person and upserts by employee (one row, replaced on re-submit)', async () => {
    const en = ok(await submit({ dependants: AARAV_DEPS, meal_tier: 'm1' }));
    expect(en).toMatchObject({ employee_id: people.aarav!.id, status: 'enrolled', health_tier: 'h5', meal_tier: 'm1', by: MASTER.name });
    expect(en.dependants.map((d: Row) => [d.name, d.relation])).toEqual([['Spouse A', 'spouse'], ['Child A', 'child']]);
    const again = ok(await submit({ dependants: [], meal_tier: 'm0' }));
    expect([again.dependants.length, again.meal_tier]).toEqual([0, 'm0']);
    expect(t('hrms_benefit_enrolments').filter((r) => r.employee_id === people.aarav!.id)).toHaveLength(1);
  });

  it('a waiver stores no tiers / dependants / flex', async () => {
    const en = ok(await submit({ status: 'waived', dependants: AARAV_DEPS, meal_tier: 'm1', flex: { x: 100 } }));
    expect(en).toMatchObject({ status: 'waived', health_tier: null, meal_tier: null, nps_tier: null });
    expect([en.dependants, en.flex]).toEqual([[], {}]);
  });

  it('refuses with the dashboard words: eligibility, window closed, health tier, dependant and flex rules', async () => {
    refused(await submit({ employee_id: uid(777) }), 400, 'VALIDATION', 'Choose an employee.');
    refused(await submit({ employee_id: people.fay!.id }), 400, 'VALIDATION', 'Has not joined yet; enrols in the first week after joining.');
    refused(await submit({ health_tier: 'nope' }), 400, 'VALIDATION', 'Choose a health cover amount, or choose to opt out.');
    refused(await submit({ dependants: [{ name: 'A', relation: 'spouse', dob: '1985-01-01' }, { name: 'B', relation: 'spouse', dob: '1986-01-01' }] }), 400, 'VALIDATION', 'This plan covers 1 spouse at most.');
    // window closed in the past
    ok(await api().put(`${P}/window`).send({ opens_on: '2020-01-01', closes_on: '2020-01-10' }));
    refused(await submit({ dependants: AARAV_DEPS }), 400, 'VALIDATION', 'The enrolment window is closed. HR can extend it.');
  });

  it('refuses a flex allocation that breaks the plan rules (needs a flex plan)', async () => {
    t('hrms_benefit_plans').push({ id: uid(350, 'p'), kind: 'flex', name: 'Flex', summary: '', provider: 'x', auto: false, tiers: [], employer_share_pct: { self: 100 }, dependants: null, flex_monthly: 2500, baskets: [{ id: 'learning', label: 'L' }], tax_note: 'x', cover_start: COVER, renews_on: '2026-12-31', ...STAMP });
    refused(await submit({ flex: { learning: 300 } }), 400, 'VALIDATION', 'Use multiples of 250.');
  });

  it('clears a pending reminder for the person on enrolment, and can clear the enrolment', async () => {
    ok(await api().post(`${P}/reminders`).send({ employee_ids: [people.aarav!.id, people.bela!.id] }));
    await submit({ dependants: AARAV_DEPS });
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(Object.keys(b.reminders)).toEqual([people.bela!.id]); // aarav's reminder cleared
    ok(await api().delete(`${P}/enrolments/${people.aarav!.id}`));
    expect(t('hrms_benefit_enrolments')).toHaveLength(0);
    refused(await api().delete(`${P}/enrolments/${people.bela!.id}`), 404, 'NOT_FOUND', 'That person has no enrolment.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('claims (registerClaim + the CLAIM_NEXT state machine)', () => {
  beforeEach(async () => { seedPlans(); await submit({ dependants: AARAV_DEPS }); });
  const register = (over: Row = {}) => api().post(`${P}/claims`).send({ employee_id: people.aarav!.id, patient: 'Self', relation: 'self', kind: 'cashless', hospital: 'City Care', claimed: 50000, ...over });
  const move = (id: string, over: Row = {}) => api().post(`${P}/claims/${id}/move`).send(over);

  it('registers a claim, assigns the TPA ref by count, and opens the trail', async () => {
    const { claim } = ok(await register(), 201);
    expect(claim).toMatchObject({ employee_id: people.aarav!.id, patient: 'Self', relation: 'self', kind: 'cashless', hospital: 'City Care', claimed: 50000, status: 'submitted', ref: 'TPA-26-04141', approved: null, closed_on: null });
    expect(claim.trail).toEqual([{ on: expect.any(String), status: 'submitted', note: 'Claim registered.', by: MASTER.name }]);
    const second = ok(await register({ patient: 'Child A', relation: 'child', claimed: 9000 }), 201);
    expect(second.claim.ref).toBe('TPA-26-04178'); // 4100 + 1*37 + 41
  });

  it('refuses register with the dashboard words', async () => {
    refused(await register({ employee_id: people.bela!.id }), 400, 'VALIDATION', 'Only an enrolled employee can claim.');
    refused(await register({ hospital: '  ' }), 400, 'VALIDATION', 'Enter the hospital or clinic.');
    refused(await register({ claimed: 0 }), 400, 'VALIDATION', 'Enter the amount claimed.');
    refused(await register({ patient: 'Nobody', relation: 'child' }), 400, 'VALIDATION', 'The patient is not covered under this enrolment.');
  });

  it('runs a full approval path with the trail growing, then an illegal move is refused', async () => {
    const { claim } = ok(await register(), 201);
    let r = ok(await move(claim.id, { to: 'in_review', note: 'Checking' }));
    expect(r.claim.status).toBe('in_review');
    r = ok(await move(claim.id, { to: 'approved', approved: 40000, note: 'OK' }));
    expect(r.claim).toMatchObject({ status: 'approved', approved: 40000, closed_on: null });
    r = ok(await move(claim.id, { to: 'settled', note: 'Paid' }));
    expect(r.claim).toMatchObject({ status: 'settled', closed_on: expect.any(String) });
    expect(r.claim.trail.map((x: Row) => x.status)).toEqual(['submitted', 'in_review', 'approved', 'settled']);
    refused(await move(claim.id, { to: 'in_review' }), 409, 'CLAIM_STATE', 'A claim that is settled cannot move to in review.');
  });

  it('enforces the approved amount, the rejection reason and the reopen reply', async () => {
    const { claim } = ok(await register(), 201);
    refused(await move(claim.id, { to: 'settled' }), 409, 'CLAIM_STATE', 'A claim that is submitted cannot move to settled.');
    await move(claim.id, { to: 'in_review' });
    refused(await move(claim.id, { to: 'approved', approved: 60000 }), 400, 'VALIDATION', 'Enter an approved amount that is more than 0 and not more than the amount claimed.');
    refused(await move(claim.id, { to: 'rejected' }), 400, 'VALIDATION', 'A rejection needs a reason, so the employee can reply.');
    const rej = ok(await move(claim.id, { to: 'rejected', reason: 'Not covered under the plan' }));
    expect(rej.claim).toMatchObject({ status: 'rejected', rejection_reason: 'Not covered under the plan', approved: null, closed_on: expect.any(String) });
    refused(await move(claim.id, { to: 'in_review' }), 400, 'VALIDATION', "Write the employee's reply or the reason for the review.");
    const re = ok(await move(claim.id, { to: 'in_review', note: 'Employee sent the missing bills' }));
    expect(re.claim).toMatchObject({ status: 'in_review', closed_on: null, rejection_reason: null });
  });

  it('a move on an unknown claim is a 404', async () => {
    refused(await move(uid(404), { to: 'in_review' }), 404, 'NOT_FOUND', 'That claim is not in the tracker.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('send-to-payroll (the ported deduction amounts + replace semantics + the frozen-run refusal)', () => {
  const MONTH = '2026-11';
  beforeEach(async () => {
    seedPlans();
    await submit({ dependants: AARAV_DEPS, meal_tier: 'm1' });                       // Aarav -> 1650
    await api().post(`${P}/enrolments`).send({ employee_id: people.bela!.id, status: 'enrolled', health_tier: 'h5', dependants: [{ id: 'k', name: 'Kid B', relation: 'child', dob: '2016-01-01' }], meal_tier: 'm1', flex: {} }); // Bela -> 1350
  });
  const adj = () => t('hrms_adjustments');
  const benefitRows = () => adj().filter((a) => String(a.note ?? '').startsWith('[benefits '));

  it('creates one-time deductions with the exact ported amounts and records the send', async () => {
    const r = ok(await api().post(`${P}/send-to-payroll`).send({ month: MONTH }));
    expect(r).toEqual({ removed: 0, added: 2, total: 3000 });
    const rows = benefitRows().sort((a, b) => Number(a.amount) - Number(b.amount));
    expect(rows.map((a) => [Number(a.amount), a.kind, a.taxable, a.month])).toEqual([[1350, 'one_time_deduction', false, MONTH], [1650, 'one_time_deduction', false, MONTH]]);
    expect(rows.every((a) => String(a.note).startsWith('[benefits 2026-11] '))).toBe(true);
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(b.sent[MONTH]).toMatchObject({ rows: 2, total: 3000, by: MASTER.name, on: expect.any(String) });
  });

  it('replaces an earlier send and leaves a non-benefits adjustment of the same month untouched', async () => {
    const keep = { id: uid(900, 'k'), employee_id: people.aarav!.id, month: MONTH, kind: 'bonus', amount: 5000, taxable: true, note: 'Diwali bonus', source: null, created_by: 'x', ...STAMP };
    t('hrms_adjustments').push(keep);
    await api().post(`${P}/send-to-payroll`).send({ month: MONTH });
    const r2 = ok(await api().post(`${P}/send-to-payroll`).send({ month: MONTH }));
    expect(r2).toEqual({ removed: 2, added: 2, total: 3000 });
    expect(benefitRows()).toHaveLength(2);
    expect(adj().find((a) => a.id === uid(900, 'k'))).toMatchObject({ kind: 'bonus', amount: 5000 }); // untouched
  });

  it('refuses while the month pay run is frozen or paid', async () => {
    t('hrms_pay_runs').push({ id: uid(950, 'r'), entity_id: uid(1), month: MONTH, type: 'regular', status: 'frozen', ...STAMP });
    refused(await api().post(`${P}/send-to-payroll`).send({ month: MONTH }), 409, 'RUN_LOCKED', 'The payroll run for 2026-11 is frozen or paid, so its adjustments are locked.');
    expect(benefitRows()).toHaveLength(0); // nothing written
  });

  it('refuses when no health plan is set up', async () => {
    fake.tables.hrms_benefit_plans = [];
    refused(await api().post(`${P}/send-to-payroll`).send({ month: MONTH }), 400, 'VALIDATION', 'No health plan is set up.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('window + reminders', () => {
  it('sets the window, extends it, and logs reminders', async () => {
    ok(await api().put(`${P}/window`).send({ opens_on: '2026-11-01', closes_on: '2026-11-20' }));
    const ext = ok(await api().post(`${P}/window/extend`).send({ days: 5, reason: 'More time for the field team' }));
    expect(ext.window.extensions).toEqual([{ on: expect.any(String), days: 5, reason: 'More time for the field team', by: MASTER.name }]);
    // the close date moved out by 5 days from the later of today and the old close
    expect(ext.window.closes_on > '2026-11-20' || ext.window.closes_on >= new Date().toISOString().slice(0, 10)).toBe(true);
    refused(await api().post(`${P}/window/extend`).send({ days: 40, reason: 'x' }), 400, 'VALIDATION', 'Extend by 1 to 30 days.');
    refused(await api().post(`${P}/window/extend`).send({ days: 5, reason: '  ' }), 400, 'VALIDATION', 'Write a short reason for the extension.');

    const rem = ok(await api().post(`${P}/reminders`).send({ employee_ids: [people.aarav!.id, people.bela!.id] }));
    expect(rem.count).toBe(2);
    expect(Object.keys(rem.reminders).sort()).toEqual([people.aarav!.id, people.bela!.id].sort());
    refused(await api().post(`${P}/reminders`).send({ employee_ids: [] }), 400, 'VALIDATION', 'Nobody is waiting to enrol.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('503 when the benefit tables are not there yet', () => {
  it('answers HRMS_NOT_READY on bootstrap, plans, enrolments, claims and send-to-payroll', async () => {
    seedPlans();
    fake.missing.add('hrms_benefit_plans');
    refused(await api().get(`${P}/bootstrap`), 503, 'HRMS_NOT_READY', 'HRMS storage is not set up yet');
    refused(await api().post(`${P}/plans`).send(HEALTH), 503, 'HRMS_NOT_READY');
    fake.missing.add('hrms_benefit_enrolments');
    refused(await submit(), 503, 'HRMS_NOT_READY');
    fake.missing.add('hrms_benefit_claims');
    refused(await api().post(`${P}/claims`).send({ employee_id: people.aarav!.id, patient: 'Self', relation: 'self', kind: 'cashless', hospital: 'X', claimed: 100 }), 503, 'HRMS_NOT_READY');
    refused(await api().post(`${P}/send-to-payroll`).send({ month: '2026-11' }), 503, 'HRMS_NOT_READY');
  });
});
