/**
 * HRMS phase 3 (Time & Leave on the server), driven over HTTP through the real router and services against the in-memory PostgREST
 * double (tests/helpers/hrmsFakeDb.ts). Covers the service layer: the gate, scoping, the bootstrap shape, validation and every refusal
 * (with the dashboard's own words), idempotent creates, the delete guards, leave balances and the roster, 503 HRMS_NOT_READY, and the
 * payroll shift-hours integration (an employee on a non-8h shift with overtime gets the shift's hours; editing a shift makes a run stale).
 * The SQL (constraints, the fks, the delete guards end to end) is proven by the PGlite harness.
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
import { IDS, MASTER, ORG, OTHER_ORG, seedCompany, seedPeople, uid } from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/time';

let people: Record<string, Row>;
beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const t = (name: string): Row[] => (fake.tables[name] ??= []);
const stored = (table: string, id: string) => t(table).find((r) => r.id === id)!;
const ok = (res: request.Response, status = 200) => { expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined }); return res.body.data; };
const refused = (res: request.Response, status: number, code: string, error?: string | RegExp) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, code });
  if (typeof error === 'string') expect(res.body.error).toBe(error);
  else if (error) expect(res.body.error).toMatch(error);
};

const GOOD_SHIFT = { name: 'Day', start: '09:00', end: '18:00', break_minutes: 60, grace_minutes: 10, full_day_hours: 8, half_day_hours: 4, color: '#3E9EFF' };
const GOOD_LEAVE = {
  name: 'Earned Leave', code: 'EL', paid: true, audience: 'all', accrual: { mode: 'monthly', days: 1.5, afterMonths: 0 },
  carry_forward: { allowed: true, maxDays: 30, expiryMonths: 12 }, encashment: { allowed: true, maxDays: 15, onExit: true },
  probation_eligible: true, include_weekly_offs: false,
};
const mkShift = async (over: Row = {}) => ok(await api().post(`${P}/shifts`).send({ ...GOOD_SHIFT, ...over }), 201);
const mkLeave = async (over: Row = {}) => ok(await api().post(`${P}/leave-types`).send({ ...GOOD_LEAVE, ...over }), 201);
const mkList = async (over: Row = {}) => ok(await api().post(`${P}/holiday-lists`).send({ name: 'India 2026', state: 'Maharashtra', year: 2026, holidays: [], ...over }), 201);

/** Some Monday, and the Tuesday after it. */
const mondayOf = (d: string) => { const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; const dt = new Date(`${d}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() - wd); return dt.toISOString().slice(0, 10); };
const MON = mondayOf('2026-11-11');
const TUE = (() => { const dt = new Date(`${MON}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() + 1); return dt.toISOString().slice(0, 10); })();

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use Time & Leave, and which rows it reaches', () => {
  const routes: Array<[string, string, any?]> = [
    ['get', '/bootstrap'], ['post', '/shifts', {}], ['put', `/shifts/${uid(1)}`, {}], ['delete', `/shifts/${uid(1)}`],
    ['post', '/leave-types', {}], ['put', `/leave-types/${uid(1)}`, {}], ['delete', `/leave-types/${uid(1)}`],
    ['post', '/holiday-lists', {}], ['put', `/holiday-lists/${uid(1)}`, {}], ['delete', `/holiday-lists/${uid(1)}`],
    ['put', `/balances/${uid(1)}/${uid(2)}`, {}], ['put', `/roster/${uid(1)}/${MON}`, {}],
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
    const shift = await mkShift();
    const leave = await mkLeave();
    await mkList();
    await api().put(`${P}/balances/${people.aarav!.id}/${leave.id}`).send({ opening: 5, accrued: 1, taken: 0, encashed: 0, lapsed: 0 });
    await api().put(`${P}/roster/${people.aarav!.id}/${MON}`).send({ days: [shift.id, shift.id, shift.id, shift.id, shift.id, 'off', 'off'] });
    await api().get(`${P}/bootstrap`);
    const queries = fake.log.filter((q) => q.table.startsWith('hrms_'));
    expect(queries.length).toBeGreaterThanOrEqual(10);
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
    await api().post(`${P}/shifts`).send(GOOD_SHIFT).set('X-Client-Id', CLIENT);
    await api().get(`${P}/bootstrap`).set('X-Client-Id', CLIENT);
    for (const q of fake.log) {
      expect(JSON.stringify(q.filters)).not.toContain(CLIENT);
      expect(JSON.stringify(q.rows ?? [])).not.toContain(CLIENT);
    }
    for (const r of t('hrms_shifts')) expect(r.client_id).toBeNull();
  });

  it('never sees another org\'s Time & Leave rows, and bootstrap shows none of them', async () => {
    const stamp = { org_id: OTHER_ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
    t('hrms_shifts').push({ id: uid(41, 'b'), name: 'Theirs', start: '09:00', end: '17:00', break_minutes: 0, grace_minutes: 0, full_day_hours: 8, half_day_hours: 4, is_night: false, color: '#000', ...stamp });
    t('hrms_leave_types').push({ id: uid(42, 'b'), name: 'Theirs', code: 'TH', paid: true, audience: 'all', accrual: {}, carry_forward: {}, encashment: {}, max_consecutive_days: null, document_after_days: null, probation_eligible: true, include_weekly_offs: false, description: null, ...stamp });
    t('hrms_holiday_lists').push({ id: uid(43, 'b'), name: 'Theirs', state: 'X', year: 2026, holidays: [], ...stamp });
    t('hrms_leave_balances').push({ id: uid(44, 'b'), employee_id: uid(45, 'b'), leave_type_id: uid(42, 'b'), opening: 1, accrued: 0, taken: 0, encashed: 0, lapsed: 0, ...stamp });

    await mkShift(); // one of ours
    const boot = ok(await api().get(`${P}/bootstrap`));
    expect([boot.shifts.length, boot.leave_types.length, boot.holiday_lists.length, boot.leave_balances.length]).toEqual([1, 0, 0, 0]);
    expect(JSON.stringify(boot)).not.toContain(OTHER_ORG);
    // and it cannot reach them by id
    for (const [m, p] of [['put', `/shifts/${uid(41, 'b')}`], ['delete', `/shifts/${uid(41, 'b')}`], ['put', `/leave-types/${uid(42, 'b')}`], ['delete', `/holiday-lists/${uid(43, 'b')}`]] as Array<[string, string]>) {
      expect((await (api() as any)[m](`${P}${p}`).send({})).status).toBe(404);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bootstrap', () => {
  it('returns the five collections and a server_time, each row in the wire shape', async () => {
    const shift = await mkShift({ name: 'Night', start: '22:00', end: '06:00' });
    const leave = await mkLeave();
    await mkList({ holidays: [{ date: '2026-01-26', name: 'Republic Day', optional: false }] });
    await api().put(`${P}/balances/${people.aarav!.id}/${leave.id}`).send({ opening: 12, accrued: 1.5, taken: 2, encashed: 0, lapsed: 0 });
    await api().put(`${P}/roster/${people.aarav!.id}/${MON}`).send({ days: [shift.id, shift.id, 'off', shift.id, shift.id, 'off', 'off'] });

    const boot = ok(await api().get(`${P}/bootstrap`));
    expect(Object.keys(boot).sort()).toEqual(['holiday_lists', 'leave_balances', 'leave_types', 'roster', 'server_time', 'shifts']);
    expect(Object.keys(boot.shifts[0]).sort()).toEqual(['break_minutes', 'color', 'created_at', 'end', 'full_day_hours', 'grace_minutes', 'half_day_hours', 'id', 'is_night', 'name', 'start', 'updated_at']);
    expect(boot.shifts[0].is_night).toBe(true); // 22:00 -> 06:00 crosses midnight
    expect(Object.keys(boot.leave_types[0]).sort()).toEqual(['accrual', 'audience', 'carry_forward', 'code', 'created_at', 'description', 'document_after_days', 'encashment', 'id', 'include_weekly_offs', 'max_consecutive_days', 'name', 'paid', 'probation_eligible', 'updated_at']);
    expect(boot.leave_types[0].accrual).toEqual({ mode: 'monthly', days: 1.5, afterMonths: 0 });
    expect(boot.leave_types[0].carry_forward).toEqual({ allowed: true, maxDays: 30, expiryMonths: 12 });
    expect(boot.leave_types[0].encashment).toEqual({ allowed: true, maxDays: 15, onExit: true });
    expect(boot.holiday_lists[0].holidays).toEqual([{ date: '2026-01-26', name: 'Republic Day', optional: false }]);
    expect(boot.leave_balances[0]).toMatchObject({ employee_id: people.aarav!.id, leave_type_id: leave.id, opening: 12, accrued: 1.5, taken: 2, encashed: 0, lapsed: 0 });
    expect(boot.roster[0]).toMatchObject({ employee_id: people.aarav!.id, week_start: MON, days: [shift.id, shift.id, 'off', shift.id, shift.id, 'off', 'off'] });
    expect(typeof boot.server_time).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('shifts', () => {
  it('creates a shift (201) with is_night derived from the times, not trusted from the body', async () => {
    const day = await mkShift({ is_night: true }); // body says night, but 09:00->18:00 is not
    expect(day.is_night).toBe(false);
    const night = await mkShift({ name: 'Night', start: '22:00', end: '06:00', is_night: false });
    expect(night.is_night).toBe(true);
  });

  it('is idempotent on a client-supplied id', async () => {
    const id = uid(200);
    const a = await mkShift({ id });
    const b = ok(await api().post(`${P}/shifts`).send({ ...GOOD_SHIFT, id }), 200); // 200, not 201
    expect(b.id).toBe(a.id);
    expect(t('hrms_shifts')).toHaveLength(1);
  });

  it('refuses an invalid shift with the dashboard\'s exact words', async () => {
    await mkShift(); // an existing "Day"
    const cases: Array<[Row, string]> = [
      [{ name: '  ' }, 'Shift name is required'],
      [{ name: 'x'.repeat(41) }, 'Shift name is too long (40 characters at most)'],
      [{ name: 'day' }, 'There is already a shift called day'],
      [{ name: 'A', start: '25:00' }, 'Enter a start time'],
      [{ name: 'A', end: '9am' }, 'Enter an end time'],
      [{ name: 'A', start: '09:00', end: '09:00' }, 'Start and end cannot be the same time'],
      [{ name: 'A', break_minutes: 300 }, 'Break is 0 to 240 whole minutes'],
      [{ name: 'A', start: '09:00', end: '10:00', break_minutes: 60 }, 'The break is as long as the whole shift'],
      [{ name: 'A', grace_minutes: 200 }, 'Grace is 0 to 120 whole minutes'],
      [{ name: 'A', full_day_hours: 20 }, 'Full day is 1 to 16 hours'],
      [{ name: 'A', start: '09:00', end: '12:00', break_minutes: 0, full_day_hours: 5, half_day_hours: 2 }, 'A full day of 5 h is longer than the 3 h on duty'],
      [{ name: 'A', half_day_hours: 0 }, 'Half day must be more than 0 hours'],
      [{ name: 'A', half_day_hours: 8 }, 'Half day must be less than a full day'],
    ];
    for (const [over, msg] of cases) refused(await api().post(`${P}/shifts`).send({ ...GOOD_SHIFT, ...over }), 400, 'VALIDATION', msg);
  });

  it('updates a shift and re-derives is_night; a rename to a taken name is refused', async () => {
    await mkShift({ name: 'Morning' });
    const s = await mkShift({ name: 'Evening' });
    const up = ok(await api().put(`${P}/shifts/${s.id}`).send({ start: '20:00', end: '04:00' }));
    expect(up.is_night).toBe(true);
    refused(await api().put(`${P}/shifts/${s.id}`).send({ name: 'Morning' }), 400, 'VALIDATION', 'There is already a shift called Morning');
    // renaming to its own name is fine (others excludes itself)
    expect(ok(await api().put(`${P}/shifts/${s.id}`).send({ name: 'Evening' })).name).toBe('Evening');
  });

  it('will not delete a shift an employee or a roster day still uses, then deletes it once free (the dashboard\'s words)', async () => {
    const s = await mkShift();
    stored('hrms_employees', people.aarav!.id).shift_id = s.id; // one employee on it
    await api().put(`${P}/roster/${people.bela!.id}/${MON}`).send({ days: [s.id, s.id, s.id, 'off', 'off', 'off', 'off'] }); // 3 roster days
    refused(await api().delete(`${P}/shifts/${s.id}`), 409, 'IN_USE', `Day is still used by 1 employee as their shift and 3 roster days. Move them to another shift first, then delete it.`);
    // drop the roster, keep one exited employee (exited does not count)
    stored('hrms_employees', people.aarav!.id).status = 'exited';
    t('hrms_roster').length = 0;
    expect(ok(await api().delete(`${P}/shifts/${s.id}`))).toEqual({ id: s.id });
    expect(t('hrms_shifts')).toHaveLength(0);
  });

  it('the roster-only and employee-only refusals read in the singular / plural correctly', async () => {
    const s1 = await mkShift({ name: 'S1' });
    stored('hrms_employees', people.aarav!.id).shift_id = s1.id;
    stored('hrms_employees', people.bela!.id).shift_id = s1.id;
    refused(await api().delete(`${P}/shifts/${s1.id}`), 409, 'IN_USE', 'S1 is still used by 2 employees as their shift. Move them to another shift first, then delete it.');
    const s2 = await mkShift({ name: 'S2' });
    await api().put(`${P}/roster/${people.aarav!.id}/${MON}`).send({ days: [s2.id, 'off', 'off', 'off', 'off', 'off', 'off'] });
    refused(await api().delete(`${P}/shifts/${s2.id}`), 409, 'IN_USE', 'S2 is still used by 1 roster day. Move them to another shift first, then delete it.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('leave types', () => {
  it('creates a leave type (201) in the wire shape, uppercasing the code; idempotent on a client id', async () => {
    const l = await mkLeave({ code: 'el' });
    expect(l.code).toBe('EL');
    const id = uid(210);
    const a = await mkLeave({ id, name: 'Casual', code: 'CL' });
    const b = ok(await api().post(`${P}/leave-types`).send({ ...GOOD_LEAVE, id, name: 'Casual', code: 'CL' }), 200);
    expect(b.id).toBe(a.id);
  });

  it('refuses an invalid leave type with the dashboard\'s exact words', async () => {
    await mkLeave(); // existing "Earned Leave" / EL
    const cases: Array<[Row, string]> = [
      [{ name: '  ', code: 'XX' }, 'Leave type name is required'],
      [{ name: 'earned leave', code: 'XX' }, 'There is already a leave type called earned leave'],
      [{ name: 'Casual', code: '' }, 'Code is required'],
      [{ name: 'Casual', code: 'TOOLONG' }, 'Code is 1 to 6 letters or digits, like EL'],
      [{ name: 'Casual', code: 'el' }, 'EL is already used by another leave type'],
      [{ name: 'Casual', code: 'CL', accrual: { mode: 'monthly', days: 0, afterMonths: 0 } }, 'Enter how many days are credited'],
      [{ name: 'Casual', code: 'CL', accrual: { mode: 'monthly', days: 40, afterMonths: 0 } }, 'A month cannot earn more than 31 days'],
      [{ name: 'Casual', code: 'CL', accrual: { mode: 'yearly', days: 400, afterMonths: 0 } }, 'That is more than a year of days'],
      [{ name: 'Casual', code: 'CL', accrual: { mode: 'yearly', days: 12, afterMonths: 70 } }, 'Months of service is 0 to 60'],
      [{ name: 'Casual', code: 'CL', carry_forward: { allowed: true, maxDays: -1, expiryMonths: 0 } }, 'Enter 0 or more days (0 means no limit)'],
      [{ name: 'Casual', code: 'CL', carry_forward: { allowed: true, maxDays: 10, expiryMonths: 200 } }, 'Expiry is 0 to 120 months (0 means never)'],
      [{ name: 'Casual', code: 'CL', encashment: { allowed: true, maxDays: 0, onExit: false } }, 'Enter the most days that can be encashed'],
      [{ name: 'Casual', code: 'CL', document_after_days: 400 }, 'Whole days, 1 to 365'],
      [{ name: 'Casual', code: 'CL', max_consecutive_days: 400 }, 'Whole days, 1 to 365'],
    ];
    for (const [over, msg] of cases) refused(await api().post(`${P}/leave-types`).send({ ...GOOD_LEAVE, ...over }), 400, 'VALIDATION', msg);
  });

  it('updates a leave type (partial), keeping untouched fields', async () => {
    const l = await mkLeave();
    const up = ok(await api().put(`${P}/leave-types/${l.id}`).send({ paid: false, description: 'No pay' }));
    expect(up).toMatchObject({ paid: false, description: 'No pay', code: 'EL', name: 'Earned Leave' });
    expect(up.accrual).toEqual({ mode: 'monthly', days: 1.5, afterMonths: 0 }); // untouched
  });

  it('will not delete a leave type while an employee holds a balance, then deletes it once free (the dashboard\'s words)', async () => {
    const l = await mkLeave();
    await api().put(`${P}/balances/${people.aarav!.id}/${l.id}`).send({ opening: 10, accrued: 0, taken: 0, encashed: 0, lapsed: 0 });
    await api().put(`${P}/balances/${people.bela!.id}/${l.id}`).send({ opening: 8, accrued: 0, taken: 0, encashed: 0, lapsed: 0 });
    refused(await api().delete(`${P}/leave-types/${l.id}`), 409, 'IN_USE', '2 employees hold balances in Earned Leave. Deleting the type would orphan them. Change the policy instead, for example stop accrual.');
    t('hrms_leave_balances').length = 0;
    expect(ok(await api().delete(`${P}/leave-types/${l.id}`))).toEqual({ id: l.id });
  });

  it('the single-holder refusal reads in the singular', async () => {
    const l = await mkLeave();
    await api().put(`${P}/balances/${people.aarav!.id}/${l.id}`).send({ opening: 10, accrued: 0, taken: 0, encashed: 0, lapsed: 0 });
    refused(await api().delete(`${P}/leave-types/${l.id}`), 409, 'IN_USE', '1 employee holds a balance in Earned Leave. Deleting the type would orphan it. Change the policy instead, for example stop accrual.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('holiday lists', () => {
  it('creates a list (201) with its holidays in the wire shape; idempotent on a client id', async () => {
    const l = await mkList({ holidays: [{ date: '2026-01-26', name: 'Republic Day', optional: false }, { date: '2026-08-15', name: 'Independence Day', optional: true }] });
    expect(l).toMatchObject({ name: 'India 2026', state: 'Maharashtra', year: 2026 });
    expect(l.holidays).toEqual([{ date: '2026-01-26', name: 'Republic Day', optional: false }, { date: '2026-08-15', name: 'Independence Day', optional: true }]);
    const id = uid(220);
    const a = await mkList({ id, name: 'Karnataka 2026', state: 'Karnataka' });
    const b = ok(await api().post(`${P}/holiday-lists`).send({ name: 'Karnataka 2026', state: 'Karnataka', year: 2026, id }), 200);
    expect(b.id).toBe(a.id);
  });

  it('refuses an invalid list or holiday with the dashboard\'s exact words', async () => {
    await mkList(); // Maharashtra 2026, name "India 2026"
    const cases: Array<[Row, string]> = [
      [{ state: '' }, 'Choose a state'],
      [{ name: 'X', state: 'Delhi', year: 1999 }, 'Year is 2000 to 2100'],
      [{ name: '  ', state: 'Delhi' }, 'List name is required'],
      [{ name: 'india 2026', state: 'Delhi' }, 'A list with this name exists'],
      [{ name: 'Another MH', state: 'Maharashtra', year: 2026 }, 'A Maharashtra list for 2026 already exists. Edit that one instead'],
      [{ name: 'With holiday', state: 'Delhi', holidays: [{ name: 'No date', optional: false }] }, 'Pick a date'],
      [{ name: 'With holiday', state: 'Delhi', holidays: [{ date: '2026-13-40', name: 'Bad', optional: false }] }, 'Enter a valid date'],
      [{ name: 'With holiday', state: 'Delhi', year: 2026, holidays: [{ date: '2025-01-01', name: 'Wrong year', optional: false }] }, 'This list is for 2026. Pick a date in 2026'],
      [{ name: 'With holiday', state: 'Delhi', holidays: [{ date: '2026-01-01', name: '  ', optional: false }] }, 'Holiday name is required'],
      [{ name: 'With holiday', state: 'Delhi', holidays: [{ date: '2026-01-01', name: 'x'.repeat(61), optional: false }] }, 'Name is too long (60 characters at most)'],
    ];
    for (const [over, msg] of cases) refused(await api().post(`${P}/holiday-lists`).send({ name: 'India 2026', state: 'Maharashtra', year: 2026, holidays: [], ...over }), 400, 'VALIDATION', msg);
  });

  it('will not delete a list a location uses, then deletes it once free (the dashboard\'s words)', async () => {
    const l = await mkList();
    stored('hrms_locations', IDS.LOC_DEL).holiday_list_id = l.id;
    stored('hrms_locations', IDS.LOC_MUM).holiday_list_id = l.id;
    refused(await api().delete(`${P}/holiday-lists/${l.id}`), 409, 'IN_USE', 'India 2026 is the holiday list of Delhi HQ, Mumbai. Pick another list for those locations first.');
    stored('hrms_locations', IDS.LOC_MUM).holiday_list_id = null;
    refused(await api().delete(`${P}/holiday-lists/${l.id}`), 409, 'IN_USE', 'India 2026 is the holiday list of Delhi HQ. Pick another list for that location first.');
    stored('hrms_locations', IDS.LOC_DEL).holiday_list_id = null;
    expect(ok(await api().delete(`${P}/holiday-lists/${l.id}`))).toEqual({ id: l.id });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('leave balances', () => {
  it('upserts the five numbers (one row per employee and leave type)', async () => {
    const l = await mkLeave();
    const a = ok(await api().put(`${P}/balances/${people.aarav!.id}/${l.id}`).send({ opening: 12, accrued: 1.5, taken: 2, encashed: 0, lapsed: 0 }));
    expect(a).toMatchObject({ employee_id: people.aarav!.id, leave_type_id: l.id, opening: 12, accrued: 1.5, taken: 2 });
    const b = ok(await api().put(`${P}/balances/${people.aarav!.id}/${l.id}`).send({ taken: 3 }));
    expect(b.id).toBe(a.id); // same row, upserted
    expect(b).toMatchObject({ opening: 12, accrued: 1.5, taken: 3 }); // other numbers kept
    expect(t('hrms_leave_balances')).toHaveLength(1);
  });

  it('refuses a negative number and an unknown employee / leave type', async () => {
    const l = await mkLeave();
    refused(await api().put(`${P}/balances/${people.aarav!.id}/${l.id}`).send({ opening: -1 }), 400, 'VALIDATION', 'Opening cannot be negative');
    refused(await api().put(`${P}/balances/${uid(999)}/${l.id}`).send({ opening: 1 }), 404, 'NOT_FOUND', 'Employee not found');
    refused(await api().put(`${P}/balances/${people.aarav!.id}/${uid(998)}`).send({ opening: 1 }), 404, 'NOT_FOUND', 'Leave type not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('roster', () => {
  it('upserts one week-row; a second PUT replaces that week for the employee', async () => {
    const s = await mkShift();
    const a = ok(await api().put(`${P}/roster/${people.aarav!.id}/${MON}`).send({ days: [s.id, s.id, s.id, s.id, s.id, 'off', 'off'] }));
    expect(a).toMatchObject({ employee_id: people.aarav!.id, week_start: MON, days: [s.id, s.id, s.id, s.id, s.id, 'off', 'off'] });
    const b = ok(await api().put(`${P}/roster/${people.aarav!.id}/${MON}`).send({ days: ['off', s.id, s.id, s.id, s.id, s.id, 'off'] }));
    expect(b.id).toBe(a.id);
    expect(t('hrms_roster')).toHaveLength(1);
  });

  it('refuses a non-Monday week, an unknown shift cell, an unknown employee and the wrong number of days', async () => {
    const s = await mkShift();
    refused(await api().put(`${P}/roster/${people.aarav!.id}/${TUE}`).send({ days: Array(7).fill('off') }), 400, 'VALIDATION', 'The week must start on a Monday.');
    refused(await api().put(`${P}/roster/${people.aarav!.id}/${MON}`).send({ days: [s.id, 'off', 'off', 'off', 'off', 'off', 'nope'] }), 400, 'VALIDATION', 'Each day must be one of your shifts or a weekly off.');
    refused(await api().put(`${P}/roster/${uid(999)}/${MON}`).send({ days: Array(7).fill('off') }), 404, 'NOT_FOUND', 'Employee not found');
    refused(await api().put(`${P}/roster/${people.aarav!.id}/${MON}`).send({ days: ['off', 'off'] }), 400, 'VALIDATION', /A roster week has 7 days/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('503 when the Time & Leave tables are not there yet', () => {
  it('answers 503 HRMS_NOT_READY on bootstrap and every write', async () => {
    for (const table of ['hrms_shifts', 'hrms_roster', 'hrms_leave_types', 'hrms_holiday_lists', 'hrms_leave_balances']) fake.missing.add(table);
    const calls: Array<request.Test> = [
      api().get(`${P}/bootstrap`),
      api().post(`${P}/shifts`).send(GOOD_SHIFT),
      api().post(`${P}/leave-types`).send(GOOD_LEAVE),
      api().post(`${P}/holiday-lists`).send({ name: 'X', state: 'Delhi', year: 2026 }),
      api().put(`${P}/balances/${people.aarav!.id}/${uid(5)}`).send({ opening: 1 }),
    ];
    for (const c of calls) refused(await c, 503, 'HRMS_NOT_READY', 'HRMS storage is not set up yet');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The reason this phase matters to pay: payroll resolves each employee's shift hours from the stored shift.
describe('payroll reads the stored shift hours', () => {
  const PY = '/hrms/payroll';
  const seedAttendance = (empId: string, over: Row = {}) => {
    (fake.tables.hrms_attendance ??= []).push({ id: uid(900 + t('hrms_attendance').length, 'd'), org_id: ORG, client_id: null, employee_id: empId, month: '2026-10', days_in_month: 31, present_days: 31, paid_leave_days: 0, weekly_offs: 0, holidays: 0, lop_days: 0, overtime_hours: 0, locked: false, created_at: 'x', updated_at: 'x', ...over });
  };
  const otOf = (run: Row, empId: string): number => run.payslips.find((p: Row) => p.employeeId === empId).earnings.find((l: Row) => l.code === 'OT').amount;

  it('an employee on a non-8h shift with overtime gets the shift\'s hours (a 10h day pays less per OT hour than 8h)', async () => {
    const shift = await mkShift({ name: 'Long', start: '09:00', end: '20:00', break_minutes: 60, full_day_hours: 10, half_day_hours: 5 });
    seedAttendance(people.chitra!.id, { overtime_hours: 18 });

    // (1) no shift on file -> the engine falls back to 8 hour days
    stored('hrms_employees', people.chitra!.id).shift_id = null;
    const run = ok(await api().post(`${PY}/runs`).send({ entity_id: IDS.ENT, month: '2026-10' }), 201);
    const ot8 = otOf(ok(await api().post(`${PY}/runs/${run.id}/compute`)), people.chitra!.id);

    // (2) the 10 hour shift on file -> the OT hourly rate divides by 10, not 8, so the OT line is lower
    stored('hrms_employees', people.chitra!.id).shift_id = shift.id;
    const run10 = ok(await api().post(`${PY}/runs/${run.id}/compute`)); // recompute reads the new input
    const ot10 = otOf(run10, people.chitra!.id);

    expect(ot8).toBeGreaterThan(0);
    expect(ot10).toBeGreaterThan(0);
    expect(ot10).toBeLessThan(ot8);
    // OT amount is proportional to 1 / shiftHours, so ot8 / ot10 is about 10/8 = 1.25
    expect(Math.abs(ot8 / ot10 - 1.25)).toBeLessThan(0.03);
    // the line name still reports the hours and multiplier, not the shift hours
    expect(run10.payslips.find((p: Row) => p.employeeId === people.chitra!.id).earnings.find((l: Row) => l.code === 'OT').name).toMatch(/18h at 2x/);
  });

  it('still computes when the time migration is not applied yet (hrms_shifts missing -> falls back to 8, never 503)', async () => {
    fake.missing.add('hrms_shifts'); // payroll deploys independently of the time migration
    seedAttendance(people.chitra!.id, { overtime_hours: 18 });
    stored('hrms_employees', people.chitra!.id).shift_id = 'whatever';
    const run = ok(await api().post(`${PY}/runs`).send({ entity_id: IDS.ENT, month: '2026-10' }), 201);
    const computed = ok(await api().post(`${PY}/runs/${run.id}/compute`));
    expect(computed.status).toBe('computed');
    expect(otOf(computed, people.chitra!.id)).toBeGreaterThan(0); // 8h fallback, not a 503
  });

  it('editing a referenced shift\'s hours makes a computed run stale (the fingerprint reads shift hours)', async () => {
    const shift = await mkShift({ name: 'Long', start: '09:00', end: '20:00', break_minutes: 60, full_day_hours: 10, half_day_hours: 5 });
    seedAttendance(people.chitra!.id, { overtime_hours: 18 });
    stored('hrms_employees', people.chitra!.id).shift_id = shift.id;
    const run = ok(await api().post(`${PY}/runs`).send({ entity_id: IDS.ENT, month: '2026-10' }), 201);
    const computed = ok(await api().post(`${PY}/runs/${run.id}/compute`));
    expect(computed.stale).toBe(false);
    // change the shift the person is on: the compute would now read different hours, so the run is stale and a freeze is refused
    ok(await api().put(`${P}/shifts/${shift.id}`).send({ full_day_hours: 9, half_day_hours: 4 }));
    expect(ok(await api().get(`${PY}/runs/${run.id}`)).stale).toBe(true);
    refused(await api().post(`${PY}/runs/${run.id}/freeze`), 409, 'RUN_STALE');
  });
});
