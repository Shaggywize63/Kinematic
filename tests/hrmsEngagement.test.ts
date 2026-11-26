/**
 * HRMS phase 11 (Engagement on the server), driven over HTTP through the real router and services against the in-memory
 * PostgREST double (tests/helpers/hrmsFakeDb.ts). Covers the empty bootstrap (values seeded, idempotent), sending a pulse
 * (the dashboard's validation words, opens today + closes in 14 days, questions numbered), closing a pulse (idempotent),
 * anonymous responses (no person is stored; answers cleaned to the question type; empty / closed / unknown refused),
 * recognition (validation, value + person must exist), exit interviews (reasons 1..3, one per case), and the activity log.
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
import { STANDARD_VALUES } from '../src/services/hrms/engagement/values';
import { todayIst } from '../src/services/hrms/engagement/engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/engagement';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const TODAY = todayIst();
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const ok = (res: request.Response, status = 200): any => {
  expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined });
  return res.body.data ?? res.body;
};
const refused = (res: request.Response, status: number, code: string, error?: string | RegExp): void => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, code });
  if (typeof error === 'string') expect(res.body.error).toBe(error);
  else if (error) expect(res.body.error).toMatch(error);
};

let people: Record<string, Row>;
beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const id = (k: string) => people[k]!.id as string;
const boot = async () => ok(await api().get(`${P}/bootstrap`));
const pulseBody = (title: string, questions: { text: string; type: string }[]) => ({ title, questions });
const goodPulse = () => pulseBody('December pulse', [
  { text: 'I understand how my work helps our goals.', type: 'rating' },
  { text: 'Would you recommend us as a place to work?', type: 'yesno' },
  { text: 'One thing to change or keep?', type: 'text' },
]);
const sendPulse = async () => ok(await api().post(`${P}/surveys`).send(goodPulse()));

describe('bootstrap', () => {
  it('seeds the standard recognition values and starts otherwise empty', async () => {
    const b = await boot();
    expect(b.values.map((v: Row) => v.id).sort()).toEqual(STANDARD_VALUES.map((v) => v.key).sort());
    expect(b.surveys).toEqual([]);
    expect(b.responses).toEqual([]);
    expect(b.kudos).toEqual([]);
    expect(b.exit_interviews).toEqual([]);
    expect(b.today).toBe(TODAY);
  });

  it('does not duplicate the values on a second bootstrap', async () => {
    await boot();
    expect((await boot()).values).toHaveLength(STANDARD_VALUES.length);
  });
});

describe('pulses', () => {
  it('refuses a pulse with no name, no questions, too many, or thin text — with the dashboard words', async () => {
    refused(await api().post(`${P}/surveys`).send(pulseBody('ab', [{ text: 'A real question?', type: 'rating' }])), 400, 'VALIDATION', 'Give the pulse a name.');
    refused(await api().post(`${P}/surveys`).send(pulseBody('My pulse', [])), 400, 'VALIDATION', 'Add at least one question.');
    refused(await api().post(`${P}/surveys`).send(pulseBody('My pulse', Array.from({ length: 6 }, () => ({ text: 'A real question?', type: 'rating' })))), 400, 'VALIDATION', 'A pulse has at most 5 questions.');
    refused(await api().post(`${P}/surveys`).send(pulseBody('My pulse', [{ text: 'hi', type: 'rating' }])), 400, 'VALIDATION', 'Question 1 needs some text.');
  });

  it('opens a pulse today, closes it in 14 days, and numbers the questions q1..qn', async () => {
    const sv = await sendPulse();
    expect(sv.status).toBe('open');
    expect(sv.sent_on).toBe(TODAY);
    expect(sv.closes_on).toBe(addDays(TODAY, 14));
    expect(sv.questions.map((q: Row) => q.id)).toEqual(['q1', 'q2', 'q3']);
    expect(sv.questions.map((q: Row) => q.type)).toEqual(['rating', 'yesno', 'text']);
    const b = await boot();
    expect(b.surveys).toHaveLength(1);
    expect(b.log.some((l: Row) => /Pulse sent/.test(l.action))).toBe(true);
  });

  it('closes a pulse, and closing an already-closed one changes nothing', async () => {
    const sv = await sendPulse();
    expect(ok(await api().post(`${P}/surveys/${sv.id}/close`)).status).toBe('closed');
    expect(ok(await api().post(`${P}/surveys/${sv.id}/close`)).status).toBe('closed');
  });
});

describe('anonymous responses', () => {
  it('keeps only the team and the cleaned answers — never a person — and cleans each answer to its type', async () => {
    const sv = await sendPulse();
    const r = ok(await api().post(`${P}/surveys/${sv.id}/responses`).send({ team_id: 'team_sales', answers: { q1: 9, q2: true, q3: '  Great, keep the huddle  ' } }));
    // rating out of range is dropped (9 is not 1..5); yes/no kept; text trimmed.
    expect(r.answers.q1).toBeUndefined();
    expect(r.answers.q2).toBe(true);
    expect(r.answers.q3).toBe('Great, keep the huddle');
    expect(r.team_id).toBe('team_sales');
    // The stored row carries no employee reference of any kind.
    const stored = fake.tables['hrms_eng_responses'] ?? [];
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]!)).not.toContain('employee_id');
  });

  it('refuses an empty response, a closed pulse, and an unknown pulse', async () => {
    const sv = await sendPulse();
    refused(await api().post(`${P}/surveys/${sv.id}/responses`).send({ team_id: 'team_sales', answers: { q1: 'not a rating' } }), 400, 'VALIDATION', 'Answer at least one question.');
    await api().post(`${P}/surveys/${sv.id}/close`);
    refused(await api().post(`${P}/surveys/${sv.id}/responses`).send({ team_id: 'team_sales', answers: { q2: true } }), 400, 'VALIDATION', 'This pulse is closed.');
    refused(await api().post(`${P}/surveys/${UNKNOWN}/responses`).send({ team_id: 'team_sales', answers: { q2: true } }), 404, 'NOT_FOUND');
  });
});

describe('recognition', () => {
  it('posts recognition and refuses missing person, missing value or a thin message', async () => {
    refused(await api().post(`${P}/kudos`).send({ to_id: '', value_id: 'v_help', message: 'Thanks for the real help here.' }), 400, 'VALIDATION', 'Pick who you are thanking.');
    refused(await api().post(`${P}/kudos`).send({ to_id: id('aarav'), value_id: '', message: 'Thanks for the real help here.' }), 400, 'VALIDATION', 'Pick the value this shows.');
    refused(await api().post(`${P}/kudos`).send({ to_id: id('aarav'), value_id: 'v_help', message: 'ta' }), 400, 'VALIDATION', 'Say what they did, in at least 10 characters.');
    refused(await api().post(`${P}/kudos`).send({ to_id: id('aarav'), value_id: 'v_nope', message: 'Thanks for the real help here.' }), 400, 'VALIDATION', 'Pick the value this shows.');
    const k = ok(await api().post(`${P}/kudos`).send({ to_id: id('aarav'), value_id: 'v_help', message: 'Thanks for covering the dispatch desk.' }));
    expect(k.to_id).toBe(id('aarav'));
    expect(k.value_id).toBe('v_help');
    expect(k.on).toBe(TODAY);
  });
});

describe('exit interviews', () => {
  const exitId = '11111111-1111-4111-8111-111111111111';
  it('records a completed interview, refuses the reason/return rules, and allows only one per exit case', async () => {
    refused(await api().post(`${P}/exit-interviews`).send({ exit_id: exitId, employee_id: id('dev'), reasons: [], would_return: 'maybe' }), 400, 'VALIDATION', 'Pick at least one reason.');
    refused(await api().post(`${P}/exit-interviews`).send({ exit_id: exitId, employee_id: id('dev'), reasons: ['A', 'B', 'C', 'D'], would_return: 'maybe' }), 400, 'VALIDATION', 'Pick up to three reasons.');
    refused(await api().post(`${P}/exit-interviews`).send({ exit_id: exitId, employee_id: id('dev'), reasons: ['Career growth'], would_return: '' }), 400, 'VALIDATION', 'Say whether they would consider returning.');

    const ei = ok(await api().post(`${P}/exit-interviews`).send({ exit_id: exitId, employee_id: id('dev'), label: 'Analyst, Finance', reasons: ['Career growth', 'Better pay elsewhere'], would_return: 'maybe', text: 'Good team.' }));
    expect(ei.reasons).toEqual(['Career growth', 'Better pay elsewhere']);
    expect(ei.would_return).toBe('maybe');
    expect(ei.completed_on).toBe(TODAY);

    refused(await api().post(`${P}/exit-interviews`).send({ exit_id: exitId, employee_id: id('dev'), reasons: ['Relocation'], would_return: 'no' }), 400, 'VALIDATION', 'This interview is already complete.');
  });

  it('logs that an individual exit record was opened', async () => {
    ok(await api().post(`${P}/exit-interviews/opened`).send({ employee_id: id('dev') }));
    expect((await boot()).log.some((l: Row) => /Exit interview record opened/.test(l.action))).toBe(true);
  });
});
