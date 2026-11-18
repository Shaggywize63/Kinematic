/**
 * HRMS phase 8 (the Compensation module on the server), driven over HTTP through the real router and services against the
 * in-memory PostgREST double (tests/helpers/hrmsFakeDb.ts, which also stands in for hrms_merit_record_applied). Covers the
 * gate + scope, the bootstrap shape from empty, the pay bands (seed / create / save / publish with validateBand's words),
 * the two performance maps (band + reply, per-field so neither clobbers the other), and the merit cycle: the open-only
 * setters, the submit / approve blockers reproduced from the real people, the status machine with each refusal, and the
 * atomic recordApplied (approved-only, once per person). The SQL itself is proven by the migration apply; the pure maths
 * (compa-ratio, guidelines, membership) matches the dashboard's compEngine.
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
import { IDS, MASTER, ORG, seedCompany, seedPeople } from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/compensation';
const today = (): string => new Date().toISOString().slice(0, 10);
const LETTER = '77777777-7777-4777-8777-777777777777';

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

const GOOD_BAND = { grade: 'E3', min: 1200000, mid: 1600000, max: 2000000, market: 1650000 };
const setGrade = (grade: string) => { (fake.tables.hrms_designations ?? []).forEach((d) => { if (d.id === IDS.DSG) d.grade = grade; }); };
const aarav = () => people.aarav!.id;

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use Compensation', () => {
  it('is refused while viewing as another user (the shared HRMS gate)', async () => {
    user = { ...MASTER, impersonated_by: '00000000-0000-4000-8000-0000000000cc' };
    refused(await api().get(`${P}/bootstrap`), 403, 'FORBIDDEN');
  });
  it('503 while the tables are missing', async () => {
    fake.missing.add('hrms_comp_bands');
    refused(await api().get(`${P}/bootstrap`), 503, 'HRMS_NOT_READY');
  });
});

describe('bootstrap from empty', () => {
  it('returns empty bands / perf and a default draft cycle', async () => {
    const data = ok(await api().get(`${P}/bootstrap`));
    expect(data.bands).toEqual([]);
    expect(data.perf).toEqual({});
    expect(data.perf_notes).toEqual({});
    expect(data.cycle).toMatchObject({ status: 'draft', effective_on: today(), proposals: {}, applied: {} });
    expect(data.cycle.guidelines.exceeds.low).toEqual({ min: 10, max: 15 });
    expect(typeof data.server_time).toBe('string');
  });
});

describe('pay bands', () => {
  it('seeds the standard template, idempotently', async () => {
    const first = ok(await api().post(`${P}/bands/seed`));
    expect(first.created).toBe(6);
    expect(first.bands.map((b: Row) => b.grade)).toEqual(['E1', 'E2', 'E3', 'M1', 'M3', 'W1']); // ordered by grade
    const again = ok(await api().post(`${P}/bands/seed`));
    expect(again.created).toBe(0);
    expect(again.bands).toHaveLength(6);
  });

  it('creates a band, and rejects a duplicate grade', async () => {
    const band = ok(await api().post(`${P}/bands`).send(GOOD_BAND), 201);
    expect(band).toMatchObject({ grade: 'E3', min: 1200000, mid: 1600000, max: 2000000, published: false });
    refused(await api().post(`${P}/bands`).send(GOOD_BAND), 400, 'VALIDATION', /already a pay band for grade E3/);
  });

  it('rejects an out-of-order band with the dashboard words', async () => {
    refused(await api().post(`${P}/bands`).send({ ...GOOD_BAND, mid: 1000000 }), 400, 'VALIDATION', 'The minimum must be below the midpoint, and the midpoint below the maximum.');
  });

  it('saves a band, publishes it, and 404s an unknown grade', async () => {
    await api().post(`${P}/bands`).send(GOOD_BAND);
    const saved = ok(await api().put(`${P}/bands/E3`).send({ min: 1300000, mid: 1700000, max: 2100000, market: 1700000 }));
    expect(saved).toMatchObject({ grade: 'E3', min: 1300000, max: 2100000 });
    const pub = ok(await api().put(`${P}/bands/E3/published`).send({ published: true }));
    expect(pub.published).toBe(true);
    refused(await api().put(`${P}/bands/Z9`).send({ min: 100000, mid: 120000, max: 150000, market: 130000 }), 404, 'NOT_FOUND');
  });
});

describe('performance band + reply', () => {
  it('sets a band and a reply without either clobbering the other', async () => {
    ok(await api().put(`${P}/perf/${aarav()}`).send({ band: 'meets' }));
    ok(await api().put(`${P}/perf/${aarav()}/reply`).send({ reply: 'I was on leave in August.' }));
    const data = ok(await api().get(`${P}/bootstrap`));
    expect(data.perf[aarav()]).toBe('meets');
    expect(data.perf_notes[aarav()]).toMatchObject({ reply: 'I was on leave in August.' });
  });
});

describe('merit cycle — setters are open-only', () => {
  it('sets the budget, rejects an out-of-range one, and rejects a past effective date', async () => {
    const c = ok(await api().put(`${P}/cycle`).send({ budget_pct: 8 }));
    expect(c.budget_pct).toBe(8);
    refused(await api().put(`${P}/cycle`).send({ budget_pct: 40 }), 400, 'VALIDATION', 'Use a budget from 0 to 30 percent.');
    refused(await api().put(`${P}/cycle`).send({ effective_on: '2020-01-01' }), 400, 'VALIDATION', 'Choose a date that is today or later.');
  });

  it('sets a guideline and rejects an impossible one', async () => {
    const c = ok(await api().put(`${P}/cycle/guidelines`).send({ perf: 'meets', zone: 'mid', min: 5, max: 9 }));
    expect(c.guidelines.meets.mid).toEqual({ min: 5, max: 9 });
    refused(await api().put(`${P}/cycle/guidelines`).send({ perf: 'meets', zone: 'mid', min: 5, max: 90 }), 400, 'VALIDATION', 'Use values from 0 to 50 percent.');
  });

  it('enters and clears a proposal', async () => {
    const set = ok(await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: 6 }));
    expect(set.proposals[aarav()]).toMatchObject({ pct: 6, by: 'Sagar B' });
    const cleared = ok(await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: null }));
    expect(cleared.proposals[aarav()]).toBeUndefined();
  });
});

describe('merit cycle — submit / decide / reopen', () => {
  it('refuses to submit with no proposals', async () => {
    await api().put(`${P}/cycle`).send({ budget_pct: 8 });
    refused(await api().post(`${P}/cycle/submit`), 400, 'VALIDATION', 'Enter at least one proposed increment.');
  });

  it('refuses to submit a proposal outside the guidance with no reason', async () => {
    setGrade('E3');
    await api().post(`${P}/bands`).send(GOOD_BAND);                       // aarav: ctc 12L, mid 16L -> compa 0.75 (low); unrated/low = 3..5%
    await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: 20 }); // 20% is outside, no reason
    refused(await api().post(`${P}/cycle/submit`), 400, 'VALIDATION', '1 proposal is outside the guidance and needs a reason.');
  });

  it('submits, then approves; a return needs a note', async () => {
    await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: 5 });  // grade null -> band missing -> no reason needed
    expect(ok(await api().post(`${P}/cycle/submit`)).status).toBe('submitted');
    refused(await api().post(`${P}/cycle/decide`).send({ decision: 'return' }), 400, 'VALIDATION', 'Tell the managers what to change.');
    const approved = ok(await api().post(`${P}/cycle/decide`).send({ decision: 'approve' }));
    expect(approved).toMatchObject({ status: 'approved', decision: { by: 'Sagar B' } });
  });

  it('locks proposals once the cycle is submitted', async () => {
    await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: 5 });
    await api().post(`${P}/cycle/submit`);
    refused(await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: 7 }), 400, 'VALIDATION', 'Proposals are locked while the cycle is with HR or approved.');
  });
});

describe('recordApplied', () => {
  async function approveCycle(): Promise<void> {
    await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: 5 });
    await api().post(`${P}/cycle/submit`);
    await api().post(`${P}/cycle/decide`).send({ decision: 'approve' });
  }

  it('records an increment on an approved cycle, once per person', async () => {
    await approveCycle();
    const c = ok(await api().post(`${P}/cycle/applied/${aarav()}`).send({ from: 1200000, to: 1260000, letter_id: LETTER }));
    expect(c.applied[aarav()]).toMatchObject({ from: 1200000, to: 1260000, letterId: LETTER, by: 'Sagar B' });
    refused(await api().post(`${P}/cycle/applied/${aarav()}`).send({ from: 1200000, to: 1260000, letter_id: LETTER }), 400, 'VALIDATION', 'An increment was already issued to this person in this cycle.');
  });

  it('refuses to record against a cycle HR has not approved', async () => {
    await api().put(`${P}/cycle/proposals/${aarav()}`).send({ pct: 5 });  // creates a draft cycle
    refused(await api().post(`${P}/cycle/applied/${aarav()}`).send({ from: 1200000, to: 1260000, letter_id: LETTER }), 400, 'VALIDATION', 'HR has not approved the cycle yet.');
  });

  it('blocks reopening once an increment is applied', async () => {
    await approveCycle();
    await api().post(`${P}/cycle/applied/${aarav()}`).send({ from: 1200000, to: 1260000, letter_id: LETTER });
    refused(await api().post(`${P}/cycle/reopen`), 400, 'VALIDATION', 'Some increments are already issued, so the cycle cannot be reopened.');
  });

  it('reopens an approved cycle with nothing applied', async () => {
    await approveCycle();
    expect(ok(await api().post(`${P}/cycle/reopen`)).status).toBe('draft');
  });
});
