/**
 * HRMS phase 12 (Talent on the server), driven over HTTP through the real router and services against the in-memory
 * PostgREST double (tests/helpers/hrmsFakeDb.ts). Covers the populated-demo bootstrap (the 12-skill catalogue seeded, a
 * talent picture generated for the org's real people — requirements, ratings, roles with benches, placements — and
 * idempotent on a second call), skill ratings (the dashboard's validation words; level 0 clears), the succession bench
 * (add / readiness / remove with their rules), 9-box placements, and the activity log.
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
import { STANDARD_SKILLS } from '../src/services/hrms/talent/library';
import { todayIst } from '../src/services/hrms/talent/engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/talent';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const TODAY = todayIst();

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

describe('bootstrap (populated demo)', () => {
  it('seeds the standard skills catalogue and a generated talent picture for the real people', async () => {
    const b = await boot();
    expect(b.skills.map((s: Row) => s.id).sort()).toEqual(STANDARD_SKILLS.map((s) => s.key).sort());
    expect(b.skills[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), group: expect.any(String) });
    // Requirements exist for the org's one designation; ratings, roles and placements are generated against real people.
    expect(Object.keys(b.requirements).length).toBeGreaterThan(0);
    expect(Object.keys(b.ratings).length).toBeGreaterThan(0);
    expect(b.roles.length).toBeGreaterThan(0);
    expect(b.roles.length).toBeLessThanOrEqual(6);
    expect(Object.keys(b.placements).length).toBeGreaterThan(0);
    expect(b.cycle).toBe('FY 2026-27, first half');
    expect(b.today).toBe(TODAY);
    // A rating key is `${employeeId}|${skillId}` and its value carries a level 1..4.
    const [k, v] = Object.entries(b.ratings)[0] as [string, Row];
    expect(k).toMatch(/\|sk_/);
    expect(v.level).toBeGreaterThanOrEqual(1);
    expect(v.level).toBeLessThanOrEqual(4);
    // Every seeded role names a real incumbent.
    expect(b.roles.every((r: Row) => typeof r.incumbent_id === 'string')).toBe(true);
  });

  it('does not re-seed on a second bootstrap', async () => {
    await boot();
    const skills = fake.tables['hrms_talent_skills'] ?? [];
    expect(skills).toHaveLength(STANDARD_SKILLS.length);
    await boot();
    expect(fake.tables['hrms_talent_skills']).toHaveLength(STANDARD_SKILLS.length);
  });
});

describe('skill ratings', () => {
  it('refuses a bad level, a 3/4 with no evidence note, and an unknown skill — with the dashboard words', async () => {
    await boot();
    refused(await api().post(`${P}/ratings`).send({ employee_id: id('aarav'), skill_id: 'sk_comm', level: 5, note: '' }), 400, 'VALIDATION', 'Pick a level from 0 to 4.');
    refused(await api().post(`${P}/ratings`).send({ employee_id: id('aarav'), skill_id: 'sk_comm', level: 3, note: 'short' }), 400, 'VALIDATION', 'Level 3 and 4 need an evidence note: what did the assessor see?');
    refused(await api().post(`${P}/ratings`).send({ employee_id: id('aarav'), skill_id: 'sk_nope', level: 2, note: '' }), 400, 'VALIDATION', 'Unknown skill.');
  });

  it('sets a rating and then clears it at level 0', async () => {
    await boot();
    const set = ok(await api().post(`${P}/ratings`).send({ employee_id: id('aarav'), skill_id: 'sk_comm', level: 4, note: 'Writes clear client updates every week.' }));
    expect(set).toMatchObject({ employee_id: id('aarav'), skill_id: 'sk_comm' });
    expect(set.rating.level).toBe(4);
    expect((await boot()).ratings[`${id('aarav')}|sk_comm`].level).toBe(4);

    const cleared = ok(await api().post(`${P}/ratings`).send({ employee_id: id('aarav'), skill_id: 'sk_comm', level: 0, note: '' }));
    expect(cleared.rating).toBeNull();
    expect((await boot()).ratings[`${id('aarav')}|sk_comm`]).toBeUndefined();
  });
});

describe('succession bench', () => {
  // A role from the seed, plus an employee who is neither its incumbent nor already on its bench.
  const pickRoleAndCandidate = (b: Row) => {
    const role = b.roles[0] as Row;
    const onBench = new Set((role.successors as Row[]).map((s) => s.employee_id));
    const candidate = Object.values(people).map((p) => p.id as string).find((eid) => eid !== role.incumbent_id && !onBench.has(eid))!;
    return { role, candidate };
  };

  it('adds a successor and refuses the reason / incumbent / duplicate / unknown-role rules', async () => {
    const b = await boot();
    const { role, candidate } = pickRoleAndCandidate(b);

    refused(await api().post(`${P}/roles/${role.id}/successors`).send({ employee_id: candidate, readiness: 'now', reason: 'hi' }), 400, 'VALIDATION', 'Give a short reason (at least 5 characters). It is kept in the log.');
    refused(await api().post(`${P}/roles/${role.id}/successors`).send({ employee_id: role.incumbent_id, readiness: 'now', reason: 'Strong internal option.' }), 400, 'VALIDATION', 'The current holder cannot be their own successor.');
    refused(await api().post(`${P}/roles/${UNKNOWN}/successors`).send({ employee_id: candidate, readiness: 'now', reason: 'Strong internal option.' }), 404, 'NOT_FOUND', 'Unknown role.');

    const updated = ok(await api().post(`${P}/roles/${role.id}/successors`).send({ employee_id: candidate, readiness: '1-2y', actions: ['Shadow for a quarter'], reason: 'Covered the role on leave.' }));
    expect((updated.successors as Row[]).some((s) => s.employee_id === candidate && s.readiness === '1-2y')).toBe(true);
    expect((updated.history as Row[]).some((h) => h.kind === 'added' && h.employee_id === candidate)).toBe(true);

    refused(await api().post(`${P}/roles/${role.id}/successors`).send({ employee_id: candidate, readiness: 'now', reason: 'Trying again.' }), 400, 'VALIDATION', 'This person is already on the bench for this role.');
  });

  it('changes readiness and removes a successor, with their rules', async () => {
    const b = await boot();
    const { role, candidate } = pickRoleAndCandidate(b);
    ok(await api().post(`${P}/roles/${role.id}/successors`).send({ employee_id: candidate, readiness: '3y+', reason: 'Long-term option.' }));

    // readiness
    refused(await api().post(`${P}/roles/${role.id}/successors/readiness`).send({ employee_id: candidate, readiness: '3y+', reason: 'No change really.' }), 400, 'VALIDATION', 'That is already the readiness shown.');
    refused(await api().post(`${P}/roles/${role.id}/successors/readiness`).send({ employee_id: UNKNOWN, readiness: 'now', reason: 'Not on the bench.' }), 400, 'VALIDATION', 'This person is not on the bench.');
    const moved = ok(await api().post(`${P}/roles/${role.id}/successors/readiness`).send({ employee_id: candidate, readiness: 'now', reason: 'Ready after covering the role.' }));
    expect((moved.successors as Row[]).find((s) => s.employee_id === candidate)!.readiness).toBe('now');
    expect((moved.history as Row[]).some((h) => h.kind === 'readiness' && h.to === 'now')).toBe(true);

    // remove
    refused(await api().post(`${P}/roles/${role.id}/successors/remove`).send({ employee_id: UNKNOWN, reason: 'Not here.' }), 400, 'VALIDATION', 'This person is not on the bench.');
    const removed = ok(await api().post(`${P}/roles/${role.id}/successors/remove`).send({ employee_id: candidate, reason: 'Moved to another plan.' }));
    expect((removed.successors as Row[]).some((s) => s.employee_id === candidate)).toBe(false);
    expect((removed.history as Row[]).some((h) => h.kind === 'removed' && h.employee_id === candidate)).toBe(true);
  });
});

describe('9-box placements', () => {
  it('refuses a thin rationale, then places and clears', async () => {
    await boot();
    refused(await api().post(`${P}/placements`).send({ employee_id: id('bela'), performance: 2, potential: 3, rationale: 'too thin' }), 400, 'VALIDATION', /at least 10 characters/);
    const placed = ok(await api().post(`${P}/placements`).send({ employee_id: id('bela'), performance: 3, potential: 2, rationale: 'Strong delivery over the last two quarters.' }));
    expect(placed).toMatchObject({ employee_id: id('bela'), performance: 3, potential: 2 });
    expect((await boot()).placements[id('bela')]).toMatchObject({ performance: 3, potential: 2 });

    const cleared = ok(await api().post(`${P}/placements/remove`).send({ employee_id: id('bela') }));
    expect(cleared).toMatchObject({ employee_id: id('bela'), cleared: true });
    expect((await boot()).placements[id('bela')]).toBeUndefined();
  });
});

describe('activity log', () => {
  it('records that the named talent-review view was opened', async () => {
    await boot();
    ok(await api().post(`${P}/review-opened`).send({ group: 'Sales' }));
    expect((await boot()).log.some((l: Row) => /Talent review \(names\) opened/.test(l.action))).toBe(true);
  });
});
