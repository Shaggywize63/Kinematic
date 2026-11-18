/**
 * HRMS phase 9 (Timesheets on the server), driven over HTTP through the real router and services against the in-memory
 * PostgREST double (tests/helpers/hrmsFakeDb.ts). Covers the gate + not-ready, the bootstrap from empty, projects (create,
 * duplicate names, idempotent retry, edit, archive), the company limits with the dashboard's words, who tracks time, and a
 * week's whole life: draft lines (project rules, the remove-row rule, locked weeks), submit (empty, 0.25 h steps, future
 * days, the daily limit), and approve / return (a return needs a comment; approve locks).
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
import { MASTER, seedCompany, seedPeople } from './helpers/hrmsPayrollScenario';
import { addDays, todayIst } from '../src/services/hrms/timesheets/engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/timesheets';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

/** The Monday of the week holding a date. */
const mondayOf = (iso: string): string => { const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); return addDays(iso, -((dow + 6) % 7)); };
const THIS_WEEK = mondayOf(todayIst());
const PAST_WEEK = addDays(THIS_WEEK, -14);   // every day of it has happened
const NEXT_WEEK = addDays(THIS_WEEK, 7);     // none of it has

let people: Record<string, Row>;
beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const ok = (res: request.Response, status = 200) => { expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined }); return res.body.data; };
const refused = (res: request.Response, status: number, code: string, error?: string | RegExp) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, code });
  if (typeof error === 'string') expect(res.body.error).toBe(error);
  else if (error) expect(res.body.error).toMatch(error);
};

const aarav = () => people.aarav!.id as string;
const bela = () => people.bela!.id as string;
const week = (h: number[]) => h.concat(Array(7 - h.length).fill(0));

async function project(name = 'Northwind: fulfilment', extra: Row = {}): Promise<Row> {
  return ok(await api().post(`${P}/projects`).send({ name, client: 'Northwind', kind: 'client', billable: true, budget_hours: 100, rate: 500, ...extra }), 201);
}
async function track(...ids: string[]): Promise<void> { ok(await api().put(`${P}/tracked`).send({ employee_ids: ids })); }

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use Timesheets', () => {
  it('is refused while viewing as another user (the shared HRMS gate)', async () => {
    user = { ...MASTER, impersonated_by: '00000000-0000-4000-8000-0000000000cc' };
    refused(await api().get(`${P}/bootstrap`), 403, 'FORBIDDEN');
  });
  it('503 while the tables are missing', async () => {
    fake.missing.add('hrms_ts_projects');
    refused(await api().get(`${P}/bootstrap`), 503, 'HRMS_NOT_READY');
  });
});

describe('bootstrap from empty', () => {
  it('returns the default limits, nobody tracked, no projects, no weeks, and today in India', async () => {
    const data = ok(await api().get(`${P}/bootstrap`));
    expect(data.policy).toEqual({ max_per_day: 12, weekly_cap: 60, standard_week: 40 });
    expect(data.tracked_ids).toEqual([]);
    expect(data.projects).toEqual([]);
    expect(data.sheets).toEqual([]);
    expect(data.today).toBe(todayIst());
  });
});

describe('projects', () => {
  it('creates, refuses a duplicate name (any case), and answers a retry with the same id', async () => {
    const id = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const p = ok(await api().post(`${P}/projects`).send({ id, name: 'Helio portal', client: 'Helio', kind: 'client', billable: true, rate: 2200 }), 201);
    expect(p).toMatchObject({ id, name: 'Helio portal', kind: 'client', billable: true, rate: 2200, archived: false });
    expect(ok(await api().post(`${P}/projects`).send({ id, name: 'Helio portal', client: 'Helio', kind: 'client', billable: true }), 200).id).toBe(id);
    refused(await api().post(`${P}/projects`).send({ name: 'HELIO PORTAL', kind: 'client', billable: true }), 400, 'VALIDATION', 'There is already a project called HELIO PORTAL.');
  });

  it('a non-billable project carries no rate; edit and archive; 404 for an unknown one', async () => {
    const p = ok(await api().post(`${P}/projects`).send({ name: 'Internal: admin', kind: 'internal', billable: false, rate: 900 }), 201);
    expect(p.rate).toBe(0);
    const edited = ok(await api().put(`${P}/projects/${p.id}`).send({ budget_hours: 400, archived: true }));
    expect(edited).toMatchObject({ budget_hours: 400, archived: true });
    refused(await api().put(`${P}/projects/${UNKNOWN}`).send({ name: 'x' }), 404, 'NOT_FOUND');
  });
});

describe('company limits and who tracks time', () => {
  it('sets the limits and refuses out-of-range ones with the dashboard words', async () => {
    expect(ok(await api().put(`${P}/policy`).send({ max_per_day: 10 })).policy).toEqual({ max_per_day: 10, weekly_cap: 60, standard_week: 40 });
    refused(await api().put(`${P}/policy`).send({ max_per_day: 30 }), 400, 'VALIDATION', 'The daily limit must be between 8 and 24 hours.');
    refused(await api().put(`${P}/policy`).send({ weekly_cap: 10 }), 400, 'VALIDATION', 'The weekly cap must be between 20 and 90 hours.');
    refused(await api().put(`${P}/policy`).send({ standard_week: 70 }), 400, 'VALIDATION', 'The standard week must be at least 20 hours and not above the weekly cap.');
  });

  it('keeps the tracked list (de-duplicated) and refuses someone from outside the company', async () => {
    const data = ok(await api().put(`${P}/tracked`).send({ employee_ids: [aarav(), aarav(), bela()] }));
    expect(data.tracked_ids).toEqual([aarav(), bela()]);
    refused(await api().put(`${P}/tracked`).send({ employee_ids: [UNKNOWN] }), 400, 'VALIDATION', 'Choose people from this company.');
  });
});

describe('a week: draft lines', () => {
  it('refuses someone who does not track time, a non-Monday and an unknown project', async () => {
    const p = await project();
    refused(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([8]) }] }), 400, 'VALIDATION', 'This person does not track time.');
    await track(aarav());
    refused(await api().put(`${P}/sheets/${aarav()}/${addDays(PAST_WEEK, 1)}`).send({ lines: [] }), 400, 'VALIDATION', 'Choose the Monday a week starts on.');
    refused(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: UNKNOWN, hours: week([8]) }] }), 400, 'VALIDATION', 'Choose a project from the list.');
  });

  it('saves a draft, keeps one row per project, and will not drop a row that has hours', async () => {
    const p = await project(); const q = await project('Orbit pilot');
    await track(aarav());
    const s = ok(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([8, 8]) }, { projectId: q.id, hours: week([]) }] }));
    expect(s).toMatchObject({ employee_id: aarav(), week_start: PAST_WEEK, status: 'draft' });
    expect(s.lines).toEqual([{ projectId: p.id, hours: week([8, 8]) }, { projectId: q.id, hours: week([]) }]);
    refused(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([1]) }, { projectId: p.id, hours: week([1]) }] }), 400, 'VALIDATION', 'That project is already on the sheet.');
    refused(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: q.id, hours: week([]) }] }), 400, 'VALIDATION', 'Set the hours on this row to 0 before removing it.');
    // an empty row can go
    expect(ok(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([8, 8]) }] })).lines).toHaveLength(1);
  });

  it('an archived project stays on the week that had it but cannot be added to a new one', async () => {
    const p = await project();
    await track(aarav());
    ok(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([4]) }] }));
    ok(await api().put(`${P}/projects/${p.id}`).send({ archived: true }));
    ok(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([5]) }] }));
    refused(await api().put(`${P}/sheets/${aarav()}/${addDays(PAST_WEEK, -7)}`).send({ lines: [{ projectId: p.id, hours: week([5]) }] }), 400, 'VALIDATION', 'Choose a project from the list.');
  });
});

describe('a week: submit, approve, return', () => {
  async function draft(hours: number[], wk = PAST_WEEK): Promise<Row> {
    const p = await project();
    await track(aarav());
    return ok(await api().put(`${P}/sheets/${aarav()}/${wk}`).send({ lines: [{ projectId: p.id, hours: week(hours) }] }));
  }

  it('refuses an empty week, steps that are not 0.25 h, a future day and a day over the limit', async () => {
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`), 400, 'VALIDATION', 'Enter some hours before submitting.');
    await draft([0]);
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`), 400, 'VALIDATION', 'Enter some hours before submitting.');
    const p = (await api().get(`${P}/bootstrap`)).body.data.projects[0];
    ok(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([7.3]) }] }));
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`), 400, 'VALIDATION', 'Mon: use steps of 0.25 hour.');
    ok(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([13]) }] }));
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`), 400, 'VALIDATION', 'Mon: 13 hours is above the 12 hour daily limit.');
    ok(await api().put(`${P}/sheets/${aarav()}/${NEXT_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([2]) }] }));
    refused(await api().post(`${P}/sheets/${aarav()}/${NEXT_WEEK}/submit`), 400, 'VALIDATION', /^Mon: \d+ \w{3} \d{4} has not happened yet\.$/);
  });

  it('submits, locks the week, and a return needs a comment', async () => {
    await draft([8, 8, 8]);
    const sub = ok(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`));
    expect(sub).toMatchObject({ status: 'submitted', submitted_on: todayIst() });
    expect(sub.trail).toEqual([{ at: todayIst(), by: 'Aarav Person', action: 'Submitted' }]);
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`), 400, 'VALIDATION', 'This week is already with the approver.');
    const p = (await api().get(`${P}/bootstrap`)).body.data.projects[0];
    refused(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([1]) }] }), 400, 'VALIDATION', 'This week is locked.');
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/decide`).send({ decision: 'returned', comment: 'no' }), 400, 'VALIDATION', 'Say what to fix when returning a week (at least 5 characters).');
    const ret = ok(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/decide`).send({ decision: 'returned', comment: 'Split Tuesday across both projects.' }));
    expect(ret).toMatchObject({ status: 'returned', decided_by: 'Sagar B', comment: 'Split Tuesday across both projects.' });
    // a returned week is editable again and can be resubmitted
    ok(await api().put(`${P}/sheets/${aarav()}/${PAST_WEEK}`).send({ lines: [{ projectId: p.id, hours: week([8, 8, 8, 4]) }] }));
    expect(ok(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`)).status).toBe('submitted');
  });

  it('approve locks the week for good; deciding again is refused', async () => {
    await draft([8]);
    ok(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`));
    const app = ok(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/decide`).send({ decision: 'approved', comment: '' }));
    expect(app).toMatchObject({ status: 'approved', decided_by: 'Sagar B', comment: null });
    expect(app.trail.map((t: Row) => t.action)).toEqual(['Submitted', 'Approved']);
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/decide`).send({ decision: 'approved', comment: '' }), 400, 'VALIDATION', 'Only a submitted week can be approved or returned.');
    refused(await api().post(`${P}/sheets/${aarav()}/${PAST_WEEK}/submit`), 400, 'VALIDATION', 'This week is approved and locked.');
    const boot = ok(await api().get(`${P}/bootstrap`));
    expect(boot.sheets).toHaveLength(1);
    expect(boot.sheets[0]).toMatchObject({ status: 'approved', week_start: PAST_WEEK });
  });
});
