/**
 * The FFM report endpoints (/analytics/ffm/reports/*) and the three small additive changes to the older FFM
 * handlers, over HTTP against the in-memory database seeded by tests/helpers/ffmPlusSeed.ts ("today" = Tue 2026-11-10 IST).
 *
 * Per endpoint: exact numbers on the seeded data (worked out by hand in the comments), the empty org, the module
 * gate, the demo org, org isolation, and 400 on a bad range / filter. Report windows use ?from=2026-11-01&to=2026-11-10.
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
const RANGE = 'from=2026-11-01&to=2026-11-10';
const rep = (id: string) => ({ ...manager, id, role: 'executive', email: 'rep@client.test' });

beforeAll(() => {
  jest.useFakeTimers({ now: S.NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'performance', 'hrtime'] });
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { __db.reset(S.seed()); setUser(manager); });

/** report path -> the array that is empty when there is nothing to report */
const REPORTS: Array<[string, string]> = [
  ['/reports/rep-activity', 'rows'],
  ['/reports/beat-compliance', 'reps'],
  ['/reports/time-and-travel', 'rows'],
  ['/reports/outlet-visit-gaps', 'rows'],
  ['/reports/geo-exceptions', 'rows'],
  ['/reports/supervisor-teams', 'rows'],
  ['/reports/attendance-extras', 'rows'],
  ['/reports/visit-coverage', 'by_rep'],
];

describe.each(REPORTS)('GET %s (every report endpoint)', (path, listKey) => {
  it('answers { success, data } with the window and rows on the seeded org', async () => {
    const res = await get(`${path}?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.from).toBe('2026-11-01');
    expect(res.body.data.to).toBe('2026-11-10');
    expect(res.body.data[listKey].length).toBeGreaterThan(0);
  });
  it('without from / to it defaults to a recent window ending today', async () => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body.data.to).toBe(S.TODAY);
    expect(res.body.data.from <= res.body.data.to).toBe(true);
  });
  it('an org with nothing gets an empty list and the same envelope, not an error', async () => {
    __db.reset({});
    const res = await get(`${path}?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.data[listKey]).toEqual([]);
    expect(res.body.data.from).toBe('2026-11-01');
  });
  it('a window entirely in the future has nothing to report yet', async () => {
    const res = await get(`${path}?from=2030-01-01&to=2030-01-05`);
    expect(res.status).toBe(200);
    expect(res.body.data[listKey]).toEqual([]);
  });
  it("never leaks the other org's rows, from either side", async () => {
    const mine = JSON.stringify((await get(`${path}?${RANGE}`)).body);
    expect(mine).not.toMatch(new RegExp(`Other-org|${S.STX}|${S.XB}`));
    const theirs = await get(`${path}?${RANGE}`, { ...manager, id: 'b-admin', org_id: S.ORG_B });
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toMatch(/Asha|Bala|Chitra|Shree Stores|10000000-0000/);
  });
  it('is behind the analytics module (or the Field Force Reports hub that links to it)', async () => {
    expect((await get(`${path}?${RANGE}`, { ...manager, enabled_modules: ['crm'] })).status).toBe(403);
    expect((await get(`${path}?${RANGE}`, { ...manager, enabled_modules: [], entitlements_strict: true })).status).toBe(403);
    expect((await get(`${path}?${RANGE}`, { ...manager, enabled_modules: ['analytics'] })).status).toBe(200);
    expect((await get(`${path}?${RANGE}`, { ...manager, enabled_modules: ['ffm_reports'] })).status).toBe(200);
    expect((await get(`${path}?${RANGE}`, { ...manager, role: 'super_admin', enabled_modules: ['crm'] })).status).toBe(200);
    // the two reports that also feed attendance-module pages accept that module as well; the others do not
    const attendanceOk = path === '/reports/time-and-travel' || path === '/reports/attendance-extras';
    expect((await get(`${path}?${RANGE}`, { ...manager, enabled_modules: ['attendance'] })).status).toBe(attendanceOk ? 200 : 403);
  });
  it('the demo org short-circuits to an empty report', async () => {
    const res = await get(`${path}?${RANGE}`, { ...manager, id: 'demo-user', org_id: DEMO_ORG_ID });
    expect(res.status).toBe(200);
    expect(res.body.data[listKey]).toEqual([]);
  });
  it.each([
    ['only from', 'from=2026-11-01'],
    ['only to', 'to=2026-11-10'],
    ['an impossible date', 'from=2026-13-40&to=2026-11-10'],
    ['text instead of a date', 'from=yesterday&to=today'],
    ['to before from', 'from=2026-11-10&to=2026-11-01'],
    ['more than 62 days', 'from=2026-08-01&to=2026-11-10'],
  ])('rejects %s with a 400', async (_label, qs) => {
    const res = await get(`${path}?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });
  it('accepts exactly 62 days', async () => {
    expect((await get(`${path}?from=2026-09-10&to=2026-11-10`)).status).toBe(200);
  });
});

describe('reports/rep-activity', () => {
  it('one row per rep with coverage, productivity, orders, travel, time on site and attendance, plus totals and team medians', async () => {
    const { data } = (await get(`/reports/rep-activity?${RANGE}`)).body;
    expect(data.reps_in_view).toBe(3);
    expect(data.rows.map((r: any) => r.fe_name)).toEqual(['Asha', 'Bala', 'Chitra']);
    // Asha: 5 planned calls (P1 3, P2 2), 3 visited; productive = ST1 + ST2 on 11-09 (the 11-06 order is cancelled) = 2 of 3
    expect(data.rows[0]).toMatchObject({
      fe_id: S.R1, planned_stops: 5, visited_stops: 3, missed_stops: 2, adherence_pct: 60, plan_days: 2, active_days: 2, zero_visit_days: 0,
      productive_visits: 2, productive_pct: 66.7, orders: 2, revenue_inr: 1500, aov_inr: 750, order_days: 1, orders_per_day: 2,
      calls_per_day: 1.5, km_total: 20.5, km_per_visit: 6.8, km_per_day: 10.3,
      timed_visits: 3, avg_dwell_min: 18.3, avg_planned_min: 15, under_2min_pct: 0, onsite_min: 55, onsite_hours: 0.9,
      first_call_time: '09:15', last_call_time: '09:53', avg_span_hours: 0.6,
      checkins: 3, outside_geofence: 0, outside_pct: 0, max_distance_m: 0,
      days_present: 3, avg_hours: 7.8, total_hours: 15.5, avg_checkin_time: '09:15', missed_checkouts: 1,
    });
    // Bala: 3 planned, 2 visited; productive = ST1 on 11-09 only (the 11-03 order is a draft) = 1 of 2; both check-ins outside the geofence
    expect(data.rows[1]).toMatchObject({
      fe_id: S.R2, planned_stops: 3, visited_stops: 2, adherence_pct: 66.7, productive_visits: 1, productive_pct: 50,
      orders: 1, revenue_inr: 800, aov_inr: 800, calls_per_day: 1, km_total: 12, km_per_visit: 6, timed_visits: 1, avg_dwell_min: 1, under_2min_pct: 100,
      first_call_time: '10:30', last_call_time: '10:31', checkins: 2, outside_geofence: 2, outside_pct: 100, max_distance_m: 250,
      days_present: 2, avg_hours: 7, missed_checkouts: 0,
    });
    // Chitra: 3 planned (P5 2, P10 1), 1 visited, one plan day (11-04) with no visit at all
    expect(data.rows[2]).toMatchObject({
      fe_id: S.R3, planned_stops: 3, visited_stops: 1, missed_stops: 2, adherence_pct: 33.3, plan_days: 2, active_days: 1, zero_visit_days: 1,
      productive_visits: 1, productive_pct: 100, orders: 1, revenue_inr: 700, km_total: 9, km_per_visit: 9, avg_dwell_min: 30, outside_geofence: 1,
      days_present: 0, avg_hours: null, avg_checkin_time: null,
    });
    // totals: 11 planned, 6 visited (54.5 %), 4 productive (66.7 %), 4 orders, 3000 INR (AOV 750), 41.5 km over 6 visits (6.9)
    expect(data.totals).toEqual({
      planned_stops: 11, visited_stops: 6, adherence_pct: 54.5, productive_visits: 4, productive_pct: 66.7,
      orders: 4, revenue_inr: 3000, aov_inr: 750, km_total: 41.5, km_per_visit: 6.9,
    });
    // medians over the reps shown: the basis for every comparison
    expect(data.median).toEqual({ calls_per_day: 1, adherence_pct: 60, productive_pct: 66.7, aov_inr: 750, avg_dwell_min: 18.3, km_per_visit: 6.8 });
  });
  it('a future "to" is capped at today; plan days after today are not "missed"', async () => {
    const { data } = (await get('/reports/rep-activity?from=2026-11-09&to=2026-11-30')).body;
    expect(data.to).toBe('2026-11-10');
    expect(data.rows.find((r: any) => r.fe_id === S.R1).planned_stops).toBe(3);        // the 11-12 plan is not counted
  });
  it('a rep only gets their own row', async () => {
    const { data } = (await get(`/reports/rep-activity?${RANGE}`, rep(S.R2))).body;
    expect(data.rows.map((r: any) => r.fe_id)).toEqual([S.R2]);
    expect(data.totals.revenue_inr).toBe(800);
  });
});

describe('reports/beat-compliance', () => {
  it('weekly planned vs visited overall and per rep, with the zero-visit plan days called out', async () => {
    const { data } = (await get(`/reports/beat-compliance?${RANGE}`)).body;
    expect(data.weeks).toEqual([
      { week: '2026-W45', week_start: '2026-11-02', planned: 4, visited: 2, missed: 2, adherence_pct: 50, active_reps: 3 },
      { week: '2026-W46', week_start: '2026-11-09', planned: 7, visited: 4, missed: 3, adherence_pct: 57.1, active_reps: 3 },
    ]);
    expect(data.reps).toEqual([
      { fe_id: S.R1, fe_name: 'Asha', plans: 3, planned: 5, visited: 3, missed: 2, adherence_pct: 60, plan_days: 2, zero_visit_days: 0, by_week: { '2026-11-02': 50, '2026-11-09': 66.7 } },
      { fe_id: S.R2, fe_name: 'Bala', plans: 2, planned: 3, visited: 2, missed: 1, adherence_pct: 66.7, plan_days: 2, zero_visit_days: 0, by_week: { '2026-11-02': 100, '2026-11-09': 50 } },
      { fe_id: S.R3, fe_name: 'Chitra', plans: 2, planned: 3, visited: 1, missed: 2, adherence_pct: 33.3, plan_days: 2, zero_visit_days: 1, by_week: { '2026-11-02': 0, '2026-11-09': 50 } },
    ]);
    expect(data.totals).toEqual({ planned: 11, visited: 6, missed: 5, adherence_pct: 54.5, plan_days: 6, zero_visit_days: 1 });
    expect(data.median_adherence_pct).toBe(60);
    expect(data.rep_options.map((r: any) => r.name)).toEqual(['Asha', 'Bala', 'Chitra']);
  });
  it('user_id narrows the table and the weekly totals but not the rep dropdown', async () => {
    const { data } = (await get(`/reports/beat-compliance?${RANGE}&user_id=${S.R2}`)).body;
    expect(data.reps.map((r: any) => r.fe_id)).toEqual([S.R2]);
    expect(data.weeks).toEqual([
      { week: '2026-W45', week_start: '2026-11-02', planned: 1, visited: 1, missed: 0, adherence_pct: 100, active_reps: 1 },
      { week: '2026-W46', week_start: '2026-11-09', planned: 2, visited: 1, missed: 1, adherence_pct: 50, active_reps: 1 },
    ]);
    expect(data.rep_options).toHaveLength(3);
  });
  it('a user_id outside the caller\'s scope returns nothing (never a hint it exists); a malformed one is a 400', async () => {
    const other = (await get(`/reports/beat-compliance?${RANGE}&user_id=${S.XB}`)).body.data;
    expect(other.reps).toEqual([]);
    expect(other.weeks).toEqual([]);
    expect((await get(`/reports/beat-compliance?${RANGE}&user_id=not-a-uuid`)).status).toBe(400);
  });
});

describe('reports/time-and-travel', () => {
  it('km, calls, time on site, first / last call and worked hours per rep, with the on-site share of attendance hours', async () => {
    const { data } = (await get(`/reports/time-and-travel?${RANGE}`)).body;
    expect(data.rows).toHaveLength(3);
    // Asha: 20.5 km over 3 calls / 2 days; on site 20 + 5 + 30 = 55 min = 0.9 h of 15.5 worked hours = 5.9 %
    expect(data.rows[0]).toEqual({
      fe_id: S.R1, fe_name: 'Asha', active_days: 2, km_total: 20.5, km_per_day: 10.3, visited_stops: 3, km_per_visit: 6.8, timed_visits: 3,
      avg_dwell_min: 18.3, onsite_hours: 0.9, onsite_min: 55, first_call_time: '09:15', last_call_time: '09:53', avg_span_hours: 0.6,
      days_present: 3, worked_hours: 15.5, onsite_share_pct: 5.9,
    });
    // Bala: 1 minute on site of 7 worked hours = 0.2 %
    expect(data.rows[1]).toMatchObject({ fe_id: S.R2, km_total: 12, km_per_visit: 6, avg_dwell_min: 1, first_call_time: '10:30', last_call_time: '10:31', worked_hours: 7, onsite_share_pct: 0.2 });
    // Chitra has no attendance rows: the share is unknown (null), not 0
    expect(data.rows[2]).toMatchObject({ fe_id: S.R3, km_total: 9, avg_dwell_min: 30, onsite_hours: 0.5, first_call_time: '09:15', last_call_time: '09:45', avg_span_hours: 0.5, days_present: 0, worked_hours: 0, onsite_share_pct: null });
    expect(data.totals).toEqual({ km_total: 41.5, visited_stops: 6, onsite_hours: 1.4, worked_hours: 22.5 });
    expect(data.median).toMatchObject({ km_per_visit: 6.8, avg_dwell_min: 18.3, avg_span_hours: 0.5 });
  });
  it('a single day works (the Hours & Idle page uses today)', async () => {
    const { data } = (await get('/reports/time-and-travel?from=2026-11-10&to=2026-11-10')).body;
    expect(data.rows.map((r: any) => [r.fe_name, r.visited_stops, r.days_present])).toEqual([['Bala', 0, 1], ['Chitra', 1, 0]]);
  });
});

describe('reports/outlet-visit-gaps', () => {
  it('outlets in the window with days since the last visit, never-visited first, then the longest gap', async () => {
    const { data } = (await get('/reports/outlet-visit-gaps')).body;           // default window: the last 60 days
    expect(data.from).toBe('2026-09-12');
    expect(data.as_of).toBe(S.TODAY);
    expect(data.total).toBe(5);
    expect(data.summary).toEqual({ outlets: 5, never_visited: 1, visited: 4, avg_days_since_last_visit: 13.3 });   // (51 + 1 + 1 + 0) / 4
    expect(data.rows).toEqual([
      { store_id: S.ST4, outlet_name: 'Annapurna Foods', city: null, rep_id: S.R1, rep_name: 'Asha', planned_calls: 2, visited_calls: 0, last_visit_date: null, days_since_last_visit: null, last_order_date: null, orders: 0, revenue_inr: 0 },
      { store_id: S.ST5, outlet_name: 'Lakshmi Traders', city: 'Chennai', rep_id: S.R1, rep_name: 'Asha', planned_calls: 1, visited_calls: 1, last_visit_date: '2026-09-20', days_since_last_visit: 51, last_order_date: '2026-10-05', orders: 1, revenue_inr: 300 },
      { store_id: S.ST1, outlet_name: 'Shree Stores', city: 'Chennai', rep_id: S.R1, rep_name: 'Asha', planned_calls: 4, visited_calls: 3, last_visit_date: '2026-11-09', days_since_last_visit: 1, last_order_date: '2026-11-09', orders: 2, revenue_inr: 1800 },
      { store_id: S.ST2, outlet_name: 'Bansal Provision', city: 'Chennai', rep_id: S.R2, rep_name: 'Bala', planned_calls: 3, visited_calls: 2, last_visit_date: '2026-11-09', days_since_last_visit: 1, last_order_date: '2026-11-09', orders: 2, revenue_inr: 700 },
      { store_id: S.ST3, outlet_name: 'Krishna Kirana', city: 'Madurai', rep_id: S.R1, rep_name: 'Asha', planned_calls: 2, visited_calls: 1, last_visit_date: '2026-11-10', days_since_last_visit: 0, last_order_date: '2026-11-10', orders: 1, revenue_inr: 700 },
    ]);
    expect(data.rep_options.map((r: any) => r.name)).toEqual(['Asha', 'Bala', 'Chitra']);
  });
  it('min_days keeps outlets not visited for at least that long (never-visited included)', async () => {
    const { data } = (await get('/reports/outlet-visit-gaps?min_days=30')).body;
    expect(data.rows.map((r: any) => r.store_id)).toEqual([S.ST4, S.ST5]);
    expect(data.total).toBe(2);
  });
  it('limit caps the rows but total still counts every match', async () => {
    const { data } = (await get('/reports/outlet-visit-gaps?limit=2')).body;
    expect(data.rows).toHaveLength(2);
    expect(data.total).toBe(5);
  });
  it('user_id shows only that rep\'s outlets and orders; the dropdown still lists everyone', async () => {
    const { data } = (await get(`/reports/outlet-visit-gaps?user_id=${S.R2}`)).body;
    // Bala: ST2 (visited 11-03 -> 7 days; her 11-03 order is a draft) and ST1 (11-09 -> 1 day, order O3 800)
    expect(data.rows.map((r: any) => [r.store_id, r.days_since_last_visit, r.orders, r.revenue_inr])).toEqual([[S.ST2, 7, 0, 0], [S.ST1, 1, 1, 800]]);
    expect(data.rep_options).toHaveLength(3);
  });
  it.each([
    ['min_days=-1'], ['min_days=abc'], ['min_days=366'], ['limit=0'], ['limit=1001'], ['limit=2.5'], ['user_id=nope'],
  ])('rejects %s with a 400', async (qs) => {
    expect((await get(`/reports/outlet-visit-gaps?${qs}`)).status).toBe(400);
  });
});

describe('reports/geo-exceptions', () => {
  it('check-ins outside the geofence, largest first, with per-rep shares and the alert counts', async () => {
    const { data } = (await get(`/reports/geo-exceptions?${RANGE}`)).body;
    expect(data.total).toBe(3);
    expect(data.rows).toEqual([
      { fe_id: S.R2, fe_name: 'Bala', outlet_name: 'Shree Stores', beat: 'Beat-B', visited_at: '2026-11-09T05:30:00Z', day: '2026-11-09', distance_m: 250, geofence_m: 100, over_by_m: 150 },
      { fe_id: S.R2, fe_name: 'Bala', outlet_name: 'Bansal Provision', beat: 'Beat-B', visited_at: '2026-11-03T04:30:00Z', day: '2026-11-03', distance_m: 150, geofence_m: 100, over_by_m: 50 },
      { fe_id: S.R3, fe_name: 'Chitra', outlet_name: 'Krishna Kirana', beat: 'Beat-C', visited_at: '2026-11-10T03:45:00Z', day: '2026-11-10', distance_m: 60, geofence_m: 50, over_by_m: 10 },
    ]);
    // Asha: 2 mock-location + 1 VPN alerts in the window (a third mock alert is from 10-01, out of window); Chitra: 2 server-flagged teleport pings
    expect(data.summary).toEqual([
      { fe_id: S.R2, fe_name: 'Bala', checkins: 2, outside_geofence: 2, outside_pct: 100, max_distance_m: 250, mock_location: 0, vpn_detected: 0, suspect_pings: 0 },
      { fe_id: S.R3, fe_name: 'Chitra', checkins: 1, outside_geofence: 1, outside_pct: 100, max_distance_m: 60, mock_location: 0, vpn_detected: 0, suspect_pings: 2 },
      { fe_id: S.R1, fe_name: 'Asha', checkins: 3, outside_geofence: 0, outside_pct: 0, max_distance_m: 0, mock_location: 2, vpn_detected: 1, suspect_pings: 0 },
    ]);
    expect(data.rep_options).toHaveLength(3);
  });
  it('min_distance_m filters the list only; user_id filters list and summary', async () => {
    const far = (await get(`/reports/geo-exceptions?${RANGE}&min_distance_m=200`)).body.data;
    expect(far.rows.map((r: any) => r.distance_m)).toEqual([250]);
    expect(far.total).toBe(1);
    expect(far.summary).toHaveLength(3);
    const one = (await get(`/reports/geo-exceptions?${RANGE}&user_id=${S.R3}`)).body.data;
    expect(one.rows.map((r: any) => r.fe_id)).toEqual([S.R3]);
    expect(one.summary.map((r: any) => r.fe_id)).toEqual([S.R3]);
  });
  it('missing alert / ping tables read as zero alerts, not an error', async () => {
    __db.failTable('security_alerts'); __db.failTable('work_activity');
    const { data } = (await get(`/reports/geo-exceptions?${RANGE}`)).body;
    expect(data.summary.every((r: any) => r.mock_location === 0 && r.vpn_detected === 0 && r.suspect_pings === 0)).toBe(true);
    expect(data.total).toBe(3);
  });
  it.each([['min_distance_m=-5'], ['min_distance_m=far'], ['min_distance_m=100001'], ['user_id=nope']])('rejects %s with a 400', async (qs) => {
    expect((await get(`/reports/geo-exceptions?${RANGE}&${qs}`)).status).toBe(400);
  });
});

describe('reports/supervisor-teams', () => {
  it('per direct supervisor: team size, coverage and output, with per-rep measures that do not reward bigger teams', async () => {
    const { data } = (await get(`/reports/supervisor-teams?${RANGE}`)).body;
    expect(data.reps_in_view).toBe(3);
    // Meera: Asha (5 planned, 3 visited, 2 productive, 2 days, 2 orders, 1500) + Bala (3, 2, 1, 2 days, 1 order, 800)
    //   -> 8 planned, 5 visited = 62.5 %, 3 productive = 60 %, 5 calls / 4 rep-days = 1.25 -> 1.3, 2300 INR over 2 reps = 1150
    // Ravi: Chitra (3 planned, 1 visited = 33.3 %, 1 productive = 100 %, 1 rep-day, 700 INR)
    expect(data.rows).toEqual([
      { supervisor_id: S.S1, supervisor_name: 'Meera', reps: 2, active_reps: 2, planned_stops: 8, visited_stops: 5, adherence_pct: 62.5, productive_visits: 3, productive_pct: 60, active_rep_days: 4, calls_per_rep_day: 1.3, orders: 3, revenue_inr: 2300, revenue_per_rep_inr: 1150, days_present: 5 },
      { supervisor_id: S.S2, supervisor_name: 'Ravi', reps: 1, active_reps: 1, planned_stops: 3, visited_stops: 1, adherence_pct: 33.3, productive_visits: 1, productive_pct: 100, active_rep_days: 1, calls_per_rep_day: 1, orders: 1, revenue_inr: 700, revenue_per_rep_inr: 700, days_present: 0 },
    ]);
    expect(data.median.adherence_pct).toBe(47.9);       // (62.5 + 33.3) / 2
    expect(data.median.productive_pct).toBe(80);
  });
  it('reps with no supervisor on record form their own row', async () => {
    const tables = S.seed();
    tables.users.find((u: any) => u.id === S.R3).supervisor_id = null;
    __db.reset(tables);
    const { data } = (await get(`/reports/supervisor-teams?${RANGE}`)).body;
    expect(data.rows.map((r: any) => [r.supervisor_name, r.reps])).toEqual([['Meera', 2], ['No supervisor on record', 1]]);
  });
});

describe('reports/attendance-extras', () => {
  it('per user (any role that punched): average check-in / out, hours, missed check-outs, regularised days; absent days do not count', async () => {
    const { data } = (await get(`/reports/attendance-extras?${RANGE}`)).body;
    const by = (id: string) => data.rows.find((r: any) => r.user_id === id);
    expect(data.rows).toHaveLength(3);                  // Asha, Bala and the admin; the other org's punch is not here
    expect(by(S.R1)).toEqual({
      user_id: S.R1, days_present: 3, avg_checkin_min: 555, avg_checkin_time: '09:15', avg_checkout_min: 1020, avg_checkout_time: '17:00',
      total_hours: 15.5, hours_days: 2, avg_hours: 7.8, missed_checkouts: 1, regularised_days: 1,
    });
    expect(by(S.R2)).toMatchObject({ days_present: 2, avg_checkin_time: '09:30', avg_checkout_time: '17:00', total_hours: 7, avg_hours: 7, missed_checkouts: 0 });
    expect(by(S.ADMIN)).toMatchObject({ days_present: 1, avg_checkin_time: '08:00', avg_hours: 9 });       // hours from the stamps
    expect(data.median).toEqual({ avg_hours: 7.8, avg_checkin_min: 555 });
  });
  it('a rep only gets themself', async () => {
    const { data } = (await get(`/reports/attendance-extras?${RANGE}`, rep(S.R2))).body;
    expect(data.rows.map((r: any) => r.user_id)).toEqual([S.R2]);
  });
});

describe('reports/visit-coverage', () => {
  it('defaults to this month so far: outlets planned vs visited, by city and by rep', async () => {
    const { data } = (await get('/reports/visit-coverage')).body;
    expect(data.from).toBe('2026-11-01');
    expect(data.to).toBe(S.TODAY);
    // planned outlets: ST1..ST4; visited at least once: ST1, ST2, ST3
    expect(data).toMatchObject({ universe: 4, covered: 3, coverage_pct: 75, never_visited: 1 });
    expect(data.by_city).toEqual([
      { city: 'Chennai', universe: 2, covered: 2 },
      { city: 'Madurai', universe: 1, covered: 1 },
      { city: 'No city on record', universe: 1, covered: 0 },
    ]);
    expect(data.by_rep).toEqual([
      { fe_id: S.R1, fe_name: 'Asha', universe: 4, covered: 2, gap: 2, coverage_pct: 50 },
      { fe_id: S.R2, fe_name: 'Bala', universe: 2, covered: 2, gap: 0, coverage_pct: 100 },
      { fe_id: S.R3, fe_name: 'Chitra', universe: 3, covered: 1, gap: 2, coverage_pct: 33.3 },
    ]);
  });
  it('honours from / to', async () => {
    const { data } = (await get('/reports/visit-coverage?from=2026-11-09&to=2026-11-09')).body;
    expect(data).toMatchObject({ universe: 3, covered: 2, coverage_pct: 66.7, never_visited: 1 });   // ST1 v, ST2 v, ST3 planned only
  });
  it('a store missing from the stores table still counts (named "No city on record")', async () => {
    const tables = S.seed(); tables.stores = [];
    __db.reset(tables);
    const { data } = (await get(`/reports/visit-coverage?${RANGE}`)).body;
    expect(data.universe).toBe(4);
    expect(data.by_city).toEqual([{ city: 'No city on record', universe: 4, covered: 3 }]);
  });
});

describe('older FFM handlers: the three additive changes', () => {
  it('security-violations now reads security_alerts (30 days, per rep); no alerts or no table reads as all clean', async () => {
    const { data } = (await get('/security-violations')).body;
    // roster of the older handler: active role=executive only (Asha, Chitra)
    expect(data.find((r: any) => r.fe_id === S.R1)).toEqual({ fe_id: S.R1, fe_name: 'Asha', mock_location: 2, vpn_detected: 1, violation_count: 3 });
    expect(data.find((r: any) => r.fe_id === S.R3)).toEqual({ fe_id: S.R3, fe_name: 'Chitra', mock_location: 0, vpn_detected: 0, violation_count: 0 });
    expect(JSON.stringify(data)).not.toMatch(/Other-org/);
    __db.failTable('security_alerts');
    const clean = (await get('/security-violations')).body.data;
    expect(clean.every((r: any) => r.violation_count === 0)).toBe(true);
    expect((await get('/security-violations', { ...manager, enabled_modules: ['crm'] })).status).toBe(403);
  });
  it('aov rows carry revenue_inr beside the average and the order count', async () => {
    // W46 (non-cancelled, org-wide as before): O1 1000 + O2 500 + O3 800 + O6 700 + O9 5000 = 8000 over 5 orders
    const row = (await get('/aov')).body.data.find((r: any) => r.week === '2026-W46');
    expect(row).toEqual({ week: '2026-W46', aov_inr: 1600, orders: 5, revenue_inr: 8000 });
  });
  it('distance-travelled rows carry the number of reps who travelled that day', async () => {
    const rows = (await get('/distance-travelled')).body.data;
    // 11-09: P1 12.5 (Asha) + P3 7 (Bala) + P6 3 (Dev) + P7 2 (admin) = 24.5 km, 4 people | 11-10: P5 9 km (Chitra)
    expect(rows.find((r: any) => r.day === '2026-11-09')).toEqual({ day: '2026-11-09', km_total: 24.5, reps: 4 });
    expect(rows.find((r: any) => r.day === '2026-11-10')).toEqual({ day: '2026-11-10', km_total: 9, reps: 1 });
  });
});
