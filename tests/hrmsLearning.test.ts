/**
 * HRMS phase 10 (Learning on the server), driven over HTTP through the real router and services against the in-memory
 * PostgREST double (tests/helpers/hrmsFakeDb.ts). Covers the gate + not-ready, the empty bootstrap, the standard library
 * (idempotent), "who it is for" with the dashboard's words, Apply rules (learners only, never twice), assigning by hand
 * (skips, due dates, leavers / joiners refused), lessons in order (a repeated click does not skip one), the quiz marked on
 * the server (fail, pass, certificate numbering and expiry, no second completion), reminders, refreshers, and the log.
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
import { IDS, MASTER, seedCompany, seedPeople } from './helpers/hrmsPayrollScenario';
import { addDays, addMonthsISO, certificateNumber, currentAssignments, gradeQuiz, todayIst } from '../src/services/hrms/learning/engine';
import { STANDARD_COURSES } from '../src/services/hrms/learning/library';
import { timeOrderedUuid } from '../src/services/hrms/learning/learning.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/learning';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const TODAY = todayIst();

let people: Record<string, Row>;
beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const ok = (res: request.Response, status = 200) => { expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined }); return res.body.data ?? res.body; };
const refused = (res: request.Response, status: number, code: string, error?: string | RegExp) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, code });
  if (typeof error === 'string') expect(res.body.error).toBe(error);
  else if (error) expect(res.body.error).toMatch(error);
};

const id = (k: string) => people[k]!.id as string;
const LEARNERS = ['aarav', 'bela', 'chitra', 'dev', 'esha', 'gus', 'hari'];   // fay is onboarding

async function library(): Promise<Row[]> { return ok(await api().post(`${P}/library`)).courses; }
const byCode = (courses: Row[], code: string) => courses.find((c) => c.code === code)!;
const answerKey = (code: string) => STANDARD_COURSES.find((c) => c.code === code)!.quiz.map((q) => q.answer);
const wrongKey = (code: string) => STANDARD_COURSES.find((c) => c.code === code)!.quiz.map((q) => (q.answer + 1) % q.options.length);

async function assign(courseId: string, keys: string[], extra: Row = {}): Promise<Row> {
  return ok(await api().post(`${P}/courses/${courseId}/assign`).send({ employee_ids: keys.map(id), ...extra }));
}
async function finishLessons(assignmentId: string, n = 3): Promise<Row> {
  let a: Row = {};
  for (let i = 0; i < n; i++) a = ok(await api().post(`${P}/assignments/${assignmentId}/lesson`).send({ steps_done: i }));
  return a;
}
async function pass(assignmentId: string, code: string): Promise<Row> {
  await finishLessons(assignmentId);
  return ok(await api().post(`${P}/assignments/${assignmentId}/quiz`).send({ answers: answerKey(code) }));
}

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use Learning', () => {
  it('is refused while viewing as another user (the shared HRMS gate)', async () => {
    user = { ...MASTER, impersonated_by: '00000000-0000-4000-8000-0000000000cc' };
    refused(await api().get(`${P}/bootstrap`), 403, 'FORBIDDEN');
  });
  it('503 while the tables are missing', async () => {
    fake.missing.add('hrms_learn_courses');
    refused(await api().get(`${P}/bootstrap`), 503, 'HRMS_NOT_READY');
  });
});

describe('bootstrap and the standard library', () => {
  it('starts empty, with today in India', async () => {
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(b).toMatchObject({ courses: [], assignments: [], certificates: [], reminders: [], log: [], today: TODAY });
  });

  it('loads the ten standard courses once, with only the company-wide ones mandatory', async () => {
    const first = ok(await api().post(`${P}/library`));
    expect(first.added).toBe(10);
    expect(first.courses).toHaveLength(10);
    expect(first.courses.filter((c: Row) => c.mandatory).map((c: Row) => c.code).sort()).toEqual(['CODE', 'DATA', 'POSH']);
    for (const c of first.courses) {
      expect(c.audience).toEqual({ departmentIds: [], designationIds: [], locationIds: [] });
      expect(c.lessons.length).toBeGreaterThan(0);
      expect(c.quiz.length).toBeGreaterThan(0);
    }
    const again = ok(await api().post(`${P}/library`));
    expect(again.added).toBe(0);
    expect(again.courses).toHaveLength(10);
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(b.log.map((l: Row) => l.action)).toEqual(['Standard courses added']);
    expect(b.log[0]).toMatchObject({ by: 'Sagar B', detail: '10 courses' });
  });
});

describe('who a course is for', () => {
  it('saves the rule with this company\'s departments / designations / locations', async () => {
    const c = byCode(await library(), 'SAFE-W');
    const saved = ok(await api().put(`${P}/courses/${c.id}/rules`).send({
      mandatory: true, audience: { departmentIds: [], designationIds: [], locationIds: [IDS.LOC_MUM] }, refresher_months: 24,
    }));
    expect(saved).toMatchObject({ mandatory: true, refresher_months: 24, audience: { locationIds: [IDS.LOC_MUM] } });
  });

  it('refuses ids from elsewhere, a bad interval and an unknown course, in the dashboard\'s words', async () => {
    const c = byCode(await library(), 'SAFE-W');
    refused(await api().put(`${P}/courses/${c.id}/rules`).send({ mandatory: true, audience: { departmentIds: [UNKNOWN], designationIds: [], locationIds: [] }, refresher_months: 12 }),
      400, 'VALIDATION', 'Choose departments, designations and locations from this company.');
    refused(await api().put(`${P}/courses/${c.id}/rules`).send({ mandatory: true, audience: { departmentIds: [], designationIds: [], locationIds: [] }, refresher_months: 61 }),
      400, 'VALIDATION', 'The refresher interval is between 0 and 60 months. Use 0 for a one-off course.');
    refused(await api().put(`${P}/courses/${UNKNOWN}/rules`).send({ mandatory: true, audience: { departmentIds: [], designationIds: [], locationIds: [] }, refresher_months: 0 }),
      404, 'NOT_FOUND', 'That course is not in the catalogue.');
  });
});

describe('Apply rules', () => {
  it('assigns the mandatory courses to everyone working here, once', async () => {
    await library();
    const first = ok(await api().post(`${P}/rules/apply`));
    expect(first.created).toBe(3 * LEARNERS.length);   // POSH, DATA, CODE for the seven people working here
    expect(first.assignments.every((a: Row) => a.source === 'rule' && a.assigned_on === TODAY && a.due_on === addDays(TODAY, 30))).toBe(true);
    expect(first.assignments.some((a: Row) => a.employee_id === id('fay'))).toBe(false);   // a joiner is assigned on the start date
    expect(ok(await api().post(`${P}/rules/apply`)).created).toBe(0);
  });

  it('follows the audience: a Mumbai-only rule reaches only the person in Mumbai', async () => {
    const c = byCode(await library(), 'SAFE-W');
    ok(await api().put(`${P}/courses/${c.id}/rules`).send({ mandatory: true, audience: { departmentIds: [], designationIds: [], locationIds: [IDS.LOC_MUM] }, refresher_months: 12 }));
    const made = ok(await api().post(`${P}/rules/apply`)).assignments.filter((a: Row) => a.course_id === c.id);
    expect(made.map((a: Row) => a.employee_id)).toEqual([id('bela')]);
  });
});

describe('assigning by hand', () => {
  it('assigns, skips anyone with it open, and takes the course\'s due days by default', async () => {
    const c = byCode(await library(), 'EXCEL');
    const first = await assign(c.id, ['aarav', 'bela']);
    expect(first).toMatchObject({ created: 2, skipped: 0 });
    expect(first.assignments[0]).toMatchObject({ source: 'manual', assigned_on: TODAY, due_on: addDays(TODAY, c.due_days), steps_done: 0, attempts: 0 });
    const second = await assign(c.id, ['aarav', 'chitra'], { due_on: addDays(TODAY, 5) });
    expect(second).toMatchObject({ created: 1, skipped: 1 });
    expect(second.assignments[0]).toMatchObject({ employee_id: id('chitra'), due_on: addDays(TODAY, 5) });
  });

  it('refuses nobody, a past due date, and people who are not working here', async () => {
    const c = byCode(await library(), 'EXCEL');
    refused(await api().post(`${P}/courses/${c.id}/assign`).send({ employee_ids: [] }), 400, 'VALIDATION', 'Pick at least one person.');
    refused(await api().post(`${P}/courses/${c.id}/assign`).send({ employee_ids: [id('aarav')], due_on: addDays(TODAY, -1) }), 400, 'VALIDATION', 'Pick a due date that is today or later.');
    refused(await api().post(`${P}/courses/${c.id}/assign`).send({ employee_ids: [id('fay')] }), 400, 'VALIDATION', /working here now/);
    refused(await api().post(`${P}/courses/${c.id}/assign`).send({ employee_ids: [UNKNOWN] }), 400, 'VALIDATION', 'Choose people from this company.');
  });
});

describe('taking a course', () => {
  async function started(code = 'POSH'): Promise<{ course: Row; asg: Row }> {
    const course = byCode(await library(), code);
    const asg = (await assign(course.id, ['aarav'])).assignments[0];
    return { course, asg };
  }

  it('finishes lessons in order; a repeated click does not skip one; the quiz comes last', async () => {
    const { asg } = await started();
    expect(ok(await api().post(`${P}/assignments/${asg.id}/lesson`).send({ steps_done: 0 })).steps_done).toBe(1);
    expect(ok(await api().post(`${P}/assignments/${asg.id}/lesson`).send({ steps_done: 0 })).steps_done).toBe(1);   // the same click again
    ok(await api().post(`${P}/assignments/${asg.id}/lesson`).send({ steps_done: 1 }));
    ok(await api().post(`${P}/assignments/${asg.id}/lesson`).send({ steps_done: 2 }));
    refused(await api().post(`${P}/assignments/${asg.id}/lesson`).send({}), 400, 'VALIDATION', 'Every lesson is done. The quiz is next.');
  });

  it('refuses the quiz before the lessons, and an incomplete set of answers', async () => {
    const { asg } = await started();
    refused(await api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: answerKey('POSH') }), 400, 'VALIDATION', 'Finish the lessons before the quiz.');
    await finishLessons(asg.id);
    refused(await api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: [0, null, 0] }), 400, 'VALIDATION', 'Answer all 3 questions to submit.');
    refused(await api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: [0, 1] }), 400, 'VALIDATION', 'Answer all 3 questions to submit.');
    refused(await api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: [0, 1, 9] }), 400, 'VALIDATION', 'Choose one of the options for each question.');
  });

  it('marks the quiz on the server: a fail counts the attempt and issues nothing', async () => {
    const { asg } = await started();
    await finishLessons(asg.id);
    const r = ok(await api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: wrongKey('POSH') }));
    expect(r.result).toMatchObject({ correct: 0, total: 3, score: 0, passed: false });
    expect(r.assignment).toMatchObject({ attempts: 1, completed_on: null, score: null, certificate_id: null });
    expect(r.certificate).toBeNull();
    expect(fake.tables.hrms_learn_certificates ?? []).toHaveLength(0);
  });

  it('a pass completes the course and issues a numbered certificate that lapses with the refresher', async () => {
    const { asg } = await started();
    const r = await pass(asg.id, 'POSH');
    const number = certificateNumber(1, TODAY);
    expect(r.result).toMatchObject({ score: 100, passed: true });
    expect(r.assignment).toMatchObject({ completed_on: TODAY, score: 100, attempts: 1, certificate_id: number });
    expect(r.certificate).toMatchObject({ id: number, employee_id: id('aarav'), issued_on: TODAY, expires_on: addMonthsISO(TODAY, 12), score: 100 });
    refused(await api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: answerKey('POSH') }), 400, 'VALIDATION', 'This course is already completed.');
    refused(await api().post(`${P}/assignments/${asg.id}/lesson`).send({}), 400, 'VALIDATION', 'This course is already completed.');

    // the next certificate takes the next number; a one-off course has no expiry
    const excel = byCode((ok(await api().get(`${P}/bootstrap`))).courses, 'EXCEL');
    const second = (await assign(excel.id, ['bela'])).assignments[0];
    const r2 = await pass(second.id, 'EXCEL');
    expect(r2.certificate).toMatchObject({ id: certificateNumber(2, TODAY), expires_on: null });
  });

  it('two at once cannot both count: the second quiz answer is refused', async () => {
    const { asg } = await started();
    await finishLessons(asg.id);
    const [a, b] = await Promise.all([
      api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: answerKey('POSH') }),
      api().post(`${P}/assignments/${asg.id}/quiz`).send({ answers: answerKey('POSH') }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(fake.tables.hrms_learn_certificates ?? []).toHaveLength(1);
  });
});

describe('reminders and refreshers', () => {
  it('logs a reminder (nothing is sent), and not for a completed course', async () => {
    const course = byCode(await library(), 'POSH');
    const asg = (await assign(course.id, ['aarav'])).assignments[0];
    const rem = ok(await api().post(`${P}/assignments/${asg.id}/remind`));
    expect(rem).toMatchObject({ on: TODAY, by: 'Sagar B', employee_id: id('aarav'), course_id: course.id, assignment_id: asg.id });
    await pass(asg.id, 'POSH');
    refused(await api().post(`${P}/assignments/${asg.id}/remind`), 400, 'VALIDATION', 'This course is already completed.');
    const log = ok(await api().get(`${P}/bootstrap`)).log.map((l: Row) => l.action);
    expect(log).toEqual(expect.arrayContaining(['Reminder logged (not sent)', 'Course completed', 'Course assigned']));
  });

  it('assigns a refresher due when the certificate lapses, only once, and only for the latest certificate', async () => {
    const course = byCode(await library(), 'POSH');
    const asg = (await assign(course.id, ['aarav'])).assignments[0];
    const first = (await pass(asg.id, 'POSH')).certificate;
    const refresher = ok(await api().post(`${P}/certificates/${first.id}/refresher`));
    expect(refresher).toMatchObject({ source: 'refresher', employee_id: id('aarav'), course_id: course.id, assigned_on: TODAY, due_on: first.expires_on });
    refused(await api().post(`${P}/certificates/${first.id}/refresher`), 400, 'VALIDATION', 'A refresher is already assigned.');

    // the refresher is the current assignment even though it was assigned the same day
    const b = ok(await api().get(`${P}/bootstrap`));
    const cur = currentAssignments(b.assignments.filter((a: Row) => a.employee_id === id('aarav')));
    expect(cur.map((a: Row) => a.id)).toEqual([refresher.id]);

    // finishing it issues a newer certificate; the old one can no longer be refreshed
    await pass(refresher.id, 'POSH');
    refused(await api().post(`${P}/certificates/${first.id}/refresher`), 400, 'VALIDATION', 'A newer certificate has replaced this one.');
    refused(await api().post(`${P}/certificates/CERT-2000-0999/refresher`), 404, 'NOT_FOUND', 'That certificate is not on record.');
  });
});

describe('engine details', () => {
  it('marks a quiz like the dashboard (70% passes)', () => {
    const quiz = [{ q: 'a', options: ['x', 'y'], answer: 0 }, { q: 'b', options: ['x', 'y'], answer: 1 }, { q: 'c', options: ['x', 'y'], answer: 1 }];
    expect(gradeQuiz(quiz, [0, 1, 0])).toEqual({ correct: 2, total: 3, score: 67, passed: false });
    expect(gradeQuiz(quiz, [0, 1, 1])).toEqual({ correct: 3, total: 3, score: 100, passed: true });
  });
  it('time-ordered ids sort in creation order', () => {
    const a = timeOrderedUuid(1_700_000_000_000);
    const b = timeOrderedUuid(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
