/**
 * The twelve new FFM analytics widget datasets, over HTTP: the real ffm-analytics router against an in-memory
 * database (tests/helpers/ffmPlusDb.ts) seeded by tests/helpers/ffmPlusSeed.ts. "Today" is Tue 2026-11-10 IST.
 *
 * Per endpoint: the exact numbers on the seeded data (worked out by hand in the comments), the empty org, the
 * module gate, the demo org, and that the other org's rows never show up. Across all of them: a rep only ever
 * sees themself, the client / supervisor-subtree scope narrows the roster, and a failing optional table reads as
 * "no data" while a failing core table is a 500.
 */
import express from 'express';
import request from 'supertest';
import * as S from './helpers/ffmPlusSeed';

jest.mock('../src/lib/supabase', () => {
  const { createFfmDb } = require('./helpers/ffmPlusDb');
  const db = createFfmDb();
  return { __db: db, supabaseAdmin: db.client, supabase: db.client, getUserClient: () => db.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db } = require('../src/lib/supabase') as { __db: import('./helpers/ffmPlusDb').FfmDb };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmRouter = require('../src/routes/ffm-analytics.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/middleware/errorHandler') as { errorHandler: express.ErrorRequestHandler };
import { DEMO_ORG_ID } from '../src/utils/demoData';

const app = express();
app.use((req: any, _res, next) => { req.user = { ...(global as any).__testUser }; next(); });
app.use('/ffm', ffmRouter);
app.use(errorHandler);

const manager = { id: S.ADMIN, org_id: S.ORG, role: 'admin', client_id: null, email: 'admin@client.test', enabled_modules: ['analytics'], entitlements_strict: true };
const setUser = (u: Record<string, unknown>) => { (global as any).__testUser = u; };
const get = (path: string, user: Record<string, unknown> = manager) => { setUser(user); return request(app).get(`/ffm${path}`); };

beforeAll(() => {
  // Fake only Date so "today" is fixed; timers stay real for supertest.
  jest.useFakeTimers({ now: S.NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'performance', 'hrtime'] });
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { __db.reset(S.seed()); setUser(manager); });

const WIDGETS = [
  '/beat-adherence-trend', '/outlet-recency', '/visit-frequency', '/productive-trend', '/rep-basket', '/calls-per-day',
  '/dwell-time', '/visit-hours', '/travel-efficiency', '/geo-exceptions', '/attendance-hours', '/outlet-churn',
];

describe.each(WIDGETS)('GET %s (every widget dataset)', (path) => {
  it('answers { success, data: [...] } with rows on the seeded org', async () => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
  it('an org with nothing gets an empty array, not an error', async () => {
    __db.reset({});
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });
  it('an org whose reps have no plans, orders or attendance gets an empty array too', async () => {
    const only = S.seed();
    for (const t of ['route_plans', 'route_plan_outlets', 'orders', 'attendance']) only[t] = [];
    __db.reset(only);
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
  it("never leaks the other org's rows, from either side", async () => {
    const mine = JSON.stringify((await get(path)).body);
    expect(mine).not.toMatch(new RegExp(`Other-org|${S.STX}|${S.XB}`));
    const theirs = await get(path, { ...manager, id: 'b-admin', org_id: S.ORG_B });
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toMatch(/Asha|Bala|Chitra|10000000-0000/);
  });
  it('is behind the analytics module: a client without it gets 403, one with it (or a super_admin) gets 200', async () => {
    expect((await get(path, { ...manager, enabled_modules: ['crm'] })).status).toBe(403);
    expect((await get(path, { ...manager, enabled_modules: [], entitlements_strict: true })).status).toBe(403);
    expect((await get(path, { ...manager, role: 'super_admin', enabled_modules: ['crm'] })).status).toBe(200);
  });
  it('the demo org short-circuits to an empty array', async () => {
    const res = await get(path, { ...manager, id: 'demo-user', org_id: DEMO_ORG_ID });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
  it('ignores stray query parameters (widgets take none)', async () => {
    expect((await get(`${path}?from=garbage&user_id=nope`)).status).toBe(200);
  });
});

describe('beat-adherence-trend', () => {
  it('weekly planned / visited / missed per ISO week, oldest first; the 09-20 plan is before the 8-week window', async () => {
    // W45 (Mon 11-02): R1 11-06 ST1 v, ST4 p | R2 11-03 ST2 v | R3 11-04 ST1 p  -> 4 calls, 2 visited, reps R1 R2 R3
    // W46 (Mon 11-09): R1 ST1 v, ST2 v, ST3 p | R2 ST1 v, ST2 p | R3 11-10 ST3 v, ST4 skipped -> 7 calls, 4 visited
    // The inactive rep's, the admin's and the other org's visits on 11-09 are not counted; neither is the future plan (11-12).
    const res = await get('/beat-adherence-trend');
    expect(res.body.data).toEqual([
      { week: '2026-W45', week_start: '2026-11-02', planned: 4, visited: 2, missed: 2, adherence_pct: 50, active_reps: 3 },
      { week: '2026-W46', week_start: '2026-11-09', planned: 7, visited: 4, missed: 3, adherence_pct: 57.1, active_reps: 3 },
    ]);
  });
});

describe('outlet-recency', () => {
  it('outlets planned in the last 90 days grouped by days since their last visit', async () => {
    // ST1 last visited 11-09 (1d), ST2 11-09 (1d), ST3 11-10 (0d)  -> 0-7 days: 3
    // ST5 last visited 09-20 (51d)                                  -> 31-60 days: 1
    // ST4 planned twice, never visited                              -> Not visited: 1      (5 outlets)
    const res = await get('/outlet-recency');
    expect(res.body.data).toEqual([
      { bucket: '0–7 days', outlets: 3, share_pct: 60 },
      { bucket: '8–14 days', outlets: 0, share_pct: 0 },
      { bucket: '15–30 days', outlets: 0, share_pct: 0 },
      { bucket: '31–60 days', outlets: 1, share_pct: 20 },
      { bucket: '61–90 days', outlets: 0, share_pct: 0 },
      { bucket: 'Not visited', outlets: 1, share_pct: 20 },
    ]);
  });
});

describe('visit-frequency', () => {
  it('outlets planned in the last 30 days by number of visits (rep-days)', async () => {
    // ST1: R1 11-09, R1 11-06, R2 11-09 visited (R3 11-04 only planned) = 3 | ST2: R1 11-09, R2 11-03 = 2 (R2 11-09 pending)
    // ST3: R3 11-10 = 1 | ST4: planned twice, never visited = 0
    const res = await get('/visit-frequency');
    expect(res.body.data).toEqual([
      { bucket: 'Not visited', outlets: 1, share_pct: 25 },
      { bucket: '1 visit', outlets: 1, share_pct: 25 },
      { bucket: '2 visits', outlets: 1, share_pct: 25 },
      { bucket: '3 visits', outlets: 1, share_pct: 25 },
      { bucket: '4+ visits', outlets: 0, share_pct: 0 },
    ]);
  });
});

describe('productive-trend', () => {
  it('a visit is productive only with a same-rep, same-outlet, same-day order that is not cancelled or draft', async () => {
    // W45: visits R1/ST1/11-06 (its only order is CANCELLED) and R2/ST2/11-03 (its only order is a DRAFT) -> 2 visits, 0 productive
    // W46: R1/ST1 (O1), R1/ST2 (O2), R2/ST1 (O3), R3/ST3 (O6) all have an order that day -> 4 visits, 4 productive
    const res = await get('/productive-trend');
    expect(res.body.data).toEqual([
      { week: '2026-W45', week_start: '2026-11-02', visits: 2, productive_visits: 0, productive_pct: 0 },
      { week: '2026-W46', week_start: '2026-11-09', visits: 4, productive_visits: 4, productive_pct: 100 },
    ]);
  });
});

describe('rep-basket', () => {
  it('orders, revenue, AOV and the gap to the team AOV over the last 30 days; cancelled, draft, non-rep and old orders left out', async () => {
    // R1: O1 1000 + O2 500 -> 2 orders, 1500, AOV 750, one order day -> 2.0/day | R2: O3 800 | R3: O6 700
    // Team AOV = (1500 + 800 + 700) / 4 = 750 -> R2 +6.7 %, R3 -6.7 %. O7 / O8 are older than 30 days; O9 is the admin's.
    const res = await get('/rep-basket');
    expect(res.body.data).toEqual([
      { fe_id: S.R1, fe_name: 'Asha', orders: 2, revenue_inr: 1500, aov_inr: 750, active_days: 1, orders_per_day: 2, vs_team_aov_pct: 0 },
      { fe_id: S.R2, fe_name: 'Bala', orders: 1, revenue_inr: 800, aov_inr: 800, active_days: 1, orders_per_day: 1, vs_team_aov_pct: 6.7 },
      { fe_id: S.R3, fe_name: 'Chitra', orders: 1, revenue_inr: 700, aov_inr: 700, active_days: 1, orders_per_day: 1, vs_team_aov_pct: -6.7 },
    ]);
  });
});

describe('calls-per-day', () => {
  it('visited calls per active day beside the team median (last 14 days)', async () => {
    // R1: 3 calls over 2 days = 1.5 | R2: 2 over 2 = 1.0 | R3: 1 over 1 = 1.0 -> median 1.0
    const res = await get('/calls-per-day');
    expect(res.body.data).toEqual([
      { fe_id: S.R1, fe_name: 'Asha', visit_days: 2, visits: 3, calls_per_day: 1.5, team_median: 1, vs_median: 0.5 },
      { fe_id: S.R2, fe_name: 'Bala', visit_days: 2, visits: 2, calls_per_day: 1, team_median: 1, vs_median: 0 },
      { fe_id: S.R3, fe_name: 'Chitra', visit_days: 1, visits: 1, calls_per_day: 1, team_median: 1, vs_median: 0 },
    ]);
  });
});

describe('dwell-time', () => {
  it('average minutes between check-in and check-out, only for visits with both; planned minutes alongside', async () => {
    // R1: 20 + 5 + 30 = 55 / 3 = 18.3 (planned 15, 10, 20 -> 15) | R2: 1 minute (planned 5) -> 100 % under 2 min; its 11-03 visit has no check-out so is not timed
    // R3: 30 (planned 25)
    const res = await get('/dwell-time');
    expect(res.body.data).toEqual([
      { fe_id: S.R3, fe_name: 'Chitra', timed_visits: 1, avg_dwell_min: 30, avg_planned_min: 25, under_2min_pct: 0 },
      { fe_id: S.R1, fe_name: 'Asha', timed_visits: 3, avg_dwell_min: 18.3, avg_planned_min: 15, under_2min_pct: 0 },
      { fe_id: S.R2, fe_name: 'Bala', timed_visits: 1, avg_dwell_min: 1, avg_planned_min: 5, under_2min_pct: 100 },
    ]);
  });
});

describe('visit-hours', () => {
  it('visited check-ins by IST hour', async () => {
    // 09:30 R1, 09:00 R1 (11-06), 09:15 R3 -> hour 9 x3 | 10:10 R1, 10:00 R2 (11-03) -> hour 10 x2 | 11:00 R2 -> hour 11 x1
    const res = await get('/visit-hours');
    expect(res.body.data).toEqual([
      { hour: 9, hour_label: '09:00', visits: 3, share_pct: 50 },
      { hour: 10, hour_label: '10:00', visits: 2, share_pct: 33.3 },
      { hour: 11, hour_label: '11:00', visits: 1, share_pct: 16.7 },
    ]);
  });
});

describe('travel-efficiency', () => {
  it('km = actual route km, planned km when actual is missing; per visit and per active day', async () => {
    // R1: 12.5 (actual) + 8 (planned, no actual) = 20.5 over 3 visits / 2 days | R2: 7 + 5 = 12 over 2 / 2 | R3: 9 + 0 over 1 / 1
    const res = await get('/travel-efficiency');
    expect(res.body.data).toEqual([
      { fe_id: S.R1, fe_name: 'Asha', km_total: 20.5, visits: 3, km_per_visit: 6.8, active_days: 2, km_per_day: 10.3 },
      { fe_id: S.R2, fe_name: 'Bala', km_total: 12, visits: 2, km_per_visit: 6, active_days: 2, km_per_day: 6 },
      { fe_id: S.R3, fe_name: 'Chitra', km_total: 9, visits: 1, km_per_visit: 9, active_days: 1, km_per_day: 9 },
    ]);
  });
});

describe('geo-exceptions', () => {
  it("counts check-ins further than the outlet's own geofence (100 m when none is stored)", async () => {
    // R1: 40, 60, 30 m vs 100 -> 0 of 3 | R2: 250 m vs 100 -> outside, 150 m with no geofence stored vs the default 100 -> outside = 2 of 2, max 250
    // R3: 60 m vs a 50 m geofence -> outside = 1 of 1. Sorted by count, then share.
    const res = await get('/geo-exceptions');
    expect(res.body.data).toEqual([
      { fe_id: S.R2, fe_name: 'Bala', checkins: 2, outside_geofence: 2, outside_pct: 100, max_distance_m: 250 },
      { fe_id: S.R3, fe_name: 'Chitra', checkins: 1, outside_geofence: 1, outside_pct: 100, max_distance_m: 60 },
      { fe_id: S.R1, fe_name: 'Asha', checkins: 3, outside_geofence: 0, outside_pct: 0, max_distance_m: 0 },
    ]);
  });
});

describe('attendance-hours', () => {
  it('days present, average hours (stored, else from the stamps), average IST check-in and closed days with no check-out', async () => {
    // R1: 11-09 (09:00, 8.5 h), 11-06 (09:15, no check-out, a closed day), 11-04 (09:30, 7.0 h from the stamps); 11-05 absent
    //     -> 3 days, avg hours (8.5 + 7) / 2 = 7.75 -> 7.8, avg check-in (540 + 555 + 570) / 3 = 555 = 09:15, 1 missed
    // R2: 11-09 (10:00, 7 h) and today 11-10 (09:00, still open - not "missed") -> 2 days, 7.0 h, 570 = 09:30, 0 missed
    // R3 has no attendance; the admin's punch is not a field rep's.
    const res = await get('/attendance-hours');
    expect(res.body.data).toEqual([
      { fe_id: S.R1, fe_name: 'Asha', days_present: 3, avg_hours: 7.8, avg_checkin_time: '09:15', avg_checkin_min: 555, missed_checkouts: 1 },
      { fe_id: S.R2, fe_name: 'Bala', days_present: 2, avg_hours: 7, avg_checkin_time: '09:30', avg_checkin_min: 570, missed_checkouts: 0 },
    ]);
  });
});

describe('outlet-churn', () => {
  it('outlets by ordering pattern, last 30 days vs the 30 before, with revenue; cancelled / draft / non-rep orders excluded', async () => {
    // latest window = 10-12 .. 11-10, earlier = 09-12 .. 10-11
    // ST2 ordered in both (500 now, 200 before)            -> retained
    // ST1 (O1 1000 + O3 800 = 1800) and ST3 (700), now only -> new or returning: 2 outlets, 2500
    // ST5 ordered only before (300)                          -> lapsed
    const res = await get('/outlet-churn');
    expect(res.body.data).toEqual([
      { segment: 'Retained (ordered in both)', outlets: 1, revenue_last_30d_inr: 500, revenue_prior_30d_inr: 200 },
      { segment: 'New or returning (last 30 days only)', outlets: 2, revenue_last_30d_inr: 2500, revenue_prior_30d_inr: 0 },
      { segment: 'Lapsed (earlier 30 days only)', outlets: 1, revenue_last_30d_inr: 0, revenue_prior_30d_inr: 300 },
    ]);
  });
});

describe('who is counted', () => {
  it('only active executives / field executives of the caller\'s org: the inactive rep, the admin and the other org never appear', async () => {
    const names = new Set<string>();
    for (const p of ['/rep-basket', '/calls-per-day', '/dwell-time', '/travel-efficiency', '/geo-exceptions', '/attendance-hours']) {
      for (const r of (await get(p)).body.data) names.add(r.fe_name);
    }
    expect([...names].sort()).toEqual(['Asha', 'Bala', 'Chitra']);
  });
  it('a rep (role below supervisor) only gets their own numbers', async () => {
    const rep = { ...manager, id: S.R1, role: 'executive', email: 'asha@client.test' };
    const basket = (await get('/rep-basket', rep)).body.data;
    expect(basket.map((r: any) => r.fe_id)).toEqual([S.R1]);
    expect(basket[0].revenue_inr).toBe(1500);
    const calls = (await get('/calls-per-day', rep)).body.data;
    expect(calls).toEqual([{ fe_id: S.R1, fe_name: 'Asha', visit_days: 2, visits: 3, calls_per_day: 1.5, team_median: 1.5, vs_median: 0 }]);
    const trend = (await get('/beat-adherence-trend', rep)).body.data;
    expect(trend).toEqual([
      { week: '2026-W45', week_start: '2026-11-02', planned: 2, visited: 1, missed: 1, adherence_pct: 50, active_reps: 1 },
      { week: '2026-W46', week_start: '2026-11-09', planned: 3, visited: 2, missed: 1, adherence_pct: 66.7, active_reps: 1 },
    ]);
  });
  it('a client-bound caller only sees reps of their own client', async () => {
    const tables = S.seed();
    const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    for (const u of tables.users) if (u.org_id === S.ORG) u.client_id = u.id === S.R3 ? OTHER : S.CLIENT;
    __db.reset(tables);
    const res = await get('/rep-basket', { ...manager, client_id: S.CLIENT });
    expect(res.body.data.map((r: any) => r.fe_name)).toEqual(['Asha', 'Bala']);
    expect(__db.queries.some((q) => q.table === 'users' && q.ops.some(([m, a]) => m === 'eq' && a[0] === 'client_id' && a[1] === S.CLIENT))).toBe(true);
  });
  it('with supervisor scoping on, a team manager only sees their supervisor subtree (Meera: Asha + Bala, not Chitra)', async () => {
    const tables = S.seed();
    for (const u of tables.users) if (u.org_id === S.ORG) u.client_id = S.CLIENT;
    tables.clients = [{ id: S.CLIENT, org_id: S.ORG, settings: { uses_supervisor_scope: true } }];
    __db.reset(tables);
    const res = await get('/rep-basket', { ...manager, id: S.S1, role: 'supervisor', client_id: S.CLIENT, email: 'meera@client.test', org_role_data_scope: 'team' });
    expect(res.body.data.map((r: any) => r.fe_name)).toEqual(['Asha', 'Bala']);
    // data_scope 'all' lifts the restriction
    const all = await get('/rep-basket', { ...manager, id: S.S1, role: 'supervisor', client_id: S.CLIENT, email: 'meera@client.test', org_role_data_scope: 'all' });
    expect(all.body.data.map((r: any) => r.fe_name)).toEqual(['Asha', 'Bala', 'Chitra']);
  });
});

describe('sparse and failing data', () => {
  it('a missing orders table reads as no orders (weekly trend still answers), not an error', async () => {
    __db.failTable('orders');
    const res = await get('/productive-trend');
    expect(res.status).toBe(200);
    expect(res.body.data.map((w: any) => w.productive_visits)).toEqual([0, 0]);
    expect((await get('/rep-basket')).body.data).toEqual([]);
  });
  it('a missing attendance table reads as no attendance', async () => {
    __db.failTable('attendance');
    expect((await get('/attendance-hours')).body.data).toEqual([]);
  });
  it('a failing core table (route_plans) is a 500, not a silent empty widget', async () => {
    __db.failTable('route_plans');
    expect((await get('/calls-per-day')).status).toBe(500);
  });
  it('reps with plans but no visited stops produce empty per-rep widgets, never NaN rows', async () => {
    const tables = S.seed();
    for (const s of tables.route_plan_outlets) if (s.status !== 'pending' && s.status !== 'skipped') s.status = 'pending';
    __db.reset(tables);
    for (const p of ['/calls-per-day', '/dwell-time', '/visit-hours']) expect((await get(p)).body.data).toEqual([]);
    const adherence = (await get('/beat-adherence-trend')).body.data;
    expect(adherence.every((w: any) => w.visited === 0 && w.adherence_pct === 0)).toBe(true);
  });
});
