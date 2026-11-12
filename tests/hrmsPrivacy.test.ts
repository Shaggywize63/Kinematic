/**
 * HRMS phase 5 (Privacy/DPDP + Compliance on the server), driven over HTTP through the real router and services against the in-memory
 * PostgREST double (tests/helpers/hrmsFakeDb.ts). Covers the service layer: the gate, scoping, the bootstrap shape, validation and every
 * refusal (with plain words), idempotent creates, the enum / FK checks, markFiled + withdraw round-trips, retention keep_years, and that
 * the EXISTING GET /access-log still works with phase 5 mounted. The SQL (constraints, the fks, the delete behaviours end to end) is
 * proven by the PGlite harness.
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
import { IDS, MASTER, ORG, OTHER_ORG, PANS, seedCompany, seedPeople, uid } from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/privacy';

let people: Record<string, Row>;
beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const t = (name: string): Row[] => (fake.tables[name] ??= []);
const stamp = { org_id: ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const ok = (res: request.Response, status = 200) => { expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined }); return res.body.data; };
const refused = (res: request.Response, status: number, code: string, error?: string | RegExp) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, code });
  if (typeof error === 'string') expect(res.body.error).toBe(error);
  else if (error) expect(res.body.error).toMatch(error);
};

const GOOD_COMPLIANCE = { name: 'TDS deposit for October', law: 'TDS', due_on: '2026-11-07', entity_id: IDS.ENT, state: null };
const GOOD_CONSENT = { purpose: 'Location during duty hours', notice_version: 'v2 (Apr 2026)', granted_at: '2026-04-01T09:00:00.000Z' };
const GOOD_RETENTION = { dataset: 'Location trail', keep_years: 0.25, basis: 'Needed for travel allowance disputes only; 90 days', action: 'delete' };

const mkCompliance = async (over: Row = {}) => ok(await api().post(`${P}/compliance`).send({ ...GOOD_COMPLIANCE, ...over }), 201);
const mkConsent = async (over: Row = {}) => ok(await api().post(`${P}/consents`).send({ employee_id: people.aarav!.id, ...GOOD_CONSENT, ...over }), 201);
const mkRetention = async (over: Row = {}) => ok(await api().post(`${P}/retention`).send({ ...GOOD_RETENTION, ...over }), 201);

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use Privacy/DPDP + Compliance, and which rows it reaches', () => {
  const routes: Array<[string, string, any?]> = [
    ['get', '/bootstrap'],
    ['post', '/compliance', {}], ['put', `/compliance/${uid(1)}`, {}], ['delete', `/compliance/${uid(1)}`],
    ['post', '/consents', {}], ['put', `/consents/${uid(1)}`, {}], ['delete', `/consents/${uid(1)}`],
    ['post', '/retention', {}], ['put', `/retention/${uid(1)}`, {}], ['delete', `/retention/${uid(1)}`],
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
      fake.log.length = 0; user = who;
      expect(await callEach()).toEqual(routes.map(() => 403));
      expect(fake.log).toHaveLength(0);
    }
  });

  it('answers 401 with no user', async () => {
    user = undefined;
    expect((await api().get(`${P}/bootstrap`)).status).toBe(401);
  });

  it('filters every select / update / delete on org_id and client_id IS NULL and stamps every insert', async () => {
    const cmp = await mkCompliance();
    await mkConsent();
    await mkRetention();
    await api().put(`${P}/compliance/${cmp.id}`).send({ filed_on: '2026-11-06' });
    await api().get(`${P}/bootstrap`);
    const queries = fake.log.filter((q) => ['hrms_compliance_tasks', 'hrms_consents', 'hrms_retention_rules'].includes(q.table));
    expect(queries.length).toBeGreaterThanOrEqual(6);
    for (const q of queries) {
      if (q.op === 'insert' || q.op === 'upsert') for (const r of q.rows!) expect(r).toMatchObject({ org_id: ORG, client_id: null });
      else {
        const eqOrg = q.filters.find((f) => f.t === 'eq' && f.col === 'org_id');
        const nullClient = q.filters.find((f) => f.t === 'is' && f.col === 'client_id' && f.val === null);
        expect({ table: q.table, org: eqOrg?.val, clientNull: !!nullClient }).toEqual({ table: q.table, org: ORG, clientNull: true });
      }
    }
  });

  it('ignores X-Client-Id entirely', async () => {
    const CLIENT = '99999999-9999-4999-8999-999999999999';
    await api().post(`${P}/retention`).send(GOOD_RETENTION).set('X-Client-Id', CLIENT);
    await api().get(`${P}/bootstrap`).set('X-Client-Id', CLIENT);
    for (const q of fake.log) {
      expect(JSON.stringify(q.filters)).not.toContain(CLIENT);
      expect(JSON.stringify(q.rows ?? [])).not.toContain(CLIENT);
    }
    for (const r of t('hrms_retention_rules')) expect(r.client_id).toBeNull();
  });

  it("never sees another org's privacy rows, and bootstrap shows none of them", async () => {
    const other = { org_id: OTHER_ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
    t('hrms_compliance_tasks').push({ id: uid(41, 'b'), name: 'Theirs', law: 'PF', due_on: '2026-11-15', entity_id: uid(90, 'b'), state: null, filed_on: null, reference: null, ...other });
    t('hrms_consents').push({ id: uid(42, 'b'), employee_id: uid(99, 'b'), purpose: 'Theirs', notice_version: 'v1', granted_at: '2026-01-01T00:00:00.000Z', withdrawn_at: null, ...other });
    t('hrms_retention_rules').push({ id: uid(43, 'b'), dataset: 'Theirs', keep_years: 5, basis: 'x', action: 'delete', ...other });

    await mkRetention(); // one of ours
    const boot = ok(await api().get(`${P}/bootstrap`));
    expect([boot.compliance_tasks.length, boot.consents.length, boot.retention_rules.length]).toEqual([0, 0, 1]);
    expect(JSON.stringify(boot)).not.toContain(OTHER_ORG);
    for (const [m, p] of [['put', `/compliance/${uid(41, 'b')}`], ['delete', `/consents/${uid(42, 'b')}`], ['put', `/retention/${uid(43, 'b')}`]] as Array<[string, string]>) {
      refused(await (api() as any)[m](`${P}${p}`).send({}), 404, 'NOT_FOUND');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bootstrap', () => {
  it('starts with three empty collections and a server_time (no access_log here)', async () => {
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(Object.keys(b).sort()).toEqual(['compliance_tasks', 'consents', 'retention_rules', 'server_time']);
    expect([b.compliance_tasks.length, b.consents.length, b.retention_rules.length]).toEqual([0, 0, 0]);
    expect(typeof b.server_time).toBe('string');
  });

  it('reflects what was created, in the wire shape (compliance has NO status)', async () => {
    await mkCompliance(); await mkConsent(); await mkRetention();
    const b = ok(await api().get(`${P}/bootstrap`));
    expect([b.compliance_tasks.length, b.consents.length, b.retention_rules.length]).toEqual([1, 1, 1]);
    expect(Object.keys(b.compliance_tasks[0]).sort()).toEqual(['created_at', 'due_on', 'entity_id', 'filed_on', 'id', 'law', 'name', 'reference', 'state', 'updated_at']);
    expect(b.compliance_tasks[0]).not.toHaveProperty('status');
    expect(Object.keys(b.consents[0]).sort()).toEqual(['created_at', 'employee_id', 'granted_at', 'id', 'notice_version', 'purpose', 'updated_at', 'withdrawn_at']);
    expect(Object.keys(b.retention_rules[0]).sort()).toEqual(['action', 'basis', 'created_at', 'dataset', 'id', 'keep_years', 'updated_at']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('compliance tasks', () => {
  it('creates a task for an entity, with no status in the response', async () => {
    const c = await mkCompliance();
    expect(c.law).toBe('TDS');
    expect(c.entity_id).toBe(IDS.ENT);
    expect(c.filed_on).toBeNull();
    expect(c.reference).toBeNull();
    expect(c).not.toHaveProperty('status');
  });

  it('keeps an optional state (e.g. a PT task for a state)', async () => {
    const c = await mkCompliance({ law: 'PT', name: 'Professional tax, Maharashtra, October', state: 'Maharashtra' });
    expect(c.state).toBe('Maharashtra');
  });

  it('refuses an entity_id that is not one of the org', async () => {
    refused(await api().post(`${P}/compliance`).send({ ...GOOD_COMPLIANCE, entity_id: uid(777, 'd') }), 404, 'NOT_FOUND', 'Entity not found');
  });

  it('rejects an unknown law (enum check)', async () => {
    refused(await api().post(`${P}/compliance`).send({ ...GOOD_COMPLIANCE, law: 'VAT' }), 400, 'VALIDATION', /law/);
  });

  it('requires a name and a valid due date', async () => {
    refused(await api().post(`${P}/compliance`).send({ law: 'TDS', due_on: '2026-11-07', entity_id: IDS.ENT }), 400, 'VALIDATION', /Name is required/);
    refused(await api().post(`${P}/compliance`).send({ ...GOOD_COMPLIANCE, due_on: 'nope' }), 400, 'VALIDATION', /due_on/);
  });

  it('is idempotent on a client id (second POST returns the first, 200)', async () => {
    const id = uid(1, 'c');
    const first = await mkCompliance({ id });
    const again = ok(await api().post(`${P}/compliance`).send({ ...GOOD_COMPLIANCE, id, name: 'Changed' }), 200);
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('TDS deposit for October');
    expect(t('hrms_compliance_tasks').length).toBe(1);
  });

  it('markFiled: PUT sets filed_on and reference; reopen clears them', async () => {
    const c = await mkCompliance();
    const filed = ok(await api().put(`${P}/compliance/${c.id}`).send({ filed_on: '2026-11-06', reference: 'CHL-7F3A1' }));
    expect(filed.filed_on).toBe('2026-11-06');
    expect(filed.reference).toBe('CHL-7F3A1');
    expect(filed).not.toHaveProperty('status');
    const reopened = ok(await api().put(`${P}/compliance/${c.id}`).send({ filed_on: null, reference: null }));
    expect(reopened.filed_on).toBeNull();
    expect(reopened.reference).toBeNull();
  });

  it('updates the entity, validating the new entity belongs to the org', async () => {
    const c = await mkCompliance();
    expect(ok(await api().put(`${P}/compliance/${c.id}`).send({ entity_id: IDS.ENT2 })).entity_id).toBe(IDS.ENT2);
    refused(await api().put(`${P}/compliance/${c.id}`).send({ entity_id: uid(778, 'd') }), 404, 'NOT_FOUND', 'Entity not found');
  });

  it('deletes a task', async () => {
    const c = await mkCompliance();
    expect(ok(await api().delete(`${P}/compliance/${c.id}`))).toEqual({ id: c.id });
    expect(t('hrms_compliance_tasks').length).toBe(0);
    refused(await api().put(`${P}/compliance/${c.id}`).send({ law: 'PF' }), 404, 'NOT_FOUND', 'Compliance task not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('consent records', () => {
  it('creates a consent for an employee, active (no withdrawal)', async () => {
    const c = await mkConsent();
    expect(c.employee_id).toBe(people.aarav!.id);
    expect(c.purpose).toBe('Location during duty hours');
    expect(c.notice_version).toBe('v2 (Apr 2026)');
    expect(c.withdrawn_at).toBeNull();
  });

  it('refuses an employee_id that is not one of the org', async () => {
    refused(await api().post(`${P}/consents`).send({ ...GOOD_CONSENT, employee_id: uid(777, 'd') }), 404, 'NOT_FOUND', 'Employee not found');
  });

  it('requires a purpose, a notice version and an ISO granted_at', async () => {
    refused(await api().post(`${P}/consents`).send({ employee_id: people.aarav!.id, notice_version: 'v1', granted_at: GOOD_CONSENT.granted_at }), 400, 'VALIDATION', /Purpose is required/);
    refused(await api().post(`${P}/consents`).send({ employee_id: people.aarav!.id, purpose: 'x', granted_at: GOOD_CONSENT.granted_at }), 400, 'VALIDATION', /Notice version is required/);
    refused(await api().post(`${P}/consents`).send({ employee_id: people.aarav!.id, purpose: 'x', notice_version: 'v1', granted_at: 'nope' }), 400, 'VALIDATION', /granted_at/);
  });

  it('is idempotent on a client id', async () => {
    const id = uid(2, 'c');
    const first = await mkConsent({ id });
    const again = ok(await api().post(`${P}/consents`).send({ employee_id: people.aarav!.id, ...GOOD_CONSENT, id, purpose: 'Changed' }), 200);
    expect(again.id).toBe(first.id);
    expect(again.purpose).toBe('Location during duty hours');
  });

  it('withdraw (PUT withdrawn_at) keeps the row, and re-granting clears it', async () => {
    const c = await mkConsent();
    const withdrawn = ok(await api().put(`${P}/consents/${c.id}`).send({ withdrawn_at: '2026-09-02T11:00:00.000Z' }));
    expect(withdrawn.withdrawn_at).toBe('2026-09-02T11:00:00.000Z');
    expect(t('hrms_consents').length).toBe(1); // the row stays on the ledger
    const regranted = ok(await api().put(`${P}/consents/${c.id}`).send({ withdrawn_at: null }));
    expect(regranted.withdrawn_at).toBeNull();
  });

  it('deletes a consent', async () => {
    const c = await mkConsent();
    expect(ok(await api().delete(`${P}/consents/${c.id}`))).toEqual({ id: c.id });
    refused(await api().put(`${P}/consents/${c.id}`).send({ purpose: 'x' }), 404, 'NOT_FOUND', 'Consent record not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('retention rules', () => {
  it('creates a rule and round-trips a sub-year keep period as a number', async () => {
    const r = await mkRetention({ dataset: 'Face templates', keep_years: 0.08, action: 'delete' });
    expect(r.keep_years).toBe(0.08);
    expect(r.action).toBe('delete');
    expect(typeof r.keep_years).toBe('number');
  });

  it('rejects a negative keep period, an empty dataset and an empty basis, with plain words', async () => {
    refused(await api().post(`${P}/retention`).send({ ...GOOD_RETENTION, keep_years: -1 }), 400, 'VALIDATION', 'Keep period cannot be negative');
    refused(await api().post(`${P}/retention`).send({ ...GOOD_RETENTION, dataset: '   ' }), 400, 'VALIDATION', 'Give the dataset a name');
    refused(await api().post(`${P}/retention`).send({ ...GOOD_RETENTION, basis: '   ' }), 400, 'VALIDATION', 'Give a basis for keeping it');
  });

  it('allows zero years (delete immediately)', async () => {
    expect((await mkRetention({ dataset: 'Scratch logs', keep_years: 0 })).keep_years).toBe(0);
  });

  it('rejects an unknown action (enum check)', async () => {
    refused(await api().post(`${P}/retention`).send({ ...GOOD_RETENTION, action: 'archive' }), 400, 'VALIDATION', /action/);
  });

  it('is idempotent on a client id', async () => {
    const id = uid(3, 'c');
    const first = await mkRetention({ id });
    const again = ok(await api().post(`${P}/retention`).send({ ...GOOD_RETENTION, id, dataset: 'Changed' }), 200);
    expect(again.id).toBe(first.id);
    expect(again.dataset).toBe('Location trail');
  });

  it('updates keep_years and action (like the dashboard EditModal)', async () => {
    const r = await mkRetention();
    const up = ok(await api().put(`${P}/retention/${r.id}`).send({ keep_years: 1.5, action: 'anonymise' }));
    expect(up.keep_years).toBe(1.5);
    expect(up.action).toBe('anonymise');
    expect(up.dataset).toBe('Location trail'); // unchanged
    refused(await api().put(`${P}/retention/${r.id}`).send({ keep_years: -2 }), 400, 'VALIDATION', 'Keep period cannot be negative');
  });

  it('deletes a rule', async () => {
    const r = await mkRetention();
    expect(ok(await api().delete(`${P}/retention/${r.id}`))).toEqual({ id: r.id });
    refused(await api().delete(`${P}/retention/${r.id}`), 404, 'NOT_FOUND', 'Retention rule not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the Access log tab reads the EXISTING server access log (phase 1), unchanged by phase 5', () => {
  it('a reveal in Employees writes a row that GET /access-log returns, newest first', async () => {
    expect(ok(await api().get('/hrms/access-log'))).toEqual([]);
    const r = ok(await api().post(`/hrms/employees/${people.aarav!.id}/reveal`).send({ field: 'pan', reason: 'Checking against the PAN card' }));
    expect(r).toEqual({ field: 'pan', value: PANS.aarav });
    const log = ok(await api().get('/hrms/access-log'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ by_name: 'Sagar B', employee_id: people.aarav!.id, field: 'pan', reason: 'Checking against the PAN card' });
    // scoped to one employee too
    expect(ok(await api().get(`/hrms/access-log?employee_id=${people.aarav!.id}`))).toHaveLength(1);
    expect(ok(await api().get(`/hrms/access-log?employee_id=${people.bela!.id}`))).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('503 HRMS_NOT_READY when the tables are missing', () => {
  it('bootstrap answers 503 when a privacy table is not there', async () => {
    fake.missing.add('hrms_compliance_tasks');
    refused(await api().get(`${P}/bootstrap`), 503, 'HRMS_NOT_READY', 'HRMS storage is not set up yet');
  });

  it('a create answers 503 when its table is missing', async () => {
    fake.missing.add('hrms_retention_rules');
    refused(await api().post(`${P}/retention`).send(GOOD_RETENTION), 503, 'HRMS_NOT_READY', 'HRMS storage is not set up yet');
  });
});
