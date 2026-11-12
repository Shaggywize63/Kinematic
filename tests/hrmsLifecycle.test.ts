/**
 * HRMS phase 4 (Lifecycle + Letters on the server), driven over HTTP through the real router and services against the in-memory
 * PostgREST double (tests/helpers/hrmsFakeDb.ts). Covers the service layer: the gate, scoping, the bootstrap shape, validation and every
 * refusal (with the dashboard's own words), idempotent creates, the enum checks, the close-exit blocker (both reasons, refuses then
 * succeeds), letters/templates round-trip, and 503 HRMS_NOT_READY. The SQL (constraints, the fks, the delete behaviours end to end) is
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
import { MASTER, ORG, OTHER_ORG, seedCompany, seedPeople, uid } from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/lifecycle';

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

/** Seed a full-and-final case for an employee at a given status (what the close blocker reads). */
const seedFnf = (employeeId: string, status: 'draft' | 'approved' | 'paid', lastWorkingDate = '2026-11-30', over: Row = {}) =>
  t('hrms_fnf_cases').push({ id: uid(t('hrms_fnf_cases').length + 1, 'f'), employee_id: employeeId, last_working_date: lastWorkingDate, resignation_date: null, notice_days_served: 0, leave_encash_days: 0, other_recoveries: 0, other_payments: 0, status, due_by: '2026-12-03', ...stamp, ...over });

const GOOD_ONBOARDING = { name: 'Aditya Bhat', role: 'Software Engineer', join_date: '2026-12-01', stage: 'offer', tasks: [{ id: 't1', label: 'Offer accepted and e-signed', owner: 'HR', done: false, dueOn: '2026-11-24' }] };
const GOOD_EXIT = { reason: 'resignation', resignation_date: '2026-10-30', last_working_date: '2026-11-30', notice_waived: false, stage: 'notice', clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: false }], assets: [{ id: 'a1', name: 'Laptop', returned: false }], interview_done: false };
const GOOD_TEMPLATE = { type: 'offer', name: 'Offer letter', body: 'Dear {{employee_name}},\n\nWe are pleased to offer you the position of {{designation}}.\n\nSincerely,\n{{signatory}}' };

const mkOnboarding = async (over: Row = {}) => ok(await api().post(`${P}/onboarding`).send({ ...GOOD_ONBOARDING, ...over }), 201);
const mkExit = async (over: Row = {}) => ok(await api().post(`${P}/exits`).send({ employee_id: people.aarav!.id, ...GOOD_EXIT, ...over }), 201);
const mkTemplate = async (over: Row = {}) => ok(await api().post(`${P}/letter-templates`).send({ ...GOOD_TEMPLATE, ...over }), 201);
const mkLetter = async (over: Row = {}) => ok(await api().post(`${P}/letters`).send({ employee_id: people.aarav!.id, template_id: null, type: 'offer', issued_on: '2026-11-12', body: 'Dear Aarav, ... Sincerely.', signed: false, ...over }), 201);

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use Lifecycle + Letters, and which rows it reaches', () => {
  const routes: Array<[string, string, any?]> = [
    ['get', '/bootstrap'],
    ['post', '/onboarding', {}], ['put', `/onboarding/${uid(1)}`, {}], ['delete', `/onboarding/${uid(1)}`],
    ['post', '/exits', {}], ['put', `/exits/${uid(1)}`, {}], ['delete', `/exits/${uid(1)}`],
    ['post', '/letter-templates', {}], ['put', `/letter-templates/${uid(1)}`, {}], ['delete', `/letter-templates/${uid(1)}`],
    ['post', '/letters', {}], ['put', `/letters/${uid(1)}`, {}], ['delete', `/letters/${uid(1)}`],
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
    const onb = await mkOnboarding();
    const tpl = await mkTemplate();
    await mkExit();
    await mkLetter({ template_id: tpl.id });
    await api().put(`${P}/onboarding/${onb.id}`).send({ stage: 'documents' });
    await api().get(`${P}/bootstrap`);
    const queries = fake.log.filter((q) => ['hrms_onboarding_cases', 'hrms_exit_cases', 'hrms_letter_templates', 'hrms_issued_letters'].includes(q.table));
    expect(queries.length).toBeGreaterThanOrEqual(8);
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
    await api().post(`${P}/letter-templates`).send(GOOD_TEMPLATE).set('X-Client-Id', CLIENT);
    await api().get(`${P}/bootstrap`).set('X-Client-Id', CLIENT);
    for (const q of fake.log) {
      expect(JSON.stringify(q.filters)).not.toContain(CLIENT);
      expect(JSON.stringify(q.rows ?? [])).not.toContain(CLIENT);
    }
    for (const r of t('hrms_letter_templates')) expect(r.client_id).toBeNull();
  });

  it("never sees another org's lifecycle rows, and bootstrap shows none of them", async () => {
    const other = { org_id: OTHER_ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
    t('hrms_onboarding_cases').push({ id: uid(41, 'b'), employee_id: null, name: 'Theirs', role: 'X', join_date: '2026-01-01', stage: 'offer', tasks: [], ...other });
    t('hrms_exit_cases').push({ id: uid(42, 'b'), employee_id: uid(99, 'b'), reason: 'resignation', resignation_date: '2026-01-01', last_working_date: '2026-02-01', notice_waived: false, stage: 'notice', clearance: [], assets: [], interview_done: false, ...other });
    t('hrms_letter_templates').push({ id: uid(43, 'b'), type: 'offer', name: 'Theirs', body: 'x'.repeat(30), ...other });
    t('hrms_issued_letters').push({ id: uid(44, 'b'), employee_id: uid(99, 'b'), template_id: null, type: 'offer', issued_on: '2026-01-01', body: 'theirs', signed: false, ...other });

    await mkTemplate(); // one of ours
    const boot = ok(await api().get(`${P}/bootstrap`));
    expect([boot.onboarding_cases.length, boot.exit_cases.length, boot.letter_templates.length, boot.issued_letters.length]).toEqual([0, 0, 1, 0]);
    expect(JSON.stringify(boot)).not.toContain(OTHER_ORG);
    for (const [m, p] of [['put', `/onboarding/${uid(41, 'b')}`], ['delete', `/exits/${uid(42, 'b')}`], ['put', `/letter-templates/${uid(43, 'b')}`], ['delete', `/letters/${uid(44, 'b')}`]] as Array<[string, string]>) {
      refused(await (api() as any)[m](`${P}${p}`).send({}), 404, 'NOT_FOUND');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bootstrap', () => {
  it('starts with four empty collections and a server_time', async () => {
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(Object.keys(b).sort()).toEqual(['exit_cases', 'issued_letters', 'letter_templates', 'onboarding_cases', 'server_time']);
    expect([b.onboarding_cases.length, b.exit_cases.length, b.letter_templates.length, b.issued_letters.length]).toEqual([0, 0, 0, 0]);
    expect(typeof b.server_time).toBe('string');
  });

  it('reflects what was created, in the wire shape', async () => {
    await mkOnboarding(); await mkExit(); await mkTemplate(); await mkLetter();
    const b = ok(await api().get(`${P}/bootstrap`));
    expect([b.onboarding_cases.length, b.exit_cases.length, b.letter_templates.length, b.issued_letters.length]).toEqual([1, 1, 1, 1]);
    expect(Object.keys(b.onboarding_cases[0]).sort()).toEqual(['created_at', 'employee_id', 'id', 'join_date', 'name', 'role', 'stage', 'tasks', 'updated_at']);
    expect(Object.keys(b.exit_cases[0]).sort()).toEqual(['assets', 'clearance', 'created_at', 'employee_id', 'id', 'interview_done', 'last_working_date', 'notice_waived', 'reason', 'resignation_date', 'stage', 'updated_at']);
    expect(Object.keys(b.letter_templates[0]).sort()).toEqual(['body', 'created_at', 'id', 'name', 'type', 'updated_at']);
    expect(Object.keys(b.issued_letters[0]).sort()).toEqual(['body', 'created_at', 'employee_id', 'id', 'issued_on', 'signed', 'template_id', 'type', 'updated_at']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('onboarding cases', () => {
  it('creates a case with the nested tasks passed through (camelCase), employee optional', async () => {
    const c = await mkOnboarding({ employee_id: people.fay!.id });
    expect(c.employee_id).toBe(people.fay!.id);
    expect(c.stage).toBe('offer');
    expect(c.tasks).toEqual([{ id: 't1', label: 'Offer accepted and e-signed', owner: 'HR', done: false, dueOn: '2026-11-24' }]);
    // a pre-hire has no employee
    const pre = await mkOnboarding({ employee_id: null });
    expect(pre.employee_id).toBeNull();
  });

  it('does NOT create the employee (only the case is written)', async () => {
    const before = t('hrms_employees').length;
    await mkOnboarding({ employee_id: people.fay!.id });
    expect(t('hrms_employees').length).toBe(before);
  });

  it('refuses an employee_id that is not one of the org', async () => {
    refused(await api().post(`${P}/onboarding`).send({ ...GOOD_ONBOARDING, employee_id: uid(777, 'd') }), 404, 'NOT_FOUND', 'Employee not found');
  });

  it('rejects an unknown stage (enum check)', async () => {
    refused(await api().post(`${P}/onboarding`).send({ ...GOOD_ONBOARDING, stage: 'interviewing' }), 400, 'VALIDATION', /stage/);
  });

  it('requires a name and a join date', async () => {
    refused(await api().post(`${P}/onboarding`).send({ role: 'x', join_date: '2026-12-01' }), 400, 'VALIDATION', /Name is required/);
    refused(await api().post(`${P}/onboarding`).send({ name: 'x', role: 'y', join_date: 'nope' }), 400, 'VALIDATION', /join_date/);
  });

  it('is idempotent on a client id (second POST returns the first, 200)', async () => {
    const id = uid(1, 'c');
    const first = await mkOnboarding({ id });
    const again = ok(await api().post(`${P}/onboarding`).send({ ...GOOD_ONBOARDING, id, name: 'Changed' }), 200);
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('Aditya Bhat'); // the existing row, unchanged
    expect(t('hrms_onboarding_cases').length).toBe(1);
  });

  it('updates partially (stage -> done, like markJoined), tasks replaced whole', async () => {
    const c = await mkOnboarding();
    const up = ok(await api().put(`${P}/onboarding/${c.id}`).send({ stage: 'done' }));
    expect(up.stage).toBe('done');
    expect(up.name).toBe('Aditya Bhat');
    const ticked = ok(await api().put(`${P}/onboarding/${c.id}`).send({ tasks: [{ id: 't1', label: 'Offer accepted and e-signed', owner: 'HR', done: true }] }));
    expect(ticked.tasks[0].done).toBe(true);
  });

  it('deletes a case', async () => {
    const c = await mkOnboarding();
    expect(ok(await api().delete(`${P}/onboarding/${c.id}`))).toEqual({ id: c.id });
    expect(t('hrms_onboarding_cases').length).toBe(0);
    refused(await api().put(`${P}/onboarding/${c.id}`).send({ stage: 'done' }), 404, 'NOT_FOUND', 'Onboarding case not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('exit cases', () => {
  it('creates an exit with clearance + assets passed through', async () => {
    const c = await mkExit();
    expect(c.employee_id).toBe(people.aarav!.id);
    expect(c.stage).toBe('notice');
    expect(c.clearance).toEqual([{ id: 'c1', department: 'IT', owner: 'IT desk', done: false }]);
    expect(c.assets).toEqual([{ id: 'a1', name: 'Laptop', returned: false }]);
  });

  it('refuses an employee_id that is not one of the org', async () => {
    refused(await api().post(`${P}/exits`).send({ ...GOOD_EXIT, employee_id: uid(777, 'd') }), 404, 'NOT_FOUND', 'Employee not found');
  });

  it('rejects an unknown reason and an unknown stage (enum checks)', async () => {
    refused(await api().post(`${P}/exits`).send({ ...GOOD_EXIT, employee_id: people.aarav!.id, reason: 'sabbatical' }), 400, 'VALIDATION', /reason/);
    refused(await api().post(`${P}/exits`).send({ ...GOOD_EXIT, employee_id: people.aarav!.id, stage: 'gardening' }), 400, 'VALIDATION', /stage/);
  });

  it('moves through stages freely until closing', async () => {
    const c = await mkExit();
    expect(ok(await api().put(`${P}/exits/${c.id}`).send({ stage: 'clearance' })).stage).toBe('clearance');
    expect(ok(await api().put(`${P}/exits/${c.id}`).send({ stage: 'settlement' })).stage).toBe('settlement');
  });

  describe('the close blocker (closeExit, both reasons)', () => {
    it('refuses closing while a clearance item is still pending, with the dashboard words', async () => {
      const c = await mkExit({ clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: false }, { id: 'c2', department: 'Finance', owner: 'Finance team', done: true }] });
      seedFnf(people.aarav!.id, 'paid');
      refused(await api().put(`${P}/exits/${c.id}`).send({ stage: 'closed' }), 409, 'EXIT_BLOCKED', '1 of 2 clearances still pending: IT.');
      expect(t('hrms_exit_cases')[0]!.stage).toBe('notice'); // unchanged
    });

    it('refuses closing while there is no full-and-final case, with the dashboard words', async () => {
      const c = await mkExit({ clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: true }] });
      refused(await api().put(`${P}/exits/${c.id}`).send({ stage: 'closed' }), 409, 'EXIT_BLOCKED', 'No full and final case exists yet. Create and pay it on the payroll page.');
    });

    it('refuses closing while the full-and-final case is not paid, naming its status', async () => {
      const c = await mkExit({ clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: true }] });
      seedFnf(people.aarav!.id, 'approved');
      refused(await api().put(`${P}/exits/${c.id}`).send({ stage: 'closed' }), 409, 'EXIT_BLOCKED', 'The full and final case is approved, and it must be paid before the exit can close.');
    });

    it('joins both reasons with a space when both are blocking', async () => {
      const c = await mkExit({ clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: false }] });
      seedFnf(people.aarav!.id, 'draft');
      refused(await api().put(`${P}/exits/${c.id}`).send({ stage: 'closed' }), 409, 'EXIT_BLOCKED',
        '1 of 1 clearances still pending: IT. The full and final case is draft, and it must be paid before the exit can close.');
    });

    it('uses the latest F&F case (most recent last working date), like fnfFor', async () => {
      const c = await mkExit({ clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: true }] });
      seedFnf(people.aarav!.id, 'paid', '2026-09-30');
      seedFnf(people.aarav!.id, 'draft', '2026-11-30'); // newer, not paid -> blocks
      refused(await api().put(`${P}/exits/${c.id}`).send({ stage: 'closed' }), 409, 'EXIT_BLOCKED', /The full and final case is draft/);
    });

    it('closes once every clearance is done and the F&F is paid', async () => {
      const c = await mkExit({ clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: true }] });
      seedFnf(people.aarav!.id, 'paid');
      const closed = ok(await api().put(`${P}/exits/${c.id}`).send({ stage: 'closed' }));
      expect(closed.stage).toBe('closed');
      expect(t('hrms_exit_cases')[0]!.stage).toBe('closed');
    });

    it('reopening a closed exit (closed -> settlement) is never blocked', async () => {
      const c = await mkExit({ clearance: [{ id: 'c1', department: 'IT', owner: 'IT desk', done: true }] });
      seedFnf(people.aarav!.id, 'paid');
      ok(await api().put(`${P}/exits/${c.id}`).send({ stage: 'closed' }));
      expect(ok(await api().put(`${P}/exits/${c.id}`).send({ stage: 'settlement' })).stage).toBe('settlement');
    });
  });

  it('deletes an exit', async () => {
    const c = await mkExit();
    expect(ok(await api().delete(`${P}/exits/${c.id}`))).toEqual({ id: c.id });
    refused(await api().delete(`${P}/exits/${c.id}`), 404, 'NOT_FOUND', 'Exit case not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('letter templates', () => {
  it('creates and round-trips a template', async () => {
    const tpl = await mkTemplate();
    expect(tpl.type).toBe('offer');
    expect(tpl.name).toBe('Offer letter');
    expect(tpl.body).toContain('{{employee_name}}');
  });

  it('applies the dashboard name / body wording', async () => {
    refused(await api().post(`${P}/letter-templates`).send({ type: 'offer', name: 'A', body: GOOD_TEMPLATE.body }), 400, 'VALIDATION', 'Give the template a name');
    refused(await api().post(`${P}/letter-templates`).send({ type: 'offer', name: 'x'.repeat(81), body: GOOD_TEMPLATE.body }), 400, 'VALIDATION', 'Keep the name under 80 characters');
    refused(await api().post(`${P}/letter-templates`).send({ type: 'offer', name: 'Short body', body: 'too short' }), 400, 'VALIDATION', 'The letter body is too short');
  });

  it('rejects an unknown letter type (enum check)', async () => {
    refused(await api().post(`${P}/letter-templates`).send({ ...GOOD_TEMPLATE, type: 'promotion' }), 400, 'VALIDATION', /type/);
  });

  it('is idempotent on a client id', async () => {
    const id = uid(2, 'c');
    const first = await mkTemplate({ id });
    const again = ok(await api().post(`${P}/letter-templates`).send({ ...GOOD_TEMPLATE, id, name: 'Other' }), 200);
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('Offer letter');
  });

  it('updates and deletes a template', async () => {
    const tpl = await mkTemplate();
    expect(ok(await api().put(`${P}/letter-templates/${tpl.id}`).send({ name: 'Offer letter (2026)' })).name).toBe('Offer letter (2026)');
    expect(ok(await api().delete(`${P}/letter-templates/${tpl.id}`))).toEqual({ id: tpl.id });
    refused(await api().put(`${P}/letter-templates/${tpl.id}`).send({ name: 'x' }), 404, 'NOT_FOUND', 'Template not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('issued letters (the register)', () => {
  it('issues a letter linked to a template, round-trips the fields', async () => {
    const tpl = await mkTemplate();
    const l = await mkLetter({ template_id: tpl.id, type: 'offer', body: 'Dear Aarav, we are pleased to offer you the role.' });
    expect(l.employee_id).toBe(people.aarav!.id);
    expect(l.template_id).toBe(tpl.id);
    expect(l.signed).toBe(false);
    expect(l.body).toContain('pleased to offer');
  });

  it('allows an ad-hoc letter with a null template_id', async () => {
    const l = await mkLetter({ template_id: null });
    expect(l.template_id).toBeNull();
  });

  it('refuses an employee not of the org, and a template not of the org', async () => {
    refused(await api().post(`${P}/letters`).send({ employee_id: uid(777, 'd'), template_id: null, type: 'offer', issued_on: '2026-11-12', body: 'x'.repeat(10) }), 404, 'NOT_FOUND', 'Employee not found');
    refused(await api().post(`${P}/letters`).send({ employee_id: people.aarav!.id, template_id: uid(778, 'd'), type: 'offer', issued_on: '2026-11-12', body: 'x'.repeat(10) }), 404, 'NOT_FOUND', 'Template not found');
  });

  it('rejects an unknown type and an empty body', async () => {
    refused(await api().post(`${P}/letters`).send({ employee_id: people.aarav!.id, template_id: null, type: 'promotion', issued_on: '2026-11-12', body: 'x' }), 400, 'VALIDATION', /type/);
    refused(await api().post(`${P}/letters`).send({ employee_id: people.aarav!.id, template_id: null, type: 'offer', issued_on: '2026-11-12', body: '   ' }), 400, 'VALIDATION', 'The letter body is empty');
  });

  it('marks a letter signed via PUT (markLetterSigned)', async () => {
    const l = await mkLetter();
    const signed = ok(await api().put(`${P}/letters/${l.id}`).send({ signed: true }));
    expect(signed.signed).toBe(true);
    expect(signed.id).toBe(l.id);
  });

  it('nulls template_id on issued letters when the template is deleted (set null)', async () => {
    const tpl = await mkTemplate();
    const l = await mkLetter({ template_id: tpl.id });
    expect(l.template_id).toBe(tpl.id);
    // The DB does the SET NULL; here the service-level delete just succeeds (the FK behaviour is proven in PGlite).
    expect(ok(await api().delete(`${P}/letter-templates/${tpl.id}`))).toEqual({ id: tpl.id });
  });

  it('deletes a letter', async () => {
    const l = await mkLetter();
    expect(ok(await api().delete(`${P}/letters/${l.id}`))).toEqual({ id: l.id });
    refused(await api().delete(`${P}/letters/${l.id}`), 404, 'NOT_FOUND', 'Letter not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('503 HRMS_NOT_READY when the tables are missing', () => {
  it('bootstrap answers 503 when a lifecycle table is not there', async () => {
    fake.missing.add('hrms_onboarding_cases');
    refused(await api().get(`${P}/bootstrap`), 503, 'HRMS_NOT_READY', 'HRMS storage is not set up yet');
  });

  it('a create answers 503 when its table is missing', async () => {
    fake.missing.add('hrms_letter_templates');
    refused(await api().post(`${P}/letter-templates`).send(GOOD_TEMPLATE), 503, 'HRMS_NOT_READY', 'HRMS storage is not set up yet');
  });
});
