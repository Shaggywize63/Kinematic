/**
 * HRMS phase 2 (payroll on the server), driven over HTTP through the real router and services against an in-memory PostgREST double
 * (tests/helpers/hrmsFakeDb.ts). The double applies filters, unique indexes, jsonb key ordering and the plpgsql functions' behaviour, and
 * records every query, so these tests assert WHAT came back and WHAT was asked (every query in the caller's org with client_id NULL).
 *
 * The engine's numbers are proven by tests/hrmsPayrollParity.test.ts; the SQL (constraints, freeze / unfreeze atomicity) by the PGlite
 * proofs. This file covers the service layer: the gate, scoping, validation, every business rule and refusal (with the dashboard's words),
 * idempotent creates, stale detection, compute replacing payslips, freeze / unfreeze bookkeeping, F&F, settings, 503.
 * The bank file has its own file (tests/hrmsPayrollBank.test.ts).
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
import {
  addWorkingDays, computeFnf, computePayRunPayslips, LAW_VERSION, preRunChecks,
} from '../src/services/hrms/payroll/engine';
import { canonical, inputFingerprint } from '../src/services/hrms/payroll/fingerprint';
import { looksMaskedAccount, looksMaskedPan } from '../src/services/hrms/payroll/engine/masking';
import { looksMaskedAccount as serverMaskedAccount, looksMaskedPan as serverMaskedPan } from '../src/lib/hrmsCrypto';
import type { HrmsFakeDb, Row } from './helpers/hrmsFakeDb';
import {
  ACCOUNT, golden, IDS, MASTER, ORG, OTHER_ORG, seedCompany, seedEmployee, seedPeople, uid,
} from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/payroll';
const M = '2026-10';

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
const attendance = (empId: string, month: string, over: Row = {}) => ({
  id: uid(900 + t('hrms_attendance').length, 'd'), org_id: ORG, client_id: null, employee_id: empId, month, days_in_month: 31, present_days: 31, paid_leave_days: 0, weekly_offs: 0, holidays: 0,
  lop_days: 0, overtime_hours: 0, locked: false, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...over,
});
const seedAttendance = (empId: string, month: string, over: Row = {}) => { const r = attendance(empId, month, over); (fake.tables.hrms_attendance ??= []).push(r); return r; };
const mkRun = async (month = M, entity = IDS.ENT, type = 'regular') => ok(await api().post(`${P}/runs`).send({ entity_id: entity, month, type }), 201);
const compute = async (id: string) => ok(await api().post(`${P}/runs/${id}/compute`));
const freeze = async (id: string) => ok(await api().post(`${P}/runs/${id}/freeze`));
const getRun = async (id: string) => ok(await api().get(`${P}/runs/${id}`));
const stored = (table: string, id: string) => t(table).find((r) => r.id === id)!;

/** The whole scenario up to a computed run: some attendance, a bonus, two loans. */
async function computedRun() {
  seedAttendance(people.aarav!.id, M, { lop_days: 2 });
  seedAttendance(people.chitra!.id, M, { lop_days: 1.5, overtime_hours: 18 });
  const bonus = ok(await api().post(`${P}/adjustments`).send({ employee_id: people.aarav!.id, month: M, kind: 'bonus', amount: 25000, taxable: true, note: 'Diwali' }), 201);
  const loan1 = ok(await api().post(`${P}/loans`).send({ employee_id: people.aarav!.id, kind: 'loan', principal: 50000, emi: 12000, start_month: '2026-08' }), 201);
  stored('hrms_loans', loan1.id).recovered = 41000;
  const loan2 = ok(await api().post(`${P}/loans`).send({ employee_id: people.aarav!.id, kind: 'advance', principal: 10000, emi: 5000, start_month: M }), 201);
  const run = await mkRun();
  return { run: await compute(run.id), bonus, loan1, loan2 };
}

/** Every query on an hrms_ table filters org_id = the caller's org AND client_id IS NULL; every insert stamps both; every rpc names the org. */
function assertEveryQueryScoped(atLeast: number, org = ORG) {
  const queries = fake.log.filter((q) => q.table.startsWith('hrms_'));
  expect(queries.length).toBeGreaterThanOrEqual(atLeast);
  for (const q of queries) {
    if (q.op === 'insert' || q.op === 'upsert') {
      for (const r of q.rows!) expect(r).toMatchObject({ org_id: org, client_id: null });
    } else {
      const eqOrg = q.filters.find((f) => f.t === 'eq' && f.col === 'org_id');
      const nullClient = q.filters.find((f) => f.t === 'is' && f.col === 'client_id' && f.val === null);
      expect({ table: q.table, op: q.op, org: eqOrg?.val, clientNull: !!nullClient }).toEqual({ table: q.table, op: q.op, org, clientNull: true });
    }
  }
  expect(fake.rpcLog.length).toBeGreaterThan(0);
  expect(fake.rpcLog.every((c) => c.args.p_org === org)).toBe(true);
}

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use payroll, and which rows it reaches', () => {
  const routes: Array<[string, string, any?]> = [
    ['get', '/bootstrap'], ['post', '/structures', {}], ['put', `/attendance/${uid(1)}/${M}`, {}], ['post', '/adjustments', {}], ['post', '/loans', {}],
    ['post', '/runs', {}], ['get', '/runs'], ['get', `/runs/${uid(1)}`], ['post', `/runs/${uid(1)}/compute`], ['post', `/runs/${uid(1)}/freeze`],
    ['post', `/runs/${uid(1)}/unfreeze`, { reason: 'long enough' }], ['post', `/runs/${uid(1)}/mark-paid`], ['get', `/runs/${uid(1)}/checks`], ['get', `/runs/${uid(1)}/ecr`],
    ['get', `/runs/${uid(1)}/bank-file`], ['post', '/fnf', {}], ['get', `/fnf/${uid(1)}/compute`], ['put', '/settings/payroll', {}],
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
      { ...MASTER, acting_as_org: ORG_X() },
      { id: 'c', org_id: ORG, email: 'ops@client.com', role: 'admin', client_id: 'c1', enabled_modules: ['finance', 'hrms'] },
    ]) {
      fake.log.length = 0; user = who;
      expect(await callEach()).toEqual(routes.map(() => 403));
      expect(fake.log).toHaveLength(0);
      expect(fake.rpcLog).toHaveLength(0);
    }
  });
  function ORG_X() { return OTHER_ORG; }

  it('answers 401 with no user', async () => {
    user = undefined;
    expect((await api().get(`${P}/bootstrap`)).status).toBe(401);
  });

  it('filters every select / update / delete on org_id and client_id IS NULL, stamps every insert, and names the org in every rpc', async () => {
    const { run } = await computedRun();
    await freeze(run.id);
    await api().get(`${P}/bootstrap`);
    await api().get(`${P}/runs?month=${M}`);
    await api().get(`${P}/runs/${run.id}/checks`);
    await api().get(`${P}/runs/${run.id}/ecr`);
    await api().get(`${P}/runs/${run.id}/bank-file`);
    await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'a late correction' });
    await api().put(`${P}/attendance/${people.bela!.id}/${M}`).send({ overtime_hours: 4 });
    await api().post(`${P}/structures`).send({ name: 'Temp', effective_from: '2026-04-01', components: [{ code: 'BASIC', name: 'Basic', kind: 'earning', calc: { type: 'pct_ctc', value: 50 }, isWage: true }] });
    await api().put(`/hrms/employees/${people.aarav!.id}`).send({ pan: 'ABCPM1234F' });
    const f = ok(await api().post(`${P}/fnf`).send({ employee_id: people.dev!.id, last_working_date: '2026-11-30', notice_days_served: 0, leave_encash_days: 0 }), 201);
    await api().get(`${P}/fnf/${f.id}/compute`);
    await api().put(`${P}/settings/payroll`).send({ overtime_rule: { id: 'ot_std', name: 'Std', rateMultiplier: 2, quarterlyCapHours: 144, requiresConsent: true, minMinutes: 30, rateDivisor: 26, womenNightConsent: true, appliesTo: ['permanent'] } });
    assertEveryQueryScoped(60);
  });

  it('ignores X-Client-Id entirely', async () => {
    const CLIENT = '99999999-9999-4999-8999-999999999999';
    const { run } = await computedRun();
    await api().get(`${P}/bootstrap`).set('X-Client-Id', CLIENT);
    await api().post(`${P}/runs/${run.id}/freeze`).set('X-Client-Id', CLIENT);
    for (const q of fake.log) {
      expect(JSON.stringify(q.filters)).not.toContain(CLIENT);
      expect(JSON.stringify(q.rows ?? [])).not.toContain(CLIENT);
    }
    expect(JSON.stringify(fake.rpcLog)).not.toContain(CLIENT);
    for (const r of t('hrms_pay_runs')) expect(r.client_id).toBeNull();
  });

  it('does not see, change or delete another org\'s rows (404), and bootstrap shows none of them', async () => {
    const theirs = {
      structure: uid(31, 'b'), run: uid(32, 'b'), loan: uid(33, 'b'), adj: uid(34, 'b'), fnf: uid(35, 'b'), emp: uid(36, 'b'),
    };
    const stamp = { org_id: OTHER_ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
    t('hrms_structures').push({ id: theirs.structure, name: 'Theirs', description: null, effective_from: '2026-04-01', components: [], ...stamp });
    t('hrms_pay_runs').push({ id: theirs.run, entity_id: uid(37, 'b'), month: M, type: 'regular', status: 'frozen', frozen_at: 'x', loan_recoveries: {}, attendance_locked_for: [], input_fingerprint: 'f', ...stamp });
    t('hrms_loans').push({ id: theirs.loan, employee_id: theirs.emp, kind: 'loan', principal: 100, emi: 10, start_month: M, recovered: 0, ...stamp });
    t('hrms_adjustments').push({ id: theirs.adj, employee_id: theirs.emp, month: M, kind: 'bonus', amount: 5, taxable: true, ...stamp });
    t('hrms_fnf_cases').push({ id: theirs.fnf, employee_id: theirs.emp, last_working_date: '2026-11-30', due_by: '2026-12-02', status: 'draft', ...stamp });

    const boot = ok(await api().get(`${P}/bootstrap`));
    expect([boot.structures.length, boot.runs.length, boot.loans.length, boot.adjustments.length, boot.fnf_cases.length]).toEqual([3, 0, 0, 0, 0]);
    expect(JSON.stringify(boot)).not.toContain(OTHER_ORG);
    for (const [method, path, body] of [
      ['get', `/runs/${theirs.run}`], ['post', `/runs/${theirs.run}/compute`], ['post', `/runs/${theirs.run}/freeze`], ['post', `/runs/${theirs.run}/unfreeze`, { reason: 'not mine at all' }],
      ['post', `/runs/${theirs.run}/mark-paid`], ['get', `/runs/${theirs.run}/checks`], ['get', `/runs/${theirs.run}/bank-file`], ['put', `/structures/${theirs.structure}`, { name: 'Hacked' }],
      ['delete', `/structures/${theirs.structure}`], ['put', `/loans/${theirs.loan}`, { emi: 1 }], ['delete', `/loans/${theirs.loan}`], ['put', `/adjustments/${theirs.adj}`, { amount: 1 }],
      ['delete', `/adjustments/${theirs.adj}`], ['put', `/fnf/${theirs.fnf}`, { other_payments: 1 }], ['post', `/fnf/${theirs.fnf}/approve`], ['delete', `/fnf/${theirs.fnf}`], ['get', `/fnf/${theirs.fnf}/compute`],
    ] as Array<[string, string, any?]>) {
      const res = await (api() as any)[method](`${P}${path}`).send(body);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    // their employee cannot be given pay inputs, and a new run cannot be opened for their entity
    expect((await api().post(`${P}/loans`).send({ employee_id: theirs.emp, kind: 'loan', principal: 100, emi: 10, start_month: M })).body.error).toBe('Choose an employee');
    refused(await api().post(`${P}/runs`).send({ entity_id: uid(37, 'b'), month: M }), 400, 'VALIDATION', /Unknown legal entity/);
    expect((await api().put(`${P}/attendance/${theirs.emp}/${M}`).send({ lop_days: 1 })).status).toBe(404);
    expect(stored('hrms_structures', theirs.structure).name).toBe('Theirs');
    expect(stored('hrms_pay_runs', theirs.run).status).toBe('frozen');
  });

  it('sends Cache-Control: no-store and the { success, data } wrapper', async () => {
    const res = await api().get(`${P}/bootstrap`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ success: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('when the payroll tables do not exist yet', () => {
  it('answers 503 HRMS_NOT_READY, never a 500, on reads and writes', async () => {
    for (const table of ['hrms_structures', 'hrms_attendance', 'hrms_adjustments', 'hrms_loans', 'hrms_pay_runs', 'hrms_payslips', 'hrms_pay_run_audit', 'hrms_fnf_cases']) fake.missing.add(table);
    const calls: Array<[string, string, any?]> = [
      ['get', '/bootstrap'], ['get', '/runs'], ['post', '/runs', { entity_id: IDS.ENT, month: M }], ['post', '/structures', { name: 'X', effective_from: '2026-04-01', components: [{ code: 'BASIC', name: 'Basic', kind: 'earning', calc: { type: 'pct_ctc', value: 50 }, isWage: true }] }],
      ['put', `/attendance/${people.aarav!.id}/${M}`, { lop_days: 1 }], ['post', '/loans', { employee_id: people.aarav!.id, kind: 'loan', principal: 100, emi: 10, start_month: M }],
      ['post', '/adjustments', { employee_id: people.aarav!.id, month: M, kind: 'bonus', amount: 10, taxable: true }], ['post', '/fnf', { employee_id: people.dev!.id, last_working_date: '2026-11-30', notice_days_served: 0, leave_encash_days: 0 }],
    ];
    for (const [m, p, body] of calls) {
      const res = await (api() as any)[m](`${P}${p}`).send(body);
      expect({ p, status: res.status, code: res.body.code, error: res.body.error }).toEqual({ p, status: 503, code: 'HRMS_NOT_READY', error: 'HRMS storage is not set up yet' });
    }
  });

  it('maps a missing database function (compute / freeze / unfreeze / mark paid) and a Postgres undefined-table error the same way', async () => {
    const { run } = await computedRun();
    fake.missing.add('rpc:hrms_store_computed_run');
    expect((await api().post(`${P}/runs/${run.id}/compute`)).status).toBe(503);
    fake.missing.add('rpc:hrms_freeze_run');
    expect((await api().post(`${P}/runs/${run.id}/freeze`)).status).toBe(503);
    fake.fails.push({ table: 'hrms_loans', op: 'select', error: { code: '42P01', message: 'relation "hrms_loans" does not exist' }, times: 1 });
    expect((await api().get(`${P}/bootstrap`)).body.code).toBe('HRMS_NOT_READY');
  });

  it('keeps a real database failure as a generic 500 with no internals', async () => {
    fake.fails.push({ table: 'hrms_loans', op: 'insert', error: { code: 'XX000', message: 'connection to 10.0.3.7 refused' }, times: 1 });
    const res = await api().post(`${P}/loans`).send({ employee_id: people.aarav!.id, kind: 'loan', principal: 1000, emi: 100, start_month: M });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('10.0.3.7');
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bootstrap', () => {
  it('returns everything in one call: structures, attendance, adjustments, loans, runs with payslips, F&F cases, settings, server time', async () => {
    const { run } = await computedRun();
    const f = ok(await api().post(`${P}/fnf`).send({ employee_id: people.dev!.id, last_working_date: '2026-11-30', notice_days_served: 0, leave_encash_days: 0 }), 201);
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(Object.keys(b).sort()).toEqual(['adjustments', 'attendance', 'fnf_cases', 'loans', 'runs', 'server_time', 'settings', 'structures']);
    expect(b.structures.map((s: Row) => s.name).sort()).toEqual(['Field sales', 'Office staff', 'Warehouse & contract']);
    expect(Object.keys(b.structures[0]).sort()).toEqual(['components', 'created_at', 'description', 'effective_from', 'id', 'name', 'updated_at']);
    expect(b.attendance).toHaveLength(2);
    expect(Object.keys(b.attendance[0]).sort()).toEqual(['created_at', 'days_in_month', 'employee_id', 'holidays', 'id', 'locked', 'lop_days', 'month', 'overtime_hours', 'paid_leave_days', 'present_days', 'updated_at', 'weekly_offs']);
    expect(b.adjustments).toHaveLength(1);
    expect(Object.keys(b.adjustments[0]).sort()).toEqual(['amount', 'created_at', 'created_by', 'employee_id', 'id', 'kind', 'month', 'note', 'source', 'taxable', 'updated_at']);
    expect(b.loans).toHaveLength(2);
    expect(Object.keys(b.loans[0]).sort()).toEqual(['created_at', 'emi', 'employee_id', 'id', 'kind', 'note', 'principal', 'recovered', 'start_month', 'updated_at']);
    expect(b.fnf_cases.map((c: Row) => c.id)).toEqual([f.id]);
    expect(b.runs).toHaveLength(1);
    expect(b.runs[0]).toMatchObject({ id: run.id, status: 'computed', stale: false });
    expect(b.runs[0].payslips).toHaveLength(5);
    expect(b.settings.payroll.overtime_rule).toMatchObject({ id: 'ot_std', name: 'Standard overtime', rateMultiplier: 2, rateDivisor: 26, appliesTo: ['permanent', 'contract', 'daily_wage', 'fixed_term'] });
    expect(new Date(b.server_time).toISOString()).toBe(b.server_time);
    expect(JSON.stringify(b)).not.toMatch(/org_id|client_id|input_fingerprint/);
  });

  it('only reads the recent months of attendance, adjustments and runs (months=N), but all structures, loans and settlements', async () => {
    const mk = (m: string) => `${m}`;
    const current = new Date().toISOString().slice(0, 7);
    const back = (n: number) => { const d = new Date(`${current}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
    for (const n of [0, 5, 11, 12, 20]) {
      seedAttendance(people.aarav!.id, mk(back(n)));
      t('hrms_adjustments').push({ id: uid(700 + n, 'f'), org_id: ORG, client_id: null, employee_id: people.aarav!.id, month: back(n), kind: 'bonus', amount: 5, taxable: true, note: null, source: null, created_by: null, created_at: 'x', updated_at: 'x' });
      t('hrms_pay_runs').push({ id: uid(800 + n, 'f'), org_id: ORG, client_id: null, entity_id: IDS.ENT, month: back(n), type: 'regular', status: 'draft', loan_recoveries: {}, attendance_locked_for: [], input_fingerprint: null, created_at: 'x', updated_at: 'x' });
    }
    const wanted = (m: number) => [back(0), back(5), back(11)].concat(m >= 12 ? [back(12)] : []).sort();
    let b = ok(await api().get(`${P}/bootstrap`)); // default 12 months: this month and the 11 before it
    expect(b.attendance.map((a: Row) => a.month).sort()).toEqual(wanted(11));
    expect(b.runs.map((r: Row) => r.month).sort()).toEqual(wanted(11));
    expect(b.adjustments.map((a: Row) => a.month).sort()).toEqual(wanted(11));
    b = ok(await api().get(`${P}/bootstrap?months=13`));
    expect(b.runs.map((r: Row) => r.month).sort()).toEqual(wanted(12));
    b = ok(await api().get(`${P}/bootstrap?months=1`));
    expect(b.runs.map((r: Row) => r.month)).toEqual([back(0)]);
    expect(b.structures).toHaveLength(3);
  });

  it('refuses a months value outside 1 to 60', async () => {
    for (const bad of ['0', '61', 'x', '-3', '1.5']) refused(await api().get(`${P}/bootstrap?months=${bad}`), 400, 'VALIDATION');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('salary structures', () => {
  const basic = { code: 'BASIC', name: 'Basic', kind: 'earning', calc: { type: 'pct_ctc', value: 50 }, isWage: true, pfApplicable: true };
  const special = { code: 'SPECIAL', name: 'Special Allowance', kind: 'earning', calc: { type: 'balance', value: 0 } };
  const body = (over: Row = {}) => ({ name: 'Plant staff', description: 'Plant', effective_from: '2026-04-01', components: [basic, special], ...over });
  const msg = async (over: Row) => { const r = await api().post(`${P}/structures`).send(body(over)); expect(r.status).toBe(400); expect(r.body.code).toBe('VALIDATION'); return r.body.error as string; };

  it('creates (201) with the dashboard\'s flag defaults, server component ids and normalised codes; no tenant columns leave', async () => {
    const s = ok(await api().post(`${P}/structures`).send(body({ components: [{ ...basic, code: ' basic ', name: ' Basic ' }, special, { code: 'PF_ER', name: 'Employer PF', kind: 'employer', calc: { type: 'pf_employer', value: 99 } }] })), 201);
    expect(s).toMatchObject({ name: 'Plant staff', description: 'Plant', effective_from: '2026-04-01' });
    expect(s).not.toHaveProperty('org_id');
    expect(s.components[0]).toMatchObject({ code: 'BASIC', name: 'Basic', kind: 'earning', isWage: true, taxable: true, pfApplicable: true, esiApplicable: true, prorate: true, showInPayslip: true });
    expect(s.components[1]).toMatchObject({ calc: { type: 'balance', value: 0 }, isWage: false, taxable: true, pfApplicable: false });
    expect(s.components[2]).toMatchObject({ kind: 'employer', calc: { type: 'pf_employer', value: 12 }, taxable: false, esiApplicable: false, prorate: false });
    expect(new Set(s.components.map((c: Row) => c.id)).size).toBe(3);
    expect(s.components.every((c: Row) => typeof c.id === 'string' && c.id.length > 3)).toBe(true);
  });

  it('keeps the component ids the caller sends (employee overrides point at them)', async () => {
    const s = ok(await api().post(`${P}/structures`).send(body({ components: [{ ...basic, id: 'c_basic' }, { ...special, id: 'c_spl' }] })), 201);
    expect(s.components.map((c: Row) => c.id)).toEqual(['c_basic', 'c_spl']);
  });

  it('is idempotent on a client id: 200 with the row that exists, nothing written twice', async () => {
    const id = uid(55);
    ok(await api().post(`${P}/structures`).send(body({ id })), 201);
    const again = ok(await api().post(`${P}/structures`).send(body({ id, name: 'Changed' })), 200);
    expect(again.name).toBe('Plant staff');
    expect(t('hrms_structures').filter((s) => s.id === id)).toHaveLength(1);
  });

  it('refuses a structure the dashboard\'s validateStructure refuses, in its words', async () => {
    expect(await msg({ name: '   ' })).toBe('Give the structure a name.');
    expect(await msg({ effective_from: 'soon' })).toBe('Choose an effective-from date.');
    expect(await msg({ effective_from: '2026-02-31' })).toBe('Choose an effective-from date.');
    expect(await msg({ components: [] })).toBe('Add at least one component.');
    expect(await msg({ components: [special] })).toBe('A component with the code BASIC is required.');
    expect(await msg({ components: [{ ...basic, kind: 'employer', calc: { type: 'fixed', value: 5 } }, special] })).toBe('BASIC must be an earning.');
    expect(await msg({ components: [{ ...basic, isWage: false }, special] })).toBe('BASIC must be flagged as a wage.'); // isWage false is kept for an earning, so the rule fires
    expect(await msg({ components: [{ ...basic, calc: { type: 'balance' } }] })).toMatch(/BASIC cannot be the balancing component/);
    expect(await msg({ components: [basic, special, { ...special, code: 'OTHER', name: 'Other' }] })).toMatch(/Only one balancing component is allowed \(found SPECIAL, OTHER\)/);
    expect(await msg({ components: [basic, special, { code: 'BASIC', name: 'Again', kind: 'earning', calc: { type: 'fixed', value: 1 } }] })).toMatch(/Component codes must be unique \(repeated: BASIC\)/);
    expect(await msg({ components: [basic, { code: 'EXTRA', name: 'Extra', kind: 'earning', calc: { type: 'pct_ctc', value: 60 } }] })).toBe('Components that take a percent of CTC add up to 110%, which is more than 100%.');
    expect(await msg({ components: [basic, { code: 'TRAVEL', name: 'Travel', kind: 'earning', calc: { type: 'fixed', value: 2_000_000 } }] })).toMatch(/TRAVEL: More than ₹10,00,000 a month; check the amount/);
    expect(await msg({ components: [basic, { code: 'x', name: 'X', kind: 'earning', calc: { type: 'fixed', value: 1 } }] })).toMatch(/X: Use 2 to 20 capital letters, digits or underscores/);
    expect(await msg({ components: [basic, { code: 'REIMB', name: 'Reimb', kind: 'reimbursement', calc: { type: 'pct_ctc', value: 5 } }] })).toMatch(/REIMB: This calculation is not available for this kind/);
    expect(await msg({ components: [basic, { code: 'TRAVEL', name: 'Travel', kind: 'earning', calc: { type: 'fixed', value: -5 } }] })).toMatch(/TRAVEL: Cannot be negative/);
    expect(await msg({ components: [{ ...basic, id: 'same' }, { ...special, id: 'same' }] })).toBe('Component ids must be unique.');
    expect(t('hrms_structures')).toHaveLength(3); // only the three seeded ones
  });

  it('the dashboard\'s own three standard structures pass the server\'s validation', async () => {
    for (const s of golden.cases[0].input.structures) {
      const r = await api().post(`${P}/structures`).send({ name: `${s.name} copy`, description: s.description, effective_from: s.effectiveFrom, components: s.components });
      expect({ name: s.name, status: r.status, error: r.body.error }).toEqual({ name: s.name, status: 201, error: undefined });
    }
  });

  it('rejects bad types with a 400 that names the field', async () => {
    refused(await api().post(`${P}/structures`).send({ ...body(), components: 'nope' }), 400, 'VALIDATION', /components/);
    refused(await api().post(`${P}/structures`).send({ ...body(), name: 5 }), 400, 'VALIDATION', /name/);
    refused(await api().post(`${P}/structures`).send(body({ components: [{ ...basic, kind: 'bonus' }] })), 400, 'VALIDATION', /components\.0\.kind/);
    refused(await api().post(`${P}/structures`).send(body({ name: 'x'.repeat(101) })), 400, 'VALIDATION', /name/);
  });

  it('updates partially, validating the whole structure; a missing one is 404', async () => {
    const s = ok(await api().post(`${P}/structures`).send(body()), 201);
    const renamed = ok(await api().put(`${P}/structures/${s.id}`).send({ name: ' Plant staff v2 ' }));
    expect(renamed).toMatchObject({ name: 'Plant staff v2', description: 'Plant', components: s.components });
    const comps = ok(await api().put(`${P}/structures/${s.id}`).send({ components: [{ ...s.components[0], calc: { type: 'pct_ctc', value: 45 } }, s.components[1]] }));
    expect(comps.components[0].calc.value).toBe(45);
    refused(await api().put(`${P}/structures/${s.id}`).send({ components: [] }), 400, 'VALIDATION', 'Add at least one component.');
    expect(stored('hrms_structures', s.id).components).toHaveLength(2);
    refused(await api().put(`${P}/structures/${uid(77)}`).send({ name: 'x' }), 404, 'NOT_FOUND');
    refused(await api().put(`${P}/structures/not-an-id`).send({ name: 'x' }), 400, 'VALIDATION');
  });

  it('deletes an unused structure, and refuses one employees are on, with the count', async () => {
    refused(await api().delete(`${P}/structures/${IDS.STD}`), 409, 'IN_USE', '5 employees are on this structure. Move them to another structure first.'); // aarav, dev, esha, fay (a draft) and hari
    expect(t('hrms_structures')).toHaveLength(3);
    stored('hrms_employees', people.hari!.id).deleted_at = '2026-01-01T00:00:00Z'; // a deleted draft does not count
    for (const k of ['aarav', 'dev', 'esha', 'fay']) stored('hrms_employees', people[k]!.id).structure_id = null;
    expect(ok(await api().delete(`${P}/structures/${IDS.STD}`))).toEqual({ id: IDS.STD });
    expect(t('hrms_structures')).toHaveLength(2);
    refused(await api().delete(`${P}/structures/${IDS.STD}`), 404, 'NOT_FOUND', 'Structure not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('attendance inputs', () => {
  const put = (emp: string, month: string, body: Row) => api().put(`${P}/attendance/${emp}/${month}`).send(body);

  it('creates the row with the dashboard\'s defaults (a full month present) and applies the patch', async () => {
    const a = ok(await put(people.aarav!.id, M, { lop_days: 2, overtime_hours: 6.5 }));
    expect(a).toMatchObject({ employee_id: people.aarav!.id, month: M, days_in_month: 31, present_days: 31, paid_leave_days: 0, weekly_offs: 0, holidays: 0, lop_days: 2, overtime_hours: 6.5, locked: false });
    expect(Object.keys(a).sort()).toEqual(['created_at', 'days_in_month', 'employee_id', 'holidays', 'id', 'locked', 'lop_days', 'month', 'overtime_hours', 'paid_leave_days', 'present_days', 'updated_at', 'weekly_offs']);
    expect(t('hrms_attendance')).toHaveLength(1);
    expect(ok(await put(people.aarav!.id, '2026-02', { lop_days: 0.5 })).days_in_month).toBe(28);
  });

  it('updates the same row on the next call (one row per person and month) and only touches the keys sent', async () => {
    const a = ok(await put(people.aarav!.id, M, { lop_days: 2, overtime_hours: 6 }));
    const b = ok(await put(people.aarav!.id, M, { overtime_hours: 9 }));
    expect(b).toMatchObject({ id: a.id, lop_days: 2, overtime_hours: 9 });
    expect(t('hrms_attendance')).toHaveLength(1);
    expect(ok(await put(people.aarav!.id, M, {}))).toMatchObject({ id: a.id, lop_days: 2 }); // nothing to change: no write
  });

  it('refuses loss of pay and overtime outside the dashboard\'s limits, in its words', async () => {
    refused(await put(people.aarav!.id, M, { lop_days: 0.3 }), 400, 'VALIDATION', 'Loss of pay is 0 to 31 days, in steps of half a day.');
    refused(await put(people.aarav!.id, M, { lop_days: -1 }), 400, 'VALIDATION', 'Loss of pay is 0 to 31 days, in steps of half a day.');
    refused(await put(people.aarav!.id, M, { lop_days: 31.5 }), 400, 'VALIDATION', 'Loss of pay is 0 to 31 days, in steps of half a day.');
    refused(await put(people.aarav!.id, '2026-02', { lop_days: 29 }), 400, 'VALIDATION', 'Loss of pay is 0 to 28 days, in steps of half a day.');
    refused(await put(people.aarav!.id, M, { overtime_hours: 201 }), 400, 'VALIDATION', 'Overtime is 0 to 200 hours a month.');
    refused(await put(people.aarav!.id, M, { overtime_hours: -0.5 }), 400, 'VALIDATION', 'Overtime is 0 to 200 hours a month.');
    expect(ok(await put(people.aarav!.id, M, { lop_days: 31, overtime_hours: 200 }))).toMatchObject({ lop_days: 31, overtime_hours: 200 });
    expect(t('hrms_attendance')).toHaveLength(1);
  });

  it('answers 404 for an unknown or deleted person, and 400 for a bad id or month', async () => {
    refused(await put(uid(404, 'c'), M, { lop_days: 1 }), 404, 'NOT_FOUND', 'Employee not found');
    stored('hrms_employees', people.dev!.id).deleted_at = '2026-01-01T00:00:00Z';
    refused(await put(people.dev!.id, M, { lop_days: 1 }), 404, 'NOT_FOUND', 'Employee not found');
    refused(await put('x', M, { lop_days: 1 }), 400, 'VALIDATION');
    refused(await put(people.aarav!.id, '2026-13', { lop_days: 1 }), 400, 'VALIDATION', /Month must be YYYY-MM/);
    refused(await put(people.aarav!.id, 'October', { lop_days: 1 }), 400, 'VALIDATION');
    refused(await put(people.aarav!.id, M, { lop_days: 'two' }), 400, 'VALIDATION', /lop_days/);
  });

  it('is locked once a frozen or paid run covers the person\'s legal entity and month, with the dashboard\'s reason', async () => {
    const { run } = await computedRun();
    ok(await put(people.bela!.id, M, { overtime_hours: 3 })); // computed is not closed
    await freeze((await compute(run.id)).id);
    refused(await put(people.aarav!.id, M, { lop_days: 1 }), 409, 'MONTH_LOCKED', 'The Oct 2026 run is frozen. Its inputs are locked.');
    refused(await put(people.esha!.id, M, { lop_days: 1 }), 409, 'MONTH_LOCKED'); // someone with no attendance row yet: still locked
    ok(await api().post(`${P}/runs/${run.id}/mark-paid`));
    refused(await put(people.aarav!.id, M, { lop_days: 1 }), 409, 'MONTH_LOCKED', 'The Oct 2026 run is paid. Its inputs are locked.');
  });

  it('does not lock another entity, another month, or an off-cycle draft', async () => {
    const { run } = await computedRun();
    await freeze(run.id);
    ok(await put(people.hari!.id, M, { lop_days: 1 })); // Hari is in the other legal entity
    ok(await put(people.aarav!.id, '2026-11', { lop_days: 1 }));
  });

  it('refuses a change to a locked month\'s inputs until it is unlocked ("Unlock it in Attendance first"); the lock itself can be toggled', async () => {
    const a = seedAttendance(people.aarav!.id, M, { locked: true, lop_days: 1 });
    refused(await put(people.aarav!.id, M, { lop_days: 2 }), 409, 'MONTH_LOCKED', "This month's attendance is locked. Unlock it in Attendance first.");
    refused(await put(people.aarav!.id, M, { overtime_hours: 2 }), 409, 'MONTH_LOCKED');
    expect(a.lop_days).toBe(1);
    expect(ok(await put(people.aarav!.id, M, { locked: false })).locked).toBe(false);
    expect(ok(await put(people.aarav!.id, M, { lop_days: 2 })).lop_days).toBe(2);
    expect(ok(await put(people.aarav!.id, M, { locked: true })).locked).toBe(true);
  });

  it('keeps the informational counts (present days, paid leave, weekly offs, holidays) within the month', async () => {
    expect(ok(await put(people.aarav!.id, M, { present_days: 20, paid_leave_days: 2, weekly_offs: 5, holidays: 1.5 }))).toMatchObject({ present_days: 20, paid_leave_days: 2, weekly_offs: 5, holidays: 1.5 });
    refused(await put(people.aarav!.id, M, { present_days: 40 }), 400, 'VALIDATION', /present days is 0 to 31/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('adjustments', () => {
  const post = (b: Row) => api().post(`${P}/adjustments`).send({ employee_id: people.aarav!.id, month: M, kind: 'bonus', amount: 1000, taxable: true, ...b });

  it('creates (201): the amount to whole rupees, taxable only for kinds that earn, created_by the signed-in admin, no tenant columns', async () => {
    const a = ok(await post({ note: 'Diwali', source: 'incentive-push' }), 201);
    expect(a).toEqual({ id: expect.any(String), employee_id: people.aarav!.id, month: M, kind: 'bonus', amount: 1000, taxable: true, note: 'Diwali', source: 'incentive-push', created_by: 'Sagar B', created_at: expect.any(String), updated_at: expect.any(String) });
    expect(ok(await post({ kind: 'one_time_deduction', taxable: true }), 201).taxable).toBe(false);
    expect(ok(await post({ kind: 'reimbursement', taxable: true }), 201).taxable).toBe(false);
    expect(ok(await post({ kind: 'incentive', taxable: false }), 201).taxable).toBe(false);
    expect(ok(await post({ kind: 'arrear', taxable: undefined }), 201).taxable).toBe(false); // taxable defaults to false when not sent
    expect(ok(await post({}), 201).source).toBeNull();
  });

  it('is idempotent on a client id', async () => {
    const id = uid(66);
    ok(await post({ id }), 201);
    expect(ok(await post({ id, amount: 5 }), 200).amount).toBe(1000);
    expect(t('hrms_adjustments')).toHaveLength(1);
  });

  it('refuses what validateAdjustment refuses, in its words', async () => {
    refused(await post({ amount: 0 }), 400, 'VALIDATION', 'Amount must be more than zero');
    refused(await post({ amount: -5 }), 400, 'VALIDATION', 'Amount must be more than zero');
    refused(await post({ amount: 10_000_001 }), 400, 'VALIDATION', 'That is more than ₹1 crore; check the amount');
    refused(await post({ amount: 100.5 }), 400, 'VALIDATION', 'Whole rupees only');
    refused(await post({ note: 'x'.repeat(81) }), 400, 'VALIDATION', 'Keep the note under 80 characters');
    refused(await post({ month: '2026-13' }), 400, 'VALIDATION', 'Choose a month');
    refused(await post({ employee_id: uid(5, 'c') }), 400, 'VALIDATION', 'Choose an employee');
    refused(await post({ employee_id: people.fay!.id }), 400, 'VALIDATION', 'Fay Person is not on the Oct 2026 payroll, so this would never be paid. Choose a month they are employed.');
    refused(await post({ month: '2020-01' }), 400, 'VALIDATION', /Aarav Person is not on the Jan 2020 payroll/);
    refused(await post({ kind: 'gift' }), 400, 'VALIDATION', /kind/);
    refused(await post({ amount: '100' }), 400, 'VALIDATION', /amount/);
    expect(t('hrms_adjustments')).toHaveLength(0);
  });

  it('is closed once a frozen or paid run covers the month: create, edit, move out of it, and delete are refused with the dashboard\'s reasons', async () => {
    const early = ok(await post({ month: '2026-09', employee_id: people.aarav!.id }), 201);
    const { run, bonus } = await computedRun();
    await freeze(run.id);
    refused(await post({}), 409, 'MONTH_LOCKED', 'The Oct 2026 run is frozen. Adjustments for it are closed.');
    refused(await api().put(`${P}/adjustments/${bonus.id}`).send({ amount: 5 }), 409, 'MONTH_LOCKED', 'The Oct 2026 run is frozen. Adjustments for it are closed.');
    refused(await api().put(`${P}/adjustments/${early.id}`).send({ month: M }), 409, 'MONTH_LOCKED', 'The Oct 2026 run is frozen. Adjustments for it are closed.'); // moving INTO a closed month
    refused(await api().delete(`${P}/adjustments/${bonus.id}`), 409, 'MONTH_LOCKED', 'The Oct 2026 run is frozen. This adjustment cannot be deleted.');
    ok(await api().put(`${P}/adjustments/${early.id}`).send({ amount: 7 })); // an open month is still fine
    expect(stored('hrms_adjustments', bonus.id).amount).toBe(25000);
    // out of a closed month into an open one: "belongs to the ... run"
    refused(await api().put(`${P}/adjustments/${bonus.id}`).send({ month: '2026-11' }), 409, 'MONTH_LOCKED', 'This adjustment belongs to the Oct 2026 run, which is frozen.');
    ok(await api().post(`${P}/runs/${run.id}/mark-paid`));
    refused(await api().delete(`${P}/adjustments/${bonus.id}`), 409, 'MONTH_LOCKED', 'The Oct 2026 run is paid. This adjustment cannot be deleted.');
  });

  it('does not close another legal entity\'s month', async () => {
    const { run } = await computedRun();
    await freeze(run.id);
    ok(await post({ employee_id: people.hari!.id }), 201);
  });

  it('updates with a merge, re-validates the whole row, and re-applies the taxable rule when the kind changes', async () => {
    const a = ok(await post({ kind: 'bonus', amount: 1000, taxable: true }), 201);
    expect(ok(await api().put(`${P}/adjustments/${a.id}`).send({ amount: 2000 }))).toMatchObject({ amount: 2000, kind: 'bonus', taxable: true, month: M });
    expect(ok(await api().put(`${P}/adjustments/${a.id}`).send({ kind: 'one_time_deduction' }))).toMatchObject({ kind: 'one_time_deduction', taxable: false });
    refused(await api().put(`${P}/adjustments/${a.id}`).send({ amount: 0 }), 400, 'VALIDATION', 'Amount must be more than zero');
    refused(await api().put(`${P}/adjustments/${a.id}`).send({ amount: 1.5 }), 400, 'VALIDATION', 'Whole rupees only');
    refused(await api().put(`${P}/adjustments/${uid(78)}`).send({ amount: 5 }), 404, 'NOT_FOUND', 'Adjustment not found');
    expect(ok(await api().put(`${P}/adjustments/${a.id}`).send({ note: null })).note).toBeNull();
  });

  it('deletes an open one, 404 for a missing one', async () => {
    const a = ok(await post({}), 201);
    expect(ok(await api().delete(`${P}/adjustments/${a.id}`))).toEqual({ id: a.id });
    expect(t('hrms_adjustments')).toHaveLength(0);
    refused(await api().delete(`${P}/adjustments/${a.id}`), 404, 'NOT_FOUND', 'Adjustment not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('loans and advances', () => {
  const post = (b: Row) => api().post(`${P}/loans`).send({ employee_id: people.aarav!.id, kind: 'loan', principal: 50000, emi: 5000, start_month: M, ...b });

  it('creates (201) with recovered 0 whatever the caller sends, and is idempotent on a client id', async () => {
    const l = ok(await post({ recovered: 41000, note: 'Bike' }), 201);
    expect(l).toEqual({ id: expect.any(String), employee_id: people.aarav!.id, kind: 'loan', principal: 50000, emi: 5000, start_month: M, recovered: 0, note: 'Bike', created_at: expect.any(String), updated_at: expect.any(String) });
    const id = uid(67);
    ok(await post({ id }), 201);
    expect(ok(await post({ id, principal: 1 }), 200).principal).toBe(50000);
    expect(t('hrms_loans').filter((x) => x.id === id)).toHaveLength(1);
  });

  it('refuses what validateLoan refuses, in its words', async () => {
    refused(await post({ principal: 0 }), 400, 'VALIDATION', 'Enter the amount lent');
    refused(await post({ principal: -10 }), 400, 'VALIDATION', 'Enter the amount lent');
    refused(await post({ principal: 5_000_001 }), 400, 'VALIDATION', 'More than ₹50 lakh; check the amount');
    refused(await post({ emi: 0 }), 400, 'VALIDATION', 'Enter the monthly EMI');
    refused(await post({ principal: 1000, emi: 2000 }), 400, 'VALIDATION', 'The EMI cannot be more than the amount lent');
    refused(await post({ start_month: '2026-13' }), 400, 'VALIDATION', 'Choose the first month of recovery');
    refused(await post({ note: 'x'.repeat(81) }), 400, 'VALIDATION', 'Keep the note under 80 characters');
    refused(await post({ employee_id: uid(8, 'c') }), 400, 'VALIDATION', 'Choose an employee');
    refused(await post({ principal: 1000.123, emi: 100 }), 400, 'VALIDATION', 'Enter the amount lent in whole rupees.');
    refused(await post({ emi: 100.123 }), 400, 'VALIDATION', 'Enter the EMI in whole rupees.');
    refused(await post({ kind: 'gift' }), 400, 'VALIDATION', /kind/);
    expect(t('hrms_loans')).toHaveLength(0);
    refused(await post({ principal: 1000.5, emi: 100 }), 400, 'VALIDATION', 'Enter the amount lent in whole rupees.'); // paise would drift the balance
    ok(await post({ principal: 1000, emi: 100 }), 201);
  });

  it('updates with a merge; the amount lent cannot drop below what is recovered; a person with recoveries cannot be swapped', async () => {
    const l = ok(await post({}), 201);
    expect(ok(await api().put(`${P}/loans/${l.id}`).send({ emi: 4000, note: 'new' }))).toMatchObject({ emi: 4000, principal: 50000, note: 'new', recovered: 0 });
    refused(await api().put(`${P}/loans/${l.id}`).send({ emi: 60000 }), 400, 'VALIDATION', 'The EMI cannot be more than the amount lent');
    stored('hrms_loans', l.id).recovered = 20000;
    refused(await api().put(`${P}/loans/${l.id}`).send({ principal: 15000 }), 409, 'IN_USE', 'The amount lent cannot be less than the 20000 already recovered through payroll.');
    refused(await api().put(`${P}/loans/${l.id}`).send({ employee_id: people.bela!.id }), 409, 'IN_USE', /cannot move to another employee/);
    expect(ok(await api().put(`${P}/loans/${l.id}`).send({ principal: 20000 })).principal).toBe(20000);
    expect(ok(await api().put(`${P}/loans/${l.id}`).send({ emi: 1000 })).recovered).toBe(20000); // recovered is never written by the API
    refused(await api().put(`${P}/loans/${uid(79)}`).send({ emi: 1 }), 404, 'NOT_FOUND', 'Loan not found');
  });

  it('deletes a loan nothing was recovered on, and refuses one that was, with the dashboard\'s reason', async () => {
    const a = ok(await post({}), 201); const b = ok(await post({}), 201);
    stored('hrms_loans', b.id).recovered = 100;
    expect(ok(await api().delete(`${P}/loans/${a.id}`))).toEqual({ id: a.id });
    refused(await api().delete(`${P}/loans/${b.id}`), 409, 'IN_USE', 'Part of this loan has been recovered through payroll, so it cannot be deleted.');
    refused(await api().delete(`${P}/loans/${a.id}`), 404, 'NOT_FOUND', 'Loan not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('pay runs: create', () => {
  it('creates a draft with law_version and a "Created" audit line (201); no tenant columns or fingerprint leave', async () => {
    const run = ok(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M }), 201);
    expect(run).toEqual({
      id: expect.any(String), entity_id: IDS.ENT, month: M, type: 'regular', status: 'draft', law_version: LAW_VERSION, created_at: expect.any(String), updated_at: expect.any(String),
      computed_at: null, frozen_at: null, frozen_by: null, paid_at: null, loan_recoveries: {}, attendance_locked_for: [], audit: [{ at: expect.any(String), by: 'Sagar B', action: 'Created' }], stale: false, payslips: [],
    });
    expect(stored('hrms_pay_runs', run.id)).toMatchObject({ created_by: 'Sagar B', client_id: null, org_id: ORG });
  });

  it('is idempotent: the same entity, month and type returns the existing run with 200, by body or by client id', async () => {
    const run = ok(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M, type: 'regular' }), 201);
    expect(ok(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M }), 200).id).toBe(run.id);
    expect(ok(await api().post(`${P}/runs`).send({ id: run.id, entity_id: IDS.ENT2, month: '2026-01' }), 200).id).toBe(run.id);
    expect(t('hrms_pay_runs')).toHaveLength(1);
    expect(t('hrms_pay_run_audit')).toHaveLength(1);
    const withId = uid(88);
    expect(ok(await api().post(`${P}/runs`).send({ id: withId, entity_id: IDS.ENT, month: '2026-09' }), 201).id).toBe(withId);
  });

  it('keeps runs apart by entity, month and type; an off-cycle run is its own run (and also returned if it already exists)', async () => {
    const regular = await mkRun();
    const off = await mkRun(M, IDS.ENT, 'offcycle');
    expect(off.id).not.toBe(regular.id);
    expect(off.type).toBe('offcycle');
    expect(ok(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M, type: 'offcycle' }), 200).id).toBe(off.id);
    expect((await mkRun(M, IDS.ENT2)).id).not.toBe(regular.id);
    expect((await mkRun('2026-11')).id).not.toBe(regular.id);
    expect(t('hrms_pay_runs')).toHaveLength(4);
  });

  it('survives losing a race: the database\'s unique index answers, and the winner\'s run comes back (200)', async () => {
    const winner = { id: uid(91), org_id: ORG, client_id: null, entity_id: IDS.ENT, month: M, type: 'regular', status: 'draft', loan_recoveries: {}, attendance_locked_for: [], input_fingerprint: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' };
    // our "does it exist?" lookup finds nothing; the other request inserts; then OUR insert hits hrms_pay_runs_regular_uq
    fake.fails.push({
      table: 'hrms_pay_runs', op: 'insert', times: 1, fire: () => { t('hrms_pay_runs').push(winner); },
      error: { code: '23505', message: 'duplicate key value violates unique constraint "hrms_pay_runs_regular_uq"' },
    });
    const res = await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(winner.id);
    expect(t('hrms_pay_runs')).toHaveLength(1);
  });

  it('refuses an unknown entity, a bad month and a bad type', async () => {
    refused(await api().post(`${P}/runs`).send({ entity_id: uid(9, 'c'), month: M }), 400, 'VALIDATION', 'entity_id: Unknown legal entity');
    refused(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: '2026-13' }), 400, 'VALIDATION', /month/);
    refused(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M, type: 'weekly' }), 400, 'VALIDATION', /type/);
    refused(await api().post(`${P}/runs`).send({ month: M }), 400, 'VALIDATION', /entity_id/);
    expect(t('hrms_pay_runs')).toHaveLength(0);
  });

  it('removes the run again if its first audit line cannot be written (no run without its trail)', async () => {
    fake.fails.push({ table: 'hrms_pay_run_audit', op: 'insert', error: { code: 'XX000', message: 'boom' }, times: 1 });
    expect((await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M })).status).toBe(500);
    expect(t('hrms_pay_runs')).toHaveLength(0);
  });

  it('lists runs without payslips (payslips: [] and payslip_count), newest month first, and filters', async () => {
    const { run } = await computedRun();
    const nov = await mkRun('2026-11');
    await mkRun(M, IDS.ENT2);
    const list = ok(await api().get(`${P}/runs`));
    expect(list.map((r: Row) => r.month)).toEqual(['2026-11', M, M]);
    expect(list.every((r: Row) => Array.isArray(r.payslips) && r.payslips.length === 0)).toBe(true);
    expect(list.find((r: Row) => r.id === run.id)).toMatchObject({ payslip_count: 5, status: 'computed', stale: false });
    expect(list.find((r: Row) => r.id === nov.id)).toMatchObject({ payslip_count: 0, status: 'draft' });
    expect(list.find((r: Row) => r.id === run.id).audit.map((a: Row) => a.action)).toEqual(['Created', 'Computed 5 payslips']);
    expect(ok(await api().get(`${P}/runs?month=${M}`))).toHaveLength(2);
    expect(ok(await api().get(`${P}/runs?entity_id=${IDS.ENT2}`))).toHaveLength(1);
    expect(ok(await api().get(`${P}/runs?status=computed`))).toHaveLength(1);
    expect(ok(await api().get(`${P}/runs?type=offcycle`))).toHaveLength(0);
    refused(await api().get(`${P}/runs?status=weird`), 400, 'VALIDATION', /status/);
  });

  it('GET /runs/:id has the payslips; an unknown id is 404, a bad id 400', async () => {
    const { run } = await computedRun();
    expect((await getRun(run.id)).payslips).toHaveLength(5);
    refused(await api().get(`${P}/runs/${uid(1, 'c')}`), 404, 'NOT_FOUND', 'Run not found');
    refused(await api().get(`${P}/runs/xyz`), 400, 'VALIDATION', 'Invalid id');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a large run', () => {
  it('reads past the 1000-row PostgREST page: every payslip comes back, in the engine\'s order, from GET /runs/:id and from bootstrap', async () => {
    const run = await mkRun();
    const n = 2305;
    for (let i = 0; i < n; i++) {
      t('hrms_payslips').push({
        id: uid(10_000 + i, 'f'), org_id: ORG, client_id: null, run_id: run.id, employee_id: uid(20_000 + i, 'e'), month: M, position: n - 1 - i, days_in_month: 31, paid_days: 31, lop_days: 0, overtime_hours: 0,
        earnings: [], deductions: [], employer: [], reimbursements: [], gross: 1000 + i, total_deductions: 0, net: 1000 + i, employer_cost: 1000 + i, wages: {}, warnings: [],
      });
    }
    const got = await getRun(run.id);
    expect(got.payslips).toHaveLength(n);
    expect(got.payslips.map((p: Row) => p.gross)).toEqual(Array.from({ length: n }, (_, k) => 1000 + (n - 1 - k))); // sorted by position
    const boot = ok(await api().get(`${P}/bootstrap`));
    expect(boot.runs.find((r: Row) => r.id === run.id).payslips).toHaveLength(n);
    expect(fake.log.filter((q) => q.table === 'hrms_payslips' && q.range).length).toBeGreaterThanOrEqual(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('compute', () => {
  /** The engine model of the scenario, built by hand from the same facts (an independent expectation of what the server should store). */
  const modelOf = () => {
    const decl = (o: Row = {}) => ({ sec80C: 0, sec80D: 0, nps80CCD1B: 0, homeLoanInterest: 0, rentPaidAnnual: 0, other: 0, status: 'not_submitted', ...o });
    const E = (k: string, o: Row) => ({
      id: people[k]!.id, code: people[k]!.code, firstName: people[k]!.first_name, lastName: 'Person', gender: 'male', entityId: IDS.ENT, locationId: IDS.LOC_DEL, employmentType: 'permanent', status: 'active', joinDate: '2024-04-01',
      noticeDays: 0, uanStatus: 'none', pfMember: false, pfOnActualWage: false, ptApplicable: false, lwfApplicable: false, taxRegime: 'new', declaration: decl(), payMode: 'bank', ...o,
    });
    const g = golden.cases[0].input.structures;
    const withId = (i: number, id: string) => ({ ...g[i], id });
    return {
      employees: [
        E('aarav', { structureId: IDS.STD, annualCtc: 1200000, pfMember: true, uan: '100200300401', uanStatus: 'aadhaar_seeded', pan: 'x', bank: {}, taxRegime: 'old', declaration: decl({ sec80C: 150000, sec80D: 25000, nps80CCD1B: 50000, homeLoanInterest: 100000, rentPaidAnnual: 360000, status: 'verified' }) }),
        E('bela', { gender: 'female', locationId: IDS.LOC_MUM, structureId: IDS.FIELD, annualCtc: 540000, pfMember: true, uan: '100200300402', uanStatus: 'aadhaar_seeded', ptApplicable: true, lwfApplicable: true, pan: 'x', bank: {} }),
        E('chitra', { employmentType: 'daily_wage', structureId: IDS.WH, annualCtc: 216000, pfMember: true, esicIp: '1234567890', uan: '100200300403', uanStatus: 'generated', bank: {} }),
        E('dev', { structureId: IDS.STD, annualCtc: 480000, payMode: 'cash' }),
        E('esha', { structureId: IDS.STD, annualCtc: 600000, pfMember: true }),
        E('fay', { status: 'onboarding', structureId: IDS.STD, annualCtc: 300000 }),
        E('gus', {}),
      ],
      structures: [withId(0, IDS.STD), withId(1, IDS.FIELD), withId(2, IDS.WH)],
      locations: [{ id: IDS.LOC_DEL, name: 'Delhi HQ', entityId: IDS.ENT, state: 'Delhi', city: 'New Delhi', metro: true }, { id: IDS.LOC_MUM, name: 'Mumbai', entityId: IDS.ENT, state: 'Maharashtra', city: 'Mumbai', metro: true }],
      entities: [], shifts: [], payRuns: [], overtimeRules: [golden.cases[0].input.overtimeRules[0]],
    };
  };

  it('stores exactly the payslips the engine computes from the same inputs: lines, their order, warnings, wages, in the engine\'s employee order', async () => {
    const { run, bonus, loan1, loan2 } = await computedRun();
    const m: any = modelOf();
    m.attendance = [
      { employeeId: people.aarav!.id, month: M, daysInMonth: 31, presentDays: 31, paidLeaveDays: 0, weeklyOffs: 0, holidays: 0, lopDays: 2, overtimeHours: 0, locked: false },
      { employeeId: people.chitra!.id, month: M, daysInMonth: 31, presentDays: 31, paidLeaveDays: 0, weeklyOffs: 0, holidays: 0, lopDays: 1.5, overtimeHours: 18, locked: false },
    ];
    m.adjustments = [{ id: bonus.id, employeeId: people.aarav!.id, month: M, kind: 'bonus', amount: 25000, taxable: true, note: 'Diwali' }];
    m.loans = [
      { id: loan1.id, employeeId: people.aarav!.id, kind: 'loan', principal: 50000, emi: 12000, startMonth: '2026-08', recovered: 41000 },
      { id: loan2.id, employeeId: people.aarav!.id, kind: 'advance', principal: 10000, emi: 5000, startMonth: M, recovered: 0 },
    ];
    const want = computePayRunPayslips(m, M, IDS.ENT, 'x').map(({ id, runId, ...rest }) => rest);
    expect(want).toHaveLength(5);
    const got = run.payslips.map(({ id, runId, ...rest }: Row) => rest);
    expect(got).toEqual(JSON.parse(JSON.stringify(want)));
    // key for key, not just by value: jsonb scrambles object key order and the API puts it back
    expect(JSON.stringify(got)).toBe(JSON.stringify(JSON.parse(JSON.stringify(want))));
    expect(run.payslips.every((p: Row) => p.runId === run.id && /^[0-9a-f-]{36}$/.test(p.id))).toBe(true);
    expect(run.payslips.map((p: Row) => p.employeeId)).toEqual(want.map((p) => p.employeeId));
    // left out: the draft (onboarding), the person with no structure or CTC, and the other legal entity
    const on = run.payslips.map((p: Row) => p.employeeId);
    for (const k of ['fay', 'gus', 'hari']) expect(on).not.toContain(people[k]!.id);
    // the first loan is capped at what is left (50000 - 41000), the advance takes its EMI
    expect(run.payslips[0].deductions.filter((l: Row) => l.code === 'LOAN').map((l: Row) => l.amount)).toEqual([9000, 5000]);
  });

  it('stamps law_version, computed_at, status and an input fingerprint on the run, and writes "Computed N payslips" to the audit', async () => {
    const { run } = await computedRun();
    expect(run).toMatchObject({ status: 'computed', law_version: LAW_VERSION, stale: false, loan_recoveries: {} });
    expect(typeof run.computed_at).toBe('string');
    expect(run.audit.map((a: Row) => [a.by, a.action])).toEqual([['Sagar B', 'Created'], ['Sagar B', 'Computed 5 payslips']]);
    expect(stored('hrms_pay_runs', run.id).input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run)).not.toContain(stored('hrms_pay_runs', run.id).input_fingerprint);
  });

  it('REPLACES the run\'s payslips on every compute: no duplicates, none left over from before, all in one database call', async () => {
    const { run } = await computedRun();
    const before = run.payslips.map((p: Row) => p.id);
    // a person leaves the run between computes
    stored('hrms_employees', people.esha!.id).status = 'onboarding';
    const again = await compute(run.id);
    expect(again.payslips).toHaveLength(4);
    expect(again.payslips.map((p: Row) => p.id).filter((id: string) => before.includes(id))).toEqual([]);
    expect(t('hrms_payslips').filter((p) => p.run_id === run.id)).toHaveLength(4);
    expect(again.audit.map((a: Row) => a.action)).toEqual(['Created', 'Computed 5 payslips', 'Computed 4 payslips']);
    // the replacement is ONE rpc call carrying every payslip (atomic in the database), never delete-then-insert from the API
    expect(fake.log.some((q) => q.table === 'hrms_payslips' && (q.op === 'insert' || q.op === 'delete'))).toBe(false);
    expect(fake.rpcLog.filter((c) => c.name === 'hrms_store_computed_run')).toHaveLength(2);
    expect(fake.rpcLog.filter((c) => c.name === 'hrms_store_computed_run')[1]!.args.p_payslips).toHaveLength(4);
  });

  it('computes an empty run (nobody on it) and a draft with no inputs', async () => {
    const run = await mkRun('2026-11', IDS.ENT2);
    const c = await compute((await mkRun('2023-01')).id); // before anyone joined
    expect(c).toMatchObject({ status: 'computed', payslips: [] });
    expect(run.payslips).toEqual([]);
  });

  it('uses the entity\'s people only, the month\'s attendance and adjustments only, and the org\'s overtime rule', async () => {
    seedAttendance(people.chitra!.id, M, { overtime_hours: 18 });
    seedAttendance(people.chitra!.id, '2026-09', { overtime_hours: 90, lop_days: 20 });
    const run = await compute((await mkRun()).id);
    const slip = run.payslips.find((p: Row) => p.employeeId === people.chitra!.id);
    expect(slip.overtimeHours).toBe(18);
    expect(slip.lopDays).toBe(0);
    expect(slip.earnings.some((l: Row) => l.code === 'OT' && /18h at 2x/.test(l.name))).toBe(true);
    // a stricter rule from the settings changes the next compute
    ok(await api().put(`${P}/settings/payroll`).send({ overtime_rule: { id: 'ot_std', name: 'Standard overtime', rateMultiplier: 3, quarterlyCapHours: 144, requiresConsent: true, minMinutes: 30, rateDivisor: 26, womenNightConsent: true, appliesTo: ['permanent'] } }));
    const run2 = await compute(run.id);
    const slip2 = run2.payslips.find((p: Row) => p.employeeId === people.chitra!.id);
    expect(slip2.earnings.some((l: Row) => l.code === 'OT')).toBe(false);
    expect(slip2.warnings).toContain('18 overtime hours were logged but no overtime rule applies to this employee.');
  });

  it('assumes 8 hour shifts (shifts are not on the server) whatever shift_id says', async () => {
    seedAttendance(people.chitra!.id, M, { overtime_hours: 10 });
    const base = await compute((await mkRun()).id);
    stored('hrms_employees', people.chitra!.id).shift_id = 'some-night-shift';
    const again = await compute(base.id);
    const ot = (r: Row) => r.payslips.find((p: Row) => p.employeeId === people.chitra!.id).earnings.find((l: Row) => l.code === 'OT').amount;
    expect(ot(again)).toBe(ot(base));
    const w = computePayRunPayslips({ ...(modelOf() as any), attendance: [{ employeeId: people.chitra!.id, month: M, lopDays: 0, overtimeHours: 10 }], adjustments: [], loans: [] }, M, IDS.ENT, 'x');
    expect(ot(base)).toBe(w.find((p) => p.employeeId === people.chitra!.id)!.earnings.find((l) => l.code === 'OT')!.amount);
  });

  it('refuses to compute a frozen or paid run (409 RUN_FROZEN) and leaves its payslips alone', async () => {
    const { run } = await computedRun();
    await freeze(run.id);
    const ids = t('hrms_payslips').map((p) => p.id);
    refused(await api().post(`${P}/runs/${run.id}/compute`), 409, 'RUN_FROZEN', 'This run is frozen. Unfreeze it before computing again.');
    ok(await api().post(`${P}/runs/${run.id}/mark-paid`));
    refused(await api().post(`${P}/runs/${run.id}/compute`), 409, 'RUN_FROZEN', 'This run is paid and closed, so it cannot be computed again.');
    expect(t('hrms_payslips').map((p) => p.id)).toEqual(ids);
  });

  it('maps the database function\'s own refusal (a freeze that slipped in after the status read) to the same 409', async () => {
    const { run } = await computedRun();
    fake.hooks.beforeRpc = (name) => { if (name === 'hrms_store_computed_run') stored('hrms_pay_runs', run.id).status = 'frozen'; };
    refused(await api().post(`${P}/runs/${run.id}/compute`), 409, 'RUN_FROZEN');
  });

  it('answers 404 for a run that is not there', async () => {
    refused(await api().post(`${P}/runs/${uid(2, 'c')}/compute`), 404, 'NOT_FOUND', 'Run not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('stale detection (input_fingerprint)', () => {
  const stale = async (id: string) => (await getRun(id)).stale;
  const STALE_MSG = 'Inputs changed after the last compute. Compute again before freezing, so the payslips match the inputs.';

  it('a fresh compute is not stale; changing any input the compute read makes it stale; recomputing clears it', async () => {
    const { run, bonus, loan2 } = await computedRun();
    expect(await stale(run.id)).toBe(false);
    const cases: Array<[string, () => void | Promise<unknown>]> = [
      ['attendance: loss of pay', () => { stored('hrms_attendance', t('hrms_attendance')[0]!.id).lop_days = 5; }],
      ['attendance: overtime', () => { t('hrms_attendance')[1]!.overtime_hours = 30; }],
      ['a new attendance row with loss of pay', () => { seedAttendance(people.bela!.id, M, { lop_days: 1 }); }],
      ['an adjustment amount', async () => { ok(await api().put(`${P}/adjustments/${bonus.id}`).send({ amount: 26000 })); }],
      ['a new adjustment', async () => { ok(await api().post(`${P}/adjustments`).send({ employee_id: people.bela!.id, month: M, kind: 'incentive', amount: 900, taxable: true }), 201); }],
      ['a loan EMI', async () => { ok(await api().put(`${P}/loans/${loan2.id}`).send({ emi: 4000 })); }],
      ['a new loan', async () => { ok(await api().post(`${P}/loans`).send({ employee_id: people.bela!.id, kind: 'loan', principal: 9000, emi: 1000, start_month: M }), 201); }],
      ['the CTC', () => { stored('hrms_employees', people.bela!.id).annual_ctc = 560000; }],
      ['PF membership', () => { stored('hrms_employees', people.dev!.id).pf_member = true; }],
      ['a UAN (a warning depends on it)', () => { stored('hrms_employees', people.aarav!.id).uan_status = 'generated'; }],
      ['a PAN being added', () => { stored('hrms_employees', people.dev!.id).pan_enc = 'sealed'; }],
      ['the tax regime', () => { stored('hrms_employees', people.aarav!.id).tax_regime = 'new'; }],
      ['the tax declaration', () => { stored('hrms_employees', people.aarav!.id).declaration = { sec80C: 1, status: 'submitted' }; }],
      ['the pay mode', () => { stored('hrms_employees', people.dev!.id).pay_mode = 'bank'; }],
      ['the salary overrides', () => { stored('hrms_employees', people.bela!.id).structure_overrides = { c_basic: 1 }; }],
      ['a person joining the run', () => { seedEmployee(fake, { first_name: 'New', structure_id: IDS.STD, annual_ctc: 360000 }); }],
      ['a person leaving the run (exited before the month)', () => { stored('hrms_employees', people.esha!.id).last_working_date = '2026-09-30'; }],
      ['the person\'s location', () => { stored('hrms_employees', people.aarav!.id).location_id = IDS.LOC_MUM; }],
      ['the location\'s state', () => { stored('hrms_locations', IDS.LOC_DEL).state = 'Karnataka'; }],
      ['a structure component', () => { stored('hrms_structures', IDS.STD).components = stored('hrms_structures', IDS.STD).components.map((c: Row) => (c.code === 'CONV' ? { ...c, calc: { ...c.calc, value: 1700 } } : c)); }],
      ['the overtime rule', async () => { ok(await api().put(`${P}/settings/payroll`).send({ overtime_rule: { id: 'ot_std', name: 'Standard overtime', rateMultiplier: 2.5, quarterlyCapHours: 144, requiresConsent: true, minMinutes: 30, rateDivisor: 26, womenNightConsent: true, appliesTo: ['permanent', 'contract', 'daily_wage', 'fixed_term'] } })); }],
    ];
    for (const [what, change] of cases) {
      await change();
      expect({ what, stale: await stale(run.id) }).toEqual({ what, stale: true });
      await compute(run.id);
      expect({ what, stale: await stale(run.id) }).toEqual({ what, stale: false });
    }
  });

  it('a change that does not touch what the compute read does not make it stale (contact details, names, another entity, other months, an attendance lock)', async () => {
    const { run } = await computedRun();
    stored('hrms_employees', people.aarav!.id).mobile = '9000000000';
    stored('hrms_employees', people.aarav!.id).first_name = 'Aarav K';
    stored('hrms_employees', people.hari!.id).annual_ctc = 999999; // the other legal entity
    stored('hrms_employees', people.fay!.id).annual_ctc = 999999;  // still a draft
    seedAttendance(people.aarav!.id, '2026-11', { lop_days: 5 });  // another month
    t('hrms_adjustments').push({ id: uid(99, 'f'), org_id: ORG, client_id: null, employee_id: people.aarav!.id, month: '2026-11', kind: 'bonus', amount: 5, taxable: true, note: null, source: null, created_by: null, created_at: 'x', updated_at: 'x' });
    stored('hrms_attendance', t('hrms_attendance')[0]!.id).locked = true; // freezing locks attendance, which must not look like an input change
    stored('hrms_structures', IDS.STD).name = 'Office staff (renamed)';
    stored('hrms_locations', IDS.LOC_DEL).name = 'Delhi head office';
    expect(await stale(run.id)).toBe(false);
  });

  it('is only ever true for a computed run: a draft, frozen or paid run is never stale', async () => {
    const draft = await mkRun();
    stored('hrms_employees', people.aarav!.id).annual_ctc = 1;
    expect(await stale(draft.id)).toBe(false);
    const c = await compute(draft.id);
    stored('hrms_employees', people.aarav!.id).annual_ctc = 1_300_000;
    expect(await stale(c.id)).toBe(true);
    await compute(c.id); await freeze(c.id);
    stored('hrms_employees', people.aarav!.id).annual_ctc = 1_400_000;
    expect(await stale(c.id)).toBe(false);
    ok(await api().post(`${P}/runs/${c.id}/mark-paid`));
    expect(await stale(c.id)).toBe(false);
  });

  it('freeze refuses a stale run with the dashboard\'s message and changes nothing', async () => {
    const { run, loan2 } = await computedRun();
    stored('hrms_attendance', t('hrms_attendance')[0]!.id).lop_days = 7;
    refused(await api().post(`${P}/runs/${run.id}/freeze`), 409, 'RUN_STALE', STALE_MSG);
    expect(stored('hrms_pay_runs', run.id).status).toBe('computed');
    expect(stored('hrms_loans', loan2.id).recovered).toBe(0);
    expect(fake.rpcLog.filter((c) => c.name === 'hrms_freeze_run')).toHaveLength(0);
  });

  it('the stale flag appears in the list, in GET /runs/:id and in bootstrap', async () => {
    const { run } = await computedRun();
    stored('hrms_attendance', t('hrms_attendance')[0]!.id).lop_days = 7;
    expect((await getRun(run.id)).stale).toBe(true);
    expect(ok(await api().get(`${P}/runs`)).find((r: Row) => r.id === run.id).stale).toBe(true);
    expect(ok(await api().get(`${P}/bootstrap`)).runs.find((r: Row) => r.id === run.id).stale).toBe(true);
  });

  it('a computed run with no stored fingerprint counts as stale (nothing to compare with)', async () => {
    const { run } = await computedRun();
    stored('hrms_pay_runs', run.id).input_fingerprint = null;
    expect((await getRun(run.id)).stale).toBe(true);
    refused(await api().post(`${P}/runs/${run.id}/freeze`), 409, 'RUN_STALE');
  });

  it('a recompute that slipped in between the freeze\'s check and its database call wins: the database function refuses and the answer is RUN_STALE', async () => {
    const { run } = await computedRun();
    fake.hooks.beforeRpc = (name) => { if (name === 'hrms_freeze_run') stored('hrms_pay_runs', run.id).input_fingerprint = 'someone-recomputed'; };
    refused(await api().post(`${P}/runs/${run.id}/freeze`), 409, 'RUN_STALE', STALE_MSG);
    expect(stored('hrms_pay_runs', run.id).status).toBe('computed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('freeze, unfreeze, mark paid', () => {
  it('freeze: only a computed run (a draft is refused, 409 RUN_NOT_COMPUTED, with the dashboard\'s words)', async () => {
    const draft = await mkRun('2026-09');
    refused(await api().post(`${P}/runs/${draft.id}/freeze`), 409, 'RUN_NOT_COMPUTED', 'Only a computed run can be frozen.');
    refused(await api().post(`${P}/runs/${uid(3, 'c')}/freeze`), 404, 'NOT_FOUND', 'Run not found');
    const { run } = await computedRun();
    await freeze(run.id);
    refused(await api().post(`${P}/runs/${run.id}/freeze`), 409, 'RUN_NOT_COMPUTED', 'Only a computed run can be frozen.');
  });

  it('freeze: loans recovered (each at min(EMI, balance)), attendance locked only for the people on the run, status / who / when / audit recorded, full run returned', async () => {
    const { run, loan1, loan2 } = await computedRun();
    seedAttendance(people.hari!.id, M); // the other legal entity: must stay open
    seedAttendance(people.fay!.id, M);  // a draft, not on the run: must stay open
    const frozen = await freeze(run.id);
    expect(frozen).toMatchObject({ id: run.id, status: 'frozen', frozen_by: 'Sagar B', stale: false });
    expect(typeof frozen.frozen_at).toBe('string');
    expect(frozen.payslips).toHaveLength(5);
    expect(frozen.loan_recoveries).toEqual({ [loan1.id]: 9000, [loan2.id]: 5000 });
    expect(stored('hrms_loans', loan1.id).recovered).toBe(50000);
    expect(stored('hrms_loans', loan2.id).recovered).toBe(5000);
    expect(frozen.attendance_locked_for.slice().sort()).toEqual([people.aarav!.id, people.chitra!.id].sort());
    const lock = (id: string) => t('hrms_attendance').find((a) => a.employee_id === id)!.locked;
    expect([lock(people.aarav!.id), lock(people.chitra!.id), lock(people.hari!.id), lock(people.fay!.id)]).toEqual([true, true, false, false]);
    expect(frozen.audit[frozen.audit.length - 1]).toMatchObject({ by: 'Sagar B', action: 'Frozen. Payslips are locked.' });
    const call = fake.rpcLog.find((c) => c.name === 'hrms_freeze_run')!;
    expect(call.args).toMatchObject({ p_org: ORG, p_run: run.id, p_by_name: 'Sagar B', p_by_user: MASTER.id });
  });

  it('unfreeze: needs a reason of at least 5 characters (trimmed), 400 UNFREEZE_REASON, before anything else is looked at', async () => {
    const { run } = await computedRun();
    await freeze(run.id);
    for (const reason of ['', '    ', 'oops', ' ab  ']) refused(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason }), 400, 'UNFREEZE_REASON', 'Give a reason of at least a few words. It goes into the audit trail.');
    refused(await api().post(`${P}/runs/${run.id}/unfreeze`).send({}), 400, 'VALIDATION', /reason/);
    refused(await api().post(`${P}/runs/${uid(4, 'c')}/unfreeze`).send({ reason: 'x' }), 400, 'UNFREEZE_REASON');
    expect(stored('hrms_pay_runs', run.id).status).toBe('frozen');
    refused(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'x'.repeat(501) }), 400, 'VALIDATION', /at most 500/);
  });

  it('unfreeze: only a frozen run; gives back exactly what the freeze recorded, unlocks exactly what it locked, audits "Unfrozen: <reason>"', async () => {
    const { run, loan1, loan2 } = await computedRun();
    seedAttendance(people.bela!.id, M, { locked: true }); // locked by hand before the freeze: the unfreeze must not unlock it
    refused(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'not frozen yet' }), 409, 'RUN_NOT_FROZEN', 'Only a frozen run can be unfrozen. A paid run is closed.');
    await freeze(run.id);
    const back = ok(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: '  a late correction  ' }));
    expect(back).toMatchObject({ status: 'computed', frozen_at: null, frozen_by: null, loan_recoveries: {}, attendance_locked_for: [], stale: false });
    expect(back.payslips).toHaveLength(5);
    expect(back.audit[back.audit.length - 1].action).toBe('Unfrozen: a late correction');
    expect([stored('hrms_loans', loan1.id).recovered, stored('hrms_loans', loan2.id).recovered]).toEqual([41000, 0]);
    const lock = (id: string) => t('hrms_attendance').find((a) => a.employee_id === id)!.locked;
    expect([lock(people.aarav!.id), lock(people.chitra!.id), lock(people.bela!.id)]).toEqual([false, false, true]);
  });

  it('freeze, unfreeze, freeze does not recover an EMI twice, and the next compute shows the same EMI as the first', async () => {
    const { run, loan1, loan2 } = await computedRun();
    const emis = (r: Row) => r.payslips[0].deductions.filter((l: Row) => l.code === 'LOAN').map((l: Row) => l.amount);
    const first = emis(run);
    await freeze(run.id);
    ok(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'second thoughts' }));
    await freeze(run.id);
    expect([stored('hrms_loans', loan1.id).recovered, stored('hrms_loans', loan2.id).recovered]).toEqual([50000, 5000]);
    ok(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'third thoughts' }));
    expect(emis(await compute(run.id))).toEqual(first);
    await freeze(run.id);
    expect([stored('hrms_loans', loan1.id).recovered, stored('hrms_loans', loan2.id).recovered]).toEqual([50000, 5000]);
  });

  it('after an unfreeze the inputs are open again: an edit makes the run stale until it is computed again', async () => {
    const { run } = await computedRun();
    await freeze(run.id);
    ok(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'fix the overtime' }));
    ok(await api().put(`${P}/attendance/${people.chitra!.id}/${M}`).send({ overtime_hours: 20 }));
    expect((await getRun(run.id)).stale).toBe(true);
    refused(await api().post(`${P}/runs/${run.id}/freeze`), 409, 'RUN_STALE');
    await compute(run.id);
    expect((await freeze(run.id)).status).toBe('frozen');
  });

  it('two freezes at once: one wins, the other is refused; the loans move once', async () => {
    const { run, loan1 } = await computedRun();
    const both = await Promise.all([api().post(`${P}/runs/${run.id}/freeze`), api().post(`${P}/runs/${run.id}/freeze`)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)!.body.code).toMatch(/RUN_NOT_COMPUTED|RUN_STALE/);
    expect(stored('hrms_loans', loan1.id).recovered).toBe(50000);
  });

  it('mark paid: only a frozen run; afterwards the run is closed', async () => {
    const { run } = await computedRun();
    refused(await api().post(`${P}/runs/${run.id}/mark-paid`), 409, 'RUN_NOT_FROZEN', 'Only a frozen run can be marked paid. Freeze it first.');
    await freeze(run.id);
    const paid = ok(await api().post(`${P}/runs/${run.id}/mark-paid`));
    expect(paid).toMatchObject({ status: 'paid', frozen_by: 'Sagar B' });
    expect(typeof paid.paid_at).toBe('string');
    expect(paid.payslips).toHaveLength(5);
    expect(paid.audit[paid.audit.length - 1]).toMatchObject({ by: 'Sagar B', action: 'Marked paid' });
    refused(await api().post(`${P}/runs/${run.id}/mark-paid`), 409, 'RUN_NOT_FROZEN');
    refused(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'too late for that' }), 409, 'RUN_NOT_FROZEN', 'Only a frozen run can be unfrozen. A paid run is closed.');
    refused(await api().post(`${P}/runs/${run.id}/freeze`), 409, 'RUN_NOT_COMPUTED');
    refused(await api().post(`${P}/runs/${run.id}/compute`), 409, 'RUN_FROZEN');
    refused(await api().post(`${P}/runs/${uid(5, 'c')}/mark-paid`), 404, 'NOT_FOUND');
  });

  it('every command answers with the full run (payslips included, ids and statuses current)', async () => {
    const { run } = await computedRun();
    for (const [path, body, status] of [[`/runs/${run.id}/freeze`, undefined, 'frozen'], [`/runs/${run.id}/unfreeze`, { reason: 'check the shape' }, 'computed'], [`/runs/${run.id}/compute`, undefined, 'computed']] as Array<[string, any, string]>) {
      const r = ok(await api().post(`${P}${path}`).send(body));
      expect(r).toMatchObject({ id: run.id, entity_id: IDS.ENT, month: M, type: 'regular', status, law_version: LAW_VERSION });
      expect(r.payslips).toHaveLength(5);
      expect(Object.keys(r.payslips[0]).sort()).toEqual(['daysInMonth', 'deductions', 'earnings', 'employeeId', 'employer', 'employerCost', 'gross', 'id', 'lopDays', 'month', 'net', 'overtimeHours', 'paidDays', 'reimbursements', 'runId', 'totalDeductions', 'wages', 'warnings'].sort());
      expect(Object.keys(r.payslips[0].wages)).toEqual(['codeWages', 'pfWage', 'esiWage', 'ptBase', 'taxableMonthly']);
    }
  });

  it('a loan of someone in another legal entity is untouched by this entity\'s freeze', async () => {
    const { run } = await computedRun();
    const theirs = ok(await api().post(`${P}/loans`).send({ employee_id: people.hari!.id, kind: 'loan', principal: 10000, emi: 1000, start_month: M }), 201);
    await compute(run.id); await freeze(run.id);
    expect(stored('hrms_loans', theirs.id).recovered).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('pre-run checks and the ECR', () => {
  it('GET /checks is the engine\'s preRunChecks for the run\'s entity and month: same shape, same words, server employee ids', async () => {
    const { run } = await computedRun();
    const { checks } = ok(await api().get(`${P}/runs/${run.id}/checks`));
    const titles = checks.map((c: Row) => `${c.severity}:${c.title}:${c.employeeId ?? 'all'}`);
    expect(titles).toContain(`blocker:No bank account:${people.esha!.id}`);
    expect(titles).toContain(`warning:No PAN:${people.dev!.id}`);
    expect(titles).toContain(`warning:UAN not Aadhaar-seeded:${people.chitra!.id}`);
    expect(titles).toContain(`warning:Attendance not locked:${people.aarav!.id}`);
    expect(titles).toContain(`warning:No attendance summary:${people.bela!.id}`);
    expect(titles).toContain(`blocker:No salary structure:${people.gus!.id}`); // Gus is on the payroll but gets no payslip until he has a structure and CTC
    expect(checks.find((c: Row) => c.title === 'No bank account').detail).toBe('Esha Person is paid by bank transfer but has no account on file.');
    expect(checks.find((c: Row) => c.title === 'No bank account').fixHref).toBe(`/dashboard/hrms/employees/${people.esha!.id}?tab=statutory`);
    for (const c of checks) expect(Object.keys(c).sort()).toEqual(expect.arrayContaining(['detail', 'id', 'severity', 'title']));
    expect(JSON.stringify(checks)).not.toMatch(/ON-FILE/);
    for (const a of Object.values(ACCOUNT)) expect(JSON.stringify(checks)).not.toContain(a);
  });

  it('flags a legal entity without a PF registration and an earlier run that is not closed', async () => {
    const earlier = await mkRun('2026-09');
    const other = await mkRun(M, IDS.ENT2);
    const c2 = ok(await api().get(`${P}/runs/${other.id}/checks`)).checks;
    expect(c2.map((c: Row) => c.title)).toContain('No PF registration');
    const run = await mkRun();
    const c1 = ok(await api().get(`${P}/runs/${run.id}/checks`)).checks;
    expect(c1.map((c: Row) => c.title)).not.toContain('No PF registration');
    expect(c1.find((c: Row) => c.title === 'Earlier run not closed')).toMatchObject({ severity: 'warning', detail: 'The 2026-09 run is still draft.' });
    expect(earlier.status).toBe('draft');
  });

  it('GET /ecr is buildEcr\'s result: the text, the row count, and the people blocked with the reason', async () => {
    const { run } = await computedRun();
    const ecr = ok(await api().get(`${P}/runs/${run.id}/ecr`));
    expect(Object.keys(ecr).sort()).toEqual(['blocked', 'rows', 'text']);
    expect(ecr.blocked).toEqual(expect.arrayContaining([{ employeeId: people.chitra!.id, reason: 'UAN not Aadhaar-seeded' }, { employeeId: people.esha!.id, reason: 'No UAN' }]));
    expect(ecr.rows).toBe(2);
    expect(ecr.text.split('\n')).toHaveLength(2);
    expect(ecr.text).toContain('100200300401#~#AARAV PERSON#~#');
    refused(await api().get(`${P}/runs/${uid(6, 'c')}/ecr`), 404, 'NOT_FOUND');
    refused(await api().get(`${P}/runs/${uid(6, 'c')}/checks`), 404, 'NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('full and final settlements', () => {
  const post = (b: Row = {}) => api().post(`${P}/fnf`).send({ employee_id: people.aarav!.id, last_working_date: '2026-11-30', resignation_date: '2026-10-31', notice_days_served: 20, leave_encash_days: 5, other_recoveries: 1000, other_payments: 2000, ...b });

  it('creates a draft (201); due_by is two working days after the last day (Sundays skipped) and is not the caller\'s to set', async () => {
    const c = ok(await post({ due_by: '2030-01-01', status: 'paid' }), 201);
    expect(c).toEqual({
      id: expect.any(String), employee_id: people.aarav!.id, last_working_date: '2026-11-30', resignation_date: '2026-10-31', notice_days_served: 20, leave_encash_days: 5,
      other_recoveries: 1000, other_payments: 2000, status: 'draft', due_by: addWorkingDays('2026-11-30', 2), created_at: expect.any(String), updated_at: expect.any(String),
    });
    expect(c.due_by).toBe('2026-12-02');
    expect(ok(await post({ employee_id: people.bela!.id, last_working_date: '2026-11-28', resignation_date: null, other_recoveries: undefined, other_payments: undefined }), 201)).toMatchObject({ due_by: '2026-12-01', resignation_date: null, other_recoveries: 0, other_payments: 0 });
  });

  it('is idempotent on a client id; one OPEN settlement per employee (409 FNF_STATE); a paid one does not block the next', async () => {
    const id = uid(61);
    ok(await post({ id }), 201);
    expect(ok(await post({ id, notice_days_served: 1 }), 200).notice_days_served).toBe(20);
    refused(await post({}), 409, 'FNF_STATE', 'A settlement is already open for this employee.');
    expect(t('hrms_fnf_cases')).toHaveLength(1);
    ok(await api().post(`${P}/fnf/${id}/approve`)); ok(await api().post(`${P}/fnf/${id}/mark-paid`));
    ok(await post({ last_working_date: '2026-12-31', resignation_date: null }), 201);
  });

  it('turns the database\'s own one-open-settlement index into the same refusal when two creates race', async () => {
    fake.fails.push({ table: 'hrms_fnf_cases', op: 'insert', error: { code: '23505', message: 'duplicate key value violates unique constraint "hrms_fnf_cases_open_uq"' }, times: 1 });
    refused(await post({}), 409, 'FNF_STATE', 'A settlement is already open for this employee.');
  });

  it('refuses what validateFnf refuses, in its words', async () => {
    refused(await post({ employee_id: uid(8, 'c') }), 400, 'VALIDATION', 'Choose an employee');
    refused(await post({ last_working_date: 'soon' }), 400, 'VALIDATION', 'Enter the last working day');
    refused(await post({ last_working_date: '2026-02-31', resignation_date: null }), 400, 'VALIDATION', 'Enter the last working day');
    refused(await post({ last_working_date: '2023-01-01' }), 400, 'VALIDATION', 'The last working day is before the joining date');
    refused(await post({ resignation_date: 'x' }), 400, 'VALIDATION', 'Enter a valid date');
    refused(await post({ resignation_date: '2026-12-15' }), 400, 'VALIDATION', 'Resignation is after the last working day');
    refused(await post({ notice_days_served: -1 }), 400, 'VALIDATION', 'Cannot be negative');
    refused(await post({ notice_days_served: 400 }), 400, 'VALIDATION', 'That is more than 365; check it');
    refused(await post({ leave_encash_days: 366 }), 400, 'VALIDATION', 'That is more than 365; check it');
    refused(await post({ other_recoveries: 10_000_001 }), 400, 'VALIDATION', 'That is more than 10000000; check it');
    refused(await post({ other_payments: -5 }), 400, 'VALIDATION', 'Cannot be negative');
    refused(await post({ notice_days_served: undefined }), 400, 'VALIDATION', /notice_days_served/);
    expect(t('hrms_fnf_cases')).toHaveLength(0);
  });

  it('updates only a draft (merged and re-validated, due_by follows the last day); an approved or paid one is refused', async () => {
    const c = ok(await post({}), 201);
    const u = ok(await api().put(`${P}/fnf/${c.id}`).send({ last_working_date: '2026-12-04', other_payments: 3000 }));
    expect(u).toMatchObject({ last_working_date: '2026-12-04', due_by: '2026-12-07', other_payments: 3000, notice_days_served: 20, employee_id: people.aarav!.id });
    refused(await api().put(`${P}/fnf/${c.id}`).send({ resignation_date: '2027-01-01' }), 400, 'VALIDATION', 'Resignation is after the last working day');
    ok(await api().post(`${P}/fnf/${c.id}/approve`));
    refused(await api().put(`${P}/fnf/${c.id}`).send({ other_payments: 1 }), 409, 'FNF_STATE', 'Only a draft settlement can be edited.');
    refused(await api().put(`${P}/fnf/${uid(9, 'c')}`).send({ other_payments: 1 }), 404, 'NOT_FOUND', 'Case not found');
  });

  it('compute is the engine\'s computeFnf as is (camelCase), for the person\'s own structure, location and loans', async () => {
    stored('hrms_employees', people.aarav!.id).status = 'on_notice'; stored('hrms_employees', people.aarav!.id).notice_days = 30;
    const loan = ok(await api().post(`${P}/loans`).send({ employee_id: people.aarav!.id, kind: 'advance', principal: 10000, emi: 5000, start_month: M }), 201);
    stored('hrms_loans', loan.id).recovered = 5000;
    const c = ok(await post({}), 201);
    const got = ok(await api().get(`${P}/fnf/${c.id}/compute`));
    const m: any = {
      employees: [{ id: people.aarav!.id, entityId: IDS.ENT, locationId: IDS.LOC_DEL, structureId: IDS.STD, annualCtc: 1200000, employmentType: 'permanent', joinDate: '2024-04-01', noticeDays: 30, pfMember: true, pfOnActualWage: false, taxRegime: 'old',
        declaration: { sec80C: 150000, sec80D: 25000, nps80CCD1B: 50000, homeLoanInterest: 100000, rentPaidAnnual: 360000, other: 0, status: 'verified' } }],
      structures: [{ ...golden.cases[0].input.structures[0], id: IDS.STD }], locations: [{ id: IDS.LOC_DEL, entityId: IDS.ENT, state: 'Delhi', city: 'New Delhi', metro: true }],
      loans: [{ id: loan.id, employeeId: people.aarav!.id, kind: 'advance', principal: 10000, emi: 5000, startMonth: M, recovered: 5000 }],
    };
    const want = computeFnf(m, { id: 'x', employeeId: people.aarav!.id, lastWorkingDate: '2026-11-30', noticeDaysServed: 20, leaveEncashDays: 5, otherRecoveries: 1000, otherPayments: 2000, status: 'draft', dueBy: '' });
    expect(got).toEqual(JSON.parse(JSON.stringify(want)));
    expect(got.lines.map((l: Row) => l.label)).toEqual(expect.arrayContaining(['Salary for 30 days of 2026-11', 'Leave encashment (5 days)', 'Advance outstanding', 'Other recoveries', 'Other payments']));
    expect(got.dueBy).toBe('2026-12-02');
  });

  it('compute is null when the person has no structure or CTC (computeFnf\'s own answer), and 404 for an unknown case', async () => {
    const c = ok(await post({ employee_id: people.gus!.id }), 201);
    expect(ok(await api().get(`${P}/fnf/${c.id}/compute`))).toBeNull();
    refused(await api().get(`${P}/fnf/${uid(9, 'c')}/compute`), 404, 'NOT_FOUND', 'Case not found');
  });

  it('approve, mark paid and delete follow the dashboard\'s rules, with its words, and answer with the case', async () => {
    const c = ok(await post({}), 201);
    refused(await api().post(`${P}/fnf/${c.id}/mark-paid`), 409, 'FNF_STATE', 'Approve the settlement before marking it paid.');
    expect(ok(await api().post(`${P}/fnf/${c.id}/approve`)).status).toBe('approved');
    refused(await api().post(`${P}/fnf/${c.id}/approve`), 409, 'FNF_STATE', 'Only a draft settlement can be approved.');
    refused(await api().delete(`${P}/fnf/${c.id}`), 409, 'FNF_STATE', 'Only a draft settlement can be deleted.');
    expect(ok(await api().post(`${P}/fnf/${c.id}/mark-paid`))).toMatchObject({ id: c.id, status: 'paid' });
    refused(await api().post(`${P}/fnf/${c.id}/mark-paid`), 409, 'FNF_STATE', 'Approve the settlement before marking it paid.');
    refused(await api().delete(`${P}/fnf/${c.id}`), 409, 'FNF_STATE', 'Only a draft settlement can be deleted.');
    const d = ok(await post({ employee_id: people.bela!.id }), 201);
    expect(ok(await api().delete(`${P}/fnf/${d.id}`))).toEqual({ id: d.id });
    refused(await api().delete(`${P}/fnf/${d.id}`), 404, 'NOT_FOUND', 'Case not found');
    refused(await api().post(`${P}/fnf/${uid(9, 'c')}/approve`), 404, 'NOT_FOUND', 'Case not found');
    refused(await api().post(`${P}/fnf/${uid(9, 'c')}/mark-paid`), 404, 'NOT_FOUND', 'Case not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('payroll settings (the overtime rule)', () => {
  const rule = (over: Row = {}) => ({ id: 'ot_std', name: 'Standard overtime', rateMultiplier: 2, quarterlyCapHours: 144, requiresConsent: true, minMinutes: 30, rateDivisor: 26, womenNightConsent: true, appliesTo: ['permanent', 'contract'], ...over });

  it('defaults to the dashboard\'s seed rule and stores a valid one (bootstrap reads it back)', async () => {
    expect(ok(await api().get(`${P}/bootstrap`)).settings).toEqual({ payroll: { overtime_rule: { id: 'ot_std', name: 'Standard overtime', rateMultiplier: 2, quarterlyCapHours: 144, requiresConsent: true, minMinutes: 30, rateDivisor: 26, womenNightConsent: true, appliesTo: ['permanent', 'contract', 'daily_wage', 'fixed_term'] } } });
    const saved = ok(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ name: '  Plant OT  ', rateMultiplier: 2.5, rateDivisor: 'calendar', appliesTo: ['permanent', 'permanent', 'intern'] }) }));
    expect(saved).toEqual({ payroll: { overtime_rule: rule({ name: 'Plant OT', rateMultiplier: 2.5, rateDivisor: 'calendar', appliesTo: ['permanent', 'intern'] }) } });
    expect(ok(await api().get(`${P}/bootstrap`)).settings.payroll.overtime_rule.rateDivisor).toBe('calendar');
    expect(t('hrms_settings').filter((s) => s.key === 'payroll')).toHaveLength(1);
    ok(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule() }));
    expect(t('hrms_settings').filter((s) => s.key === 'payroll')).toHaveLength(1); // an upsert, not a second row
  });

  it('accepts the rule however it is wrapped: bare in overtime_rule, in value, in payroll, and through the phase 1 settings route', async () => {
    for (const [path, body] of [
      [`${P}/settings/payroll`, { overtime_rule: rule({ minMinutes: 10 }) }], [`${P}/settings/payroll`, { value: { overtime_rule: rule({ minMinutes: 11 }) } }],
      [`${P}/settings/payroll`, { payroll: { overtime_rule: rule({ minMinutes: 12 }) } }], [`${P}/settings/payroll`, { value: rule({ minMinutes: 13 }) }],
      [`${P}/settings`, { overtime_rule: rule({ minMinutes: 14 }) }], ['/hrms/settings/payroll', { overtime_rule: rule({ minMinutes: 15 }) }],
    ] as Array<[string, Row]>) {
      const r = ok(await api().put(path).send(body));
      expect({ path, minMinutes: r.payroll.overtime_rule.minMinutes }).toEqual({ path, minMinutes: body.overtime_rule?.minMinutes ?? body.value?.overtime_rule?.minMinutes ?? body.payroll?.overtime_rule?.minMinutes ?? body.value?.minMinutes });
    }
  });

  it('refuses a rule the Overtime tab refuses, in its words, and stores nothing', async () => {
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ rateMultiplier: 1.5 }) }), 400, 'VALIDATION', 'Overtime cannot pay less than 2x the ordinary rate under the Labour Codes');
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ name: '   ' }) }), 400, 'VALIDATION', 'Rule name is required');
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ quarterlyCapHours: 0 }) }), 400, 'VALIDATION', 'Enter the quarterly cap in hours');
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ minMinutes: 241 }) }), 400, 'VALIDATION', 'Minimum is 0 to 240 whole minutes');
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ minMinutes: 1.5 }) }), 400, 'VALIDATION', 'Minimum is 0 to 240 whole minutes');
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ appliesTo: [] }) }), 400, 'VALIDATION', 'Choose at least one employment type');
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ rateDivisor: 28 }) }), 400, 'VALIDATION', /rateDivisor/);
    refused(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ appliesTo: ['pirate'] }) }), 400, 'VALIDATION', /appliesTo/);
    refused(await api().put(`${P}/settings/payroll`).send({}), 400, 'VALIDATION', /overtime_rule/);
    expect(t('hrms_settings')).toHaveLength(0);
    // a quarterly cap above the Labour Codes' 144 hours is only a warning in the dashboard: it can be saved
    ok(await api().put(`${P}/settings/payroll`).send({ overtime_rule: rule({ quarterlyCapHours: 200 }) }));
  });

  it('phase 1 still refuses an unknown setting and still stores the employee code prefix', async () => {
    refused(await api().put('/hrms/settings/unknown').send({ value: 'x' }), 404, 'NOT_FOUND', 'Unknown setting');
    expect(ok(await api().put('/hrms/settings/employee_code_prefix').send({ value: 'KIN-' })).employee_code_prefix).toBe('KIN-');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the fingerprint and the masking helpers', () => {
  it('canonical() is order independent, skips undefined, and distinguishes values', () => {
    expect(canonical({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(canonical({ a: { c: undefined, d: [1, 2] }, b: 1 }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    expect(canonical({ a: null })).toBe('{"a":null}');
  });

  it('the fingerprint depends on the month and entity as well as the data, and is the same for the same data', async () => {
    const m = {
      employees: [], structures: [], locations: [], entities: [], attendance: [], adjustments: [], loans: [], shifts: [], payRuns: [],
      overtimeRules: [golden.cases[0].input.overtimeRules[0]],
    } as any;
    expect(inputFingerprint(m, M, IDS.ENT)).toBe(inputFingerprint({ ...m }, M, IDS.ENT));
    expect(inputFingerprint(m, M, IDS.ENT)).not.toBe(inputFingerprint(m, '2026-11', IDS.ENT));
    expect(inputFingerprint(m, M, IDS.ENT)).not.toBe(inputFingerprint(m, M, IDS.ENT2));
    expect(inputFingerprint(m, M, IDS.ENT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the engine\'s pure copy of the masking tests agrees with the server\'s (hrmsCrypto) on every sample', () => {
    const samples = ['ABCDE1234F', 'XXXXXX234F', '••••••1234', '****1234', 'AXXPX1234F', 'xxxx', '501001234567', '5010•1234567', '50100x234567', '', 'XXXXXXXXXX', 'abcde1234f'];
    for (const s of samples) {
      expect({ s, pan: looksMaskedPan(s) }).toEqual({ s, pan: serverMaskedPan(s) });
      expect({ s, acc: looksMaskedAccount(s) }).toEqual({ s, acc: serverMaskedAccount(s) });
    }
  });

  it('LAW_VERSION is stamped as the dashboard\'s', () => {
    expect(LAW_VERSION).toBe('IN-2026.11 (preview)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('payroll stays out of the logs', () => {
  it('logs the route and status of a failed request, never the body', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    const error = jest.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
    await api().post(`${P}/loans`).send({ employee_id: people.aarav!.id, kind: 'loan', principal: 'SECRET-123', emi: 1, start_month: M });
    fake.fails.push({ table: 'hrms_loans', op: 'insert', error: { code: 'XX000', message: 'row for SECRET-456 failed' }, times: 1 });
    const res = await api().post(`${P}/loans`).send({ employee_id: people.aarav!.id, kind: 'loan', principal: 1000, emi: 100, start_month: M, note: 'SECRET-789' });
    expect(res.status).toBe(500);
    const all = JSON.stringify([warn.mock.calls, error.mock.calls]);
    expect(all).toMatch(/\[hrms\] POST \/hrms\/payroll\/loans -> 400 VALIDATION/);
    expect(all).toMatch(/\[hrms\] POST \/hrms\/payroll\/loans -> 500/);
    expect(all).not.toContain('SECRET-123');
    expect(all).not.toContain('SECRET-789');
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});
