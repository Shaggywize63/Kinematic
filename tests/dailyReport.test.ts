/**
 * Daily travel report (services/dailyReport.service.ts) — assembly from the SAME travel computation, driven
 * with fixtures and injected data fetchers (no database): the route thinning, hours worked, an empty day, an
 * open shift, visits + halts in order with their summary, the mode of transport and its label, and the team
 * table (who is listed, the 300 cap, concurrency of 5, sort, parity with the single report).
 */
import {
  thinRoute, shiftTotalHours, buildDailyReport, getDailyReport, emptyDailyReport, getTeamReport, mapWithConcurrency,
  storedTransportMode, ROUTE_MAX_POINTS, TEAM_REPORT_MAX_USERS, TEAM_REPORT_CONCURRENCY,
  type ReportUser, type TeamReportMember,
} from '../src/services/dailyReport.service';
import {
  computeDayTravel, getDayTravel, type PathPing, type RawVisitRow, type TrailRow, type TravelAttendanceRow, type TravelFetchers,
} from '../src/services/travel.service';

const DATE = '2026-10-09';
const USER = '22222222-2222-4222-8222-222222222222';
const ME: ReportUser = { id: USER, name: 'Asha', employee_id: 'EF-007', role: 'field_executive' };
const t = (hhmm: string) => new Date(Date.parse(`${DATE}T${hhmm}:00+05:30`)).toISOString();
const ms = (hhmm: string) => Date.parse(t(hhmm));
const NOW_AFTER = Date.parse(`${DATE}T20:00:00+05:30`);

type Pt = [number, number];
const P = (k: number): Pt => [13.0 + 0.01 * k, 80.2];          // k hundredths of a degree north: ~1.11 km each

const att = (over: Partial<TravelAttendanceRow> = {}): TravelAttendanceRow => ({
  id: 'att-1', status: 'checked_out',
  checkin_at: t('09:30'), checkout_at: t('18:00'),
  checkin_lat: P(0)[0], checkin_lng: P(0)[1], checkout_lat: P(0)[0], checkout_lng: P(0)[1],
  total_hours: 8.5, break_minutes: 0, transport_mode: null,
  ...over,
});
const fix = (hhmm: string, p: Pt, extra: Partial<TrailRow> = {}): TrailRow => ({ lat: p[0], lng: p[1], captured_at: t(hhmm), ...extra });
const form = (id: string, inHm: string, outHm: string, p: Pt, title = 'Customer Visit'): RawVisitRow => ({
  source: 'form',
  row: { id, check_in_at: t(inHm), check_out_at: t(outHm), check_in_gps: `${p[0]},${p[1]}`, check_out_gps: `${p[0]},${p[1]}`, builder_forms: { title } },
});

function fetchersFor(a: TravelAttendanceRow | null, visits: RawVisitRow[] = [], trail: TrailRow[] = []) {
  const f = {
    attendance: jest.fn().mockResolvedValue(a),
    visits: jest.fn().mockResolvedValue(visits),
    trail: jest.fn().mockResolvedValue(trail),
  };
  return { f, asFetchers: f as unknown as TravelFetchers };
}

const path = (n: number, over: (i: number) => Partial<PathPing> = () => ({})): PathPing[] =>
  Array.from({ length: n }, (_v, i) => ({ ms: Date.parse(`${DATE}T04:00:00Z`) + i * 1000, lat: 13 + i * 1e-5, lng: 80.2 + i * 1e-5, activity_type: 'HEARTBEAT', ...over(i) }));

describe('thinRoute', () => {
  it('keeps a short trail as is, as {lat, lng, at} with ISO times, and says it was not thinned', () => {
    const r = thinRoute(path(5));
    expect(r.thinned).toBe(false);
    expect(r.points).toHaveLength(5);
    expect(r.points[0]).toEqual({ lat: 13, lng: 80.2, at: '2026-10-09T04:00:00.000Z' });
    expect(Object.keys(r.points[1]).sort()).toEqual(['at', 'lat', 'lng']);
  });

  it('exactly 600 points are kept whole; 601 are cut to 600', () => {
    expect(ROUTE_MAX_POINTS).toBe(600);
    expect(thinRoute(path(600))).toMatchObject({ thinned: false, points: expect.any(Array) });
    expect(thinRoute(path(600)).points).toHaveLength(600);
    const r = thinRoute(path(601));
    expect(r.thinned).toBe(true);
    expect(r.points).toHaveLength(600);
  });

  it('a long day is down-sampled to <= 600 points, in time order, keeping the first and the last', () => {
    const full = path(2500);
    const r = thinRoute(full);
    expect(r.thinned).toBe(true);
    expect(r.points.length).toBeLessThanOrEqual(600);
    expect(r.points[0].at).toBe(new Date(full[0].ms).toISOString());
    expect(r.points[r.points.length - 1].at).toBe(new Date(full[2499].ms).toISOString());
    const times = r.points.map((p) => Date.parse(p.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  });

  it('reuses the Live Trailing tidy-up: repeats of one heartbeat fix are collapsed, punches never are', () => {
    const dup: PathPing[] = [
      { ms: ms('09:30'), lat: 13, lng: 80.2, activity_type: 'CHECK_IN' },
      ...Array.from({ length: 10 }, (_v, i) => ({ ms: ms('09:40') + i * 1000, lat: 13.01, lng: 80.2, activity_type: 'HEARTBEAT' })),
      { ms: ms('10:00'), lat: 13.02, lng: 80.2, activity_type: 'HEARTBEAT' },
      { ms: ms('10:00') + 1000, lat: 13.02, lng: 80.2, activity_type: 'CHECK_OUT' },
    ];
    const r = thinRoute(dup);
    expect(r.thinned).toBe(false);                         // collapsing repeats is tidying, not simplifying the geometry
    expect(r.points.map((p) => p.lat)).toEqual([13, 13.01, 13.02, 13.02]);
  });

  it('drops a 0,0 "no fix" point and an empty path is empty', () => {
    expect(thinRoute([{ ms: 1, lat: 0, lng: 0, activity_type: 'HEARTBEAT' }]).points).toEqual([]);
    expect(thinRoute([])).toEqual({ points: [], thinned: false });
  });
});

describe('shiftTotalHours', () => {
  const travelOf = (a: TravelAttendanceRow, nowMs = NOW_AFTER) => computeDayTravel({ date: DATE, userId: USER, attendance: a, visits: [], trail: [], nowMs }).travel;

  it('uses the stored total_hours (a number, or numeric text), rounded to 2 dp', () => {
    expect(shiftTotalHours(att({ total_hours: 7.5 }), travelOf(att()), NOW_AFTER)).toBe(7.5);
    expect(shiftTotalHours(att({ total_hours: '7.254' }), travelOf(att()), NOW_AFTER)).toBe(7.25);
    expect(shiftTotalHours(att({ total_hours: 0 }), travelOf(att()), NOW_AFTER)).toBe(0);
  });

  it('computes check-in to check-out less breaks when nothing is stored', () => {
    const a = att({ total_hours: null, checkout_at: t('13:30'), break_minutes: 30 });
    expect(shiftTotalHours(a, travelOf(a), NOW_AFTER)).toBe(3.5);
  });

  it('an open shift in progress runs to "now" less breaks', () => {
    const now = ms('12:30');
    const a = att({ total_hours: null, checkout_at: null, status: 'checked_in', break_minutes: 30 });
    expect(shiftTotalHours(a, travelOf(a, now), now)).toBe(2.5);
  });

  it('is null without a check-in, and for a forgotten check-out nobody closed', () => {
    const noIn = att({ total_hours: null, checkin_at: null, checkout_at: null, status: 'on_leave' });
    expect(shiftTotalHours(noIn, travelOf(noIn), NOW_AFTER)).toBeNull();
    const stale = att({ total_hours: null, checkout_at: null, status: 'checked_in' });
    const later = ms('09:30') + 3 * 86_400_000;
    expect(shiftTotalHours(stale, travelOf(stale, later), later)).toBeNull();
  });
});

describe('an empty day', () => {
  it('no attendance is a normal report: empty arrays, shift.attendance_id null, zeroed summary - and no visit/trail reads', async () => {
    const { f, asFetchers } = fetchersFor(null);
    const r = await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: NOW_AFTER });
    expect(r).toEqual({
      date: DATE,
      user: ME,
      shift: { attendance_id: null, checkin_at: null, checkout_at: null, total_hours: null, in_progress: false },
      transport: { mode: null, label: null },
      travel: { total_km: 0, method: 'none', legs: [] },
      visits: [],
      halts: [],
      route: { points: [], thinned: false },
      summary: { visits: 0, visit_minutes: 0, halts: 0, halt_minutes: 0, total_km: 0 },
    });
    expect(f.visits).not.toHaveBeenCalled();
    expect(f.trail).not.toHaveBeenCalled();
  });

  it('emptyDailyReport is the same answer without any fetcher', () => {
    expect(emptyDailyReport(DATE, ME, NOW_AFTER)).toEqual({
      date: DATE, user: ME,
      shift: { attendance_id: null, checkin_at: null, checkout_at: null, total_hours: null, in_progress: false },
      transport: { mode: null, label: null },
      travel: { total_km: 0, method: 'none', legs: [] },
      visits: [], halts: [], route: { points: [], thinned: false },
      summary: { visits: 0, visit_minutes: 0, halts: 0, halt_minutes: 0, total_km: 0 },
    });
  });

  it('a row with no check-in (leave placeholder) keeps its id but has no shift, travel or route', async () => {
    const { asFetchers } = fetchersFor(att({ id: 'att-leave', status: 'on_leave', checkin_at: null, checkout_at: null, total_hours: null }));
    const r = await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: NOW_AFTER });
    expect(r.shift).toEqual({ attendance_id: 'att-leave', checkin_at: null, checkout_at: null, total_hours: null, in_progress: false });
    expect(r.travel).toEqual({ total_km: 0, method: 'none', legs: [] });
    expect(r.route.points).toEqual([]);
  });
});

describe('an open shift', () => {
  const now = ms('12:00');
  const open = att({ checkout_at: null, status: 'checked_in', total_hours: null });
  const trail = [fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(2)), fix('10:10', P(2)), fix('10:20', P(2)), fix('10:30', P(3)), fix('11:50', P(4))];

  it('is in progress, has no check-out, hours run to now, the last leg ends at "now" and the route has no check-out point', async () => {
    const { f, asFetchers } = fetchersFor(open, [], trail);
    const r = await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: now });
    expect(r.shift).toEqual({ attendance_id: 'att-1', checkin_at: t('09:30'), checkout_at: null, total_hours: 2.5, in_progress: true });
    expect(r.travel.legs[r.travel.legs.length - 1].to.kind).toBe('now');
    expect(f.trail).toHaveBeenCalledWith(USER, t('09:30'), new Date(now).toISOString());
    // check-in point + the 7 fixes; no check-out point yet
    expect(r.route.points.map((p) => p.at)).toEqual([t('09:30'), ...trail.map((x) => x.captured_at as string)]);
    // the 09:50-10:20 stop is a halt; it ends at its last real ping, not at "now"
    expect(r.halts).toHaveLength(1);
    expect(r.halts[0]).toMatchObject({ start_at: t('09:50'), end_at: t('10:20'), minutes: 30 });
  });
});

describe('a day with visits and halts', () => {
  // 09:30 check-in at P0 · ride to P2 (09:50) · stand at P2 until 10:20 (a halt) · ride to the customer at P4 ·
  // dealer visit 10:30-10:50 and customer visit 11:00-11:20 (their fixes are NOT halts) · stand at P6 12:30-13:10 (a halt) · check-out 18:00 at P0
  const attendance = att({ total_hours: 8.5, transport_mode: 'own_bike' });
  const visits = [form('v1', '11:00', '11:20', P(4)), form('v0', '10:30', '10:50', P(3), 'Dealer Visit')];   // given out of order
  const trail = [
    fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(2)), fix('10:10', P(2)), fix('10:20', P(2)),
    fix('10:30', P(3)), fix('10:45', P(3)),
    fix('11:00', P(4)), fix('11:10', P(4)), fix('11:20', P(4)),
    fix('11:40', P(5)), fix('12:00', P(6)),
    fix('12:30', P(6)), fix('12:45', P(6)), fix('13:00', P(6)), fix('13:10', P(6)),
    fix('13:25', P(7)),
  ];

  it('lays the same travel result out: shift, mode, km + legs, visits, halts, route and summary', async () => {
    const { asFetchers } = fetchersFor(attendance, visits, trail);
    const r = await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: NOW_AFTER });
    const travel = await getDayTravel(asFetchers, { userId: USER, date: DATE, nowMs: NOW_AFTER });

    // (no second computation path: every number is the travel service's)
    expect(r.travel).toEqual({ total_km: travel.total_km, method: travel.method, legs: travel.legs });
    expect(r.halts).toEqual(travel.halts);
    expect(r.summary.total_km).toBe(travel.total_km);
    expect(r.travel.total_km).toBeGreaterThan(0);

    expect(r.shift).toEqual({ attendance_id: 'att-1', checkin_at: t('09:30'), checkout_at: t('18:00'), total_hours: 8.5, in_progress: false });
    expect(r.transport).toEqual({ mode: 'own_bike', label: 'Own Bike' });

    // visits: arrival / departure / minutes / where, earliest first (they were fetched out of order)
    expect(r.visits).toEqual([
      { submission_id: 'v0', label: 'Dealer Visit', arrival_at: t('10:30'), departure_at: t('10:50'), minutes: 20, lat: P(3)[0], lng: P(3)[1] },
      { submission_id: 'v1', label: 'Customer Visit', arrival_at: t('11:00'), departure_at: t('11:20'), minutes: 20, lat: P(4)[0], lng: P(4)[1] },
    ]);

    // halts: the two real stops in time order; the pings while at the dealer (10:30-10:45) and the customer (11:00-11:20) are visits, not halts
    expect(r.halts.map((h) => [h.index, h.start_at, h.end_at, h.minutes])).toEqual([
      [0, t('09:50'), t('10:20'), 30],
      [1, t('12:30'), t('13:10'), 40],
    ]);
    expect(r.halts[0]).toMatchObject({ lat: P(2)[0], lng: P(2)[1], points: 4 });

    expect(r.summary).toEqual({ visits: 2, visit_minutes: 40, halts: 2, halt_minutes: 70, total_km: travel.total_km });
  });

  it('visits and halts never overlap in time, and each list is chronological', async () => {
    const { asFetchers } = fetchersFor(attendance, visits, trail);
    const r = await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: NOW_AFTER });
    const arrivals = r.visits.map((v) => Date.parse(v.arrival_at));
    const starts = r.halts.map((h) => Date.parse(h.start_at));
    expect([...arrivals].sort((a, b) => a - b)).toEqual(arrivals);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    for (const h of r.halts) {
      for (const v of r.visits) {
        const overlap = Math.min(Date.parse(h.end_at), Date.parse(v.departure_at)) - Math.max(Date.parse(h.start_at), Date.parse(v.arrival_at));
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  it('the route runs check-in -> fixes -> check-out, in time order, without spoofed fixes', async () => {
    const spoof = [...trail, fix('12:10', P(9), { is_mock: true }), fix('12:11', P(9), { is_suspect: true })];
    const { asFetchers } = fetchersFor(attendance, visits, spoof);
    const r = await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: NOW_AFTER });
    expect(r.route.thinned).toBe(false);
    expect(r.route.points[0]).toEqual({ lat: P(0)[0], lng: P(0)[1], at: t('09:30') });
    expect(r.route.points[r.route.points.length - 1]).toEqual({ lat: P(0)[0], lng: P(0)[1], at: t('18:00') });
    expect(r.route.points).toHaveLength(trail.length + 2);
    expect(r.route.points.some((p) => p.lat === P(9)[0])).toBe(false);
    const times = r.route.points.map((p) => Date.parse(p.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('min_halt_minutes flows through to the halts', async () => {
    const { asFetchers } = fetchersFor(attendance, visits, trail);
    const r = await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: NOW_AFTER, minHaltMinutes: 35 });
    expect(r.halts.map((h) => h.start_at)).toEqual([t('12:30')]);
    expect(r.summary).toMatchObject({ halts: 1, halt_minutes: 40 });
  });

  it('reads the attendance row once and uses that very row for the shift and the mode', async () => {
    const { f, asFetchers } = fetchersFor(attendance, visits, trail);
    await getDailyReport(asFetchers, { userId: USER, date: DATE, user: ME, nowMs: NOW_AFTER });
    expect(f.attendance).toHaveBeenCalledTimes(1);
    expect(f.visits).toHaveBeenCalledTimes(1);
    expect(f.trail).toHaveBeenCalledTimes(1);
  });
});

describe('mode of transport in the report', () => {
  const report = (a: TravelAttendanceRow | null, modeLabel?: (m: string) => string | null) =>
    buildDailyReport({ date: DATE, user: ME, attendance: a, computation: computeDayTravel({ date: DATE, userId: USER, attendance: a, visits: [], trail: [], nowMs: NOW_AFTER }), nowMs: NOW_AFTER, modeLabel });

  it('shows the stored id and a label (default labels, or the caller\'s policy labels)', () => {
    expect(report(att({ transport_mode: 'public_transport' })).transport).toEqual({ mode: 'public_transport', label: 'Public transport' });
    expect(report(att({ transport_mode: 'own_bike' })).transport).toEqual({ mode: 'own_bike', label: 'Own Bike' });
    expect(report(att({ transport_mode: 'own_bike' }), () => 'Two-wheeler (bike)').transport).toEqual({ mode: 'own_bike', label: 'Two-wheeler (bike)' });
  });

  it.each([[null], [undefined], [''], [5]])('a missing / unusable stored mode (%p) is null / null', (m) => {
    expect(report(att({ transport_mode: m as any })).transport).toEqual({ mode: null, label: null });
    expect(storedTransportMode(att({ transport_mode: m as any }))).toBeNull();
  });

  it('a row from a database without the column simply has no mode', () => {
    const a = att();
    delete (a as any).transport_mode;
    expect(report(a).transport).toEqual({ mode: null, label: null });
  });
});

describe('getTeamReport', () => {
  const member = (i: number, over: Partial<TeamReportMember> = {}, a: Partial<TravelAttendanceRow> = {}): TeamReportMember => ({
    user_id: `u-${String(i).padStart(4, '0')}`,
    name: `Person ${String(i).padStart(4, '0')}`,
    employee_id: `E${i}`,
    attendance: att({ id: `att-${i}`, ...a }),
    ...over,
  });
  const fetchers = (visits: RawVisitRow[] = [], trail: TrailRow[] = []) => ({
    visits: jest.fn().mockResolvedValue(visits),
    trail: jest.fn().mockResolvedValue(trail),
  });
  const stop = [fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(2)), fix('10:10', P(2)), fix('10:20', P(2)), fix('10:30', P(5))];

  it('one row per person with a shift: the contract fields, from the same travel result as the single report', async () => {
    const m = member(1, { name: 'Asha', employee_id: 'EF-007' }, { transport_mode: 'public_transport' });
    const f = fetchers([form('v1', '11:00', '11:20', P(4))], stop);
    const rows = await getTeamReport(f, [m], { date: DATE, nowMs: NOW_AFTER });
    const single = await getDailyReport({ ...f, attendance: async () => m.attendance } as unknown as TravelFetchers, { userId: m.user_id, date: DATE, user: ME, nowMs: NOW_AFTER });
    expect(rows).toEqual([{
      user_id: m.user_id, name: 'Asha', employee_id: 'EF-007',
      checkin_at: t('09:30'), checkout_at: t('18:00'), total_hours: 8.5,
      mode: 'public_transport', label: 'Public transport',
      total_km: single.travel.total_km, visits: 1, visit_minutes: 20, halts: 1, halt_minutes: 30,
    }]);
    expect(rows[0]).toMatchObject({ visits: single.summary.visits, visit_minutes: single.summary.visit_minutes, halts: single.summary.halts, halt_minutes: single.summary.halt_minutes });
  });

  it('skips people without attendance that day, and rows with no usable check-in', async () => {
    const f = fetchers([], stop);
    const rows = await getTeamReport(f, [
      member(1),
      member(2, { attendance: null }),
      member(3, {}, { checkin_at: null, checkout_at: null, status: 'on_leave' }),
      member(4, {}, { checkin_at: t('12:00'), checkout_at: t('09:00') }),
    ], { date: DATE, nowMs: NOW_AFTER });
    expect(rows.map((r) => r.user_id)).toEqual(['u-0001']);
    expect(f.trail).toHaveBeenCalledTimes(1);                 // nothing is fetched for the people skipped
    expect(f.visits).toHaveBeenCalledTimes(1);
  });

  it('uses the attendance rows it was given (no per-person attendance query) and reads visits + trail per person', async () => {
    const f = fetchers([], stop);
    await getTeamReport(f, [member(1), member(2)], { date: DATE, nowMs: NOW_AFTER });
    expect(f.visits.mock.calls.map((c) => c[0]).sort()).toEqual(['u-0001', 'u-0002']);
    expect(f.trail.mock.calls.map((c) => c[0]).sort()).toEqual(['u-0001', 'u-0002']);
    expect(f.trail).toHaveBeenCalledWith('u-0001', t('09:30'), t('18:00'));
  });

  it('is sorted by name', async () => {
    const f = fetchers();
    const rows = await getTeamReport(f, [member(3, { name: 'zoya' }), member(1, { name: 'Bala' }), member(2, { name: 'asha' }), member(4, { name: null })], { date: DATE, nowMs: NOW_AFTER });
    expect(rows.map((r) => r.name)).toEqual([null, 'asha', 'Bala', 'zoya']);
  });

  it('labels the mode per person (their own policy), and leaves people without a mode null', async () => {
    const f = fetchers();
    const rows = await getTeamReport(f, [
      member(1, {}, { transport_mode: 'own_bike' }), member(2, {}, { transport_mode: 'own_bike' }), member(3),
    ], { date: DATE, nowMs: NOW_AFTER, modeLabel: (uid) => (uid === 'u-0001' ? 'Two-wheeler (bike)' : null) });
    expect(rows.map((r) => [r.mode, r.label])).toEqual([['own_bike', 'Two-wheeler (bike)'], ['own_bike', null], [null, null]]);
  });

  it('caps the team at 300 people', async () => {
    expect(TEAM_REPORT_MAX_USERS).toBe(300);
    const f = fetchers();
    const rows = await getTeamReport(f, Array.from({ length: 305 }, (_v, i) => member(i)), { date: DATE, nowMs: NOW_AFTER });
    expect(rows).toHaveLength(300);
    expect(f.trail).toHaveBeenCalledTimes(300);
  });

  it('computes 5 people at a time - never more, and really in parallel', async () => {
    expect(TEAM_REPORT_CONCURRENCY).toBe(5);
    let inFlight = 0;
    let peak = 0;
    const tracked = {
      visits: jest.fn().mockResolvedValue([]),
      trail: jest.fn(async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return [];
      }),
    };
    const rows = await getTeamReport(tracked, Array.from({ length: 23 }, (_v, i) => member(i)), { date: DATE, nowMs: NOW_AFTER });
    expect(rows).toHaveLength(23);
    expect(peak).toBe(5);
  });

  it('a failing read fails the report (no row with a made-up zero)', async () => {
    const bad = { visits: jest.fn().mockResolvedValue([]), trail: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(getTeamReport(bad, [member(1)], { date: DATE, nowMs: NOW_AFTER })).rejects.toThrow('db down');
  });

  it('an empty team is an empty list', async () => {
    expect(await getTeamReport(fetchers(), [], { date: DATE, nowMs: NOW_AFTER })).toEqual([]);
  });

  it('min_halt_minutes flows through', async () => {
    const f = fetchers([], stop);
    const [a] = await getTeamReport(f, [member(1)], { date: DATE, nowMs: NOW_AFTER });
    const [b] = await getTeamReport(f, [member(1)], { date: DATE, nowMs: NOW_AFTER, minHaltMinutes: 45 });
    expect([a.halts, b.halts]).toEqual([1, 0]);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps input order, honours the limit and tolerates an empty list', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBe(3);
    expect(await mapWithConcurrency([], 5, async (n: number) => n)).toEqual([]);
  });

  it('rejects with the first failure', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; })).rejects.toThrow('boom');
  });
});
