/**
 * Pure arithmetic behind the FFM analytics (plus) widgets and reports: no database, no HTTP.
 * Every expected number is worked out by hand in the comment next to it.
 */
import {
  pct, round1, median, mean, hhmm, daysBetween, weekStartOf, isoWeekLabel, collapseStops, isVisited,
  orderKeys, isProductive, dwellMinutes, weeklyAdherence, weeklyProductive, outletRecency, visitFrequency,
  visitHours, outletChurn, attendanceHours, attendanceStats, repActivity, medianOf, supervisorRollup, outletGaps,
  type Stop, type OrderLite, type AttLite, type RepLite,
} from '../src/controllers/analytics/ffm-plus.compute';

const stop = (over: Partial<Stop> = {}): Stop => ({
  plan_id: 'p', user_id: 'u1', plan_date: '2026-11-09', territory_label: null, store_id: 's1', status: 'visited',
  planned_duration_min: null, checkin_at: null, checkout_at: null, checkin_distance_m: null, geofence_radius_m: null, ...over,
});
const ord = (over: Partial<OrderLite> = {}): OrderLite => ({ salesman_id: 'u1', outlet_id: 's1', revenue: 100, day: '2026-11-09', ...over });

describe('numeric helpers', () => {
  it('pct rounds to one decimal and is 0 when nothing is planned', () => {
    expect(pct(4, 7)).toBe(57.1);          // 57.142…
    expect(pct(2, 3)).toBe(66.7);
    expect(pct(0, 0)).toBe(0);
    expect(pct(5, 0)).toBe(0);
  });
  it('median handles odd, even and empty input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([NaN, 5])).toBe(5);
  });
  it('mean ignores non-numbers; round1 and hhmm format', () => {
    expect(mean([1, 2, NaN])).toBe(1.5);
    expect(mean([])).toBeNull();
    expect(round1(18.3333)).toBe(18.3);
    expect(hhmm(555)).toBe('09:15');
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(1439)).toBe('23:59');
    expect(hhmm(null)).toBeNull();
  });
  it('medianOf only looks at eligible rows and rounds to one decimal', () => {
    const rows = [{ v: 1.5, ok: true }, { v: 1.0, ok: true }, { v: 99, ok: false }, { v: 1.0, ok: true }];
    expect(medianOf(rows, (r) => r.v, (r) => r.ok)).toBe(1);
    expect(medianOf(rows, (r) => r.v, () => false)).toBeNull();
  });
});

describe('dates', () => {
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-09-20', '2026-11-10')).toBe(51);   // 10 (rest of Sep) + 31 (Oct) + 10
    expect(daysBetween('2026-11-10', '2026-11-10')).toBe(0);
  });
  it('weekStartOf is the Monday of the ISO week', () => {
    expect(weekStartOf('2026-11-10')).toBe('2026-11-09');     // Tuesday -> Monday
    expect(weekStartOf('2026-11-09')).toBe('2026-11-09');
    expect(weekStartOf('2026-11-15')).toBe('2026-11-09');     // Sunday belongs to the week that started Monday 9th
  });
  it('isoWeekLabel matches the ISO calendar, including year boundaries', () => {
    expect(isoWeekLabel('2026-11-09')).toBe('2026-W46');
    expect(isoWeekLabel('2026-11-02')).toBe('2026-W45');
    expect(isoWeekLabel('2026-01-01')).toBe('2026-W01');      // Thursday: week 1 of 2026
    expect(isoWeekLabel('2025-12-29')).toBe('2026-W01');      // the Monday of that week is still in Dec 2025
    expect(isoWeekLabel('2027-01-01')).toBe('2026-W53');      // Friday: the last week of 2026
  });
});

describe('collapseStops', () => {
  it('merges stops for the same rep + day + outlet into one call, visited if any stop was', () => {
    const calls = collapseStops([
      stop({ plan_id: 'a', status: 'pending' }),
      stop({ plan_id: 'b', status: 'visited', checkin_at: '2026-11-09T04:00:00Z', checkin_distance_m: 20 }),
      stop({ plan_id: 'c', store_id: 's2', status: 'pending' }),
    ]);
    expect(calls).toHaveLength(2);
    const s1 = calls.find((c) => c.store_id === 's1')!;
    expect(s1.visited).toBe(true);
    expect(s1.checkin_at).toBe('2026-11-09T04:00:00Z');
    expect(s1.checkin_distance_m).toBe(20);
  });
  it('different reps or days never merge; an outlet with no id never merges', () => {
    expect(collapseStops([stop(), stop({ user_id: 'u2' }), stop({ plan_date: '2026-11-08' })])).toHaveLength(3);
    expect(collapseStops([stop({ store_id: null }), stop({ store_id: null })])).toHaveLength(2);
  });
  it('visited statuses are the four the older widgets use, case-insensitive', () => {
    for (const s of ['visited', 'completed', 'done', 'checked_out', 'Visited']) expect(isVisited(s)).toBe(true);
    for (const s of ['pending', 'skipped', 'missed', null, undefined]) expect(isVisited(s as any)).toBe(false);
  });
});

describe('productive visits and dwell time', () => {
  it('a visit is productive only with the same rep + outlet + day order', () => {
    const keys = orderKeys([ord()]);
    const [hit] = collapseStops([stop()]);
    const [otherDay] = collapseStops([stop({ plan_date: '2026-11-08' })]);
    const [otherRep] = collapseStops([stop({ user_id: 'u2' })]);
    const [notVisited] = collapseStops([stop({ status: 'pending' })]);
    expect(isProductive(hit, keys)).toBe(true);
    expect(isProductive(otherDay, keys)).toBe(false);
    expect(isProductive(otherRep, keys)).toBe(false);
    expect(isProductive(notVisited, keys)).toBe(false);
  });
  it('dwell is check-out minus check-in, only when sane (0 < m <= 8h)', () => {
    expect(dwellMinutes({ checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T04:20:00Z' })).toBe(20);
    expect(dwellMinutes({ checkin_at: '2026-11-09T04:00:00Z', checkout_at: null })).toBeNull();
    expect(dwellMinutes({ checkin_at: '2026-11-09T04:20:00Z', checkout_at: '2026-11-09T04:00:00Z' })).toBeNull();   // negative
    expect(dwellMinutes({ checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T12:01:00Z' })).toBeNull();   // 8h01m
    expect(dwellMinutes({ checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T12:00:00Z' })).toBe(480);    // exactly 8h
  });
});

describe('weekly trends', () => {
  const calls = collapseStops([
    // week of Mon 11-02 (W45): 3 calls, 2 visited, two reps
    stop({ user_id: 'u1', plan_date: '2026-11-03', store_id: 'a' }),
    stop({ user_id: 'u1', plan_date: '2026-11-03', store_id: 'b', status: 'pending' }),
    stop({ user_id: 'u2', plan_date: '2026-11-05', store_id: 'a' }),
    // week of Mon 11-09 (W46): 2 calls, both visited, one rep
    stop({ user_id: 'u1', plan_date: '2026-11-09', store_id: 'a' }),
    stop({ user_id: 'u1', plan_date: '2026-11-10', store_id: 'b' }),
  ]);
  it('weeklyAdherence: planned, visited, missed, % and distinct reps per ISO week, oldest first', () => {
    expect(weeklyAdherence(calls)).toEqual([
      { week: '2026-W45', week_start: '2026-11-02', planned: 3, visited: 2, missed: 1, adherence_pct: 66.7, active_reps: 2 },
      { week: '2026-W46', week_start: '2026-11-09', planned: 2, visited: 2, missed: 0, adherence_pct: 100, active_reps: 1 },
    ]);
  });
  it('weeklyProductive counts only visited calls that have a matching order', () => {
    const keys = orderKeys([ord({ salesman_id: 'u1', outlet_id: 'a', day: '2026-11-03' }), ord({ salesman_id: 'u1', outlet_id: 'b', day: '2026-11-10' })]);
    expect(weeklyProductive(calls, keys)).toEqual([
      { week: '2026-W45', week_start: '2026-11-02', visits: 2, productive_visits: 1, productive_pct: 50 },
      { week: '2026-W46', week_start: '2026-11-09', visits: 2, productive_visits: 1, productive_pct: 50 },
    ]);
  });
  it('no calls -> no rows', () => {
    expect(weeklyAdherence([])).toEqual([]);
    expect(weeklyProductive([], new Set())).toEqual([]);
  });
});

describe('outlet distributions', () => {
  it('outletRecency buckets by days since the last visited call, and "Not visited" for never', () => {
    const calls = collapseStops([
      stop({ store_id: 'a', plan_date: '2026-11-10' }),                     // 0 days
      stop({ store_id: 'b', plan_date: '2026-11-03' }),                     // 7 days -> 0-7
      stop({ store_id: 'c', plan_date: '2026-11-02' }),                     // 8 days -> 8-14
      stop({ store_id: 'd', plan_date: '2026-10-20' }),                     // 21 -> 15-30
      stop({ store_id: 'e', plan_date: '2026-09-20' }),                     // 51 -> 31-60
      stop({ store_id: 'f', plan_date: '2026-08-20' }),                     // 82 -> 61-90
      stop({ store_id: 'g', status: 'pending' }),                           // never
      stop({ store_id: 'a', plan_date: '2026-10-01' }),                     // older visit of 'a' does not matter
    ]);
    const rows = outletRecency(calls, '2026-11-10');
    expect(rows.map((r) => [r.bucket, r.outlets])).toEqual([
      ['0–7 days', 2], ['8–14 days', 1], ['15–30 days', 1], ['31–60 days', 1], ['61–90 days', 1], ['Not visited', 1],
    ]);
    expect(rows[0].share_pct).toBe(28.6);                                   // 2 of 7 outlets
    expect(outletRecency([], '2026-11-10')).toEqual([]);
  });
  it('visitFrequency counts visits per outlet (rep-days), 4+ capped, planned-but-unvisited is its own bucket', () => {
    const calls = collapseStops([
      stop({ store_id: 'a', plan_date: '2026-11-01' }), stop({ store_id: 'a', plan_date: '2026-11-02' }), stop({ store_id: 'a', plan_date: '2026-11-03' }),
      stop({ store_id: 'a', plan_date: '2026-11-04' }), stop({ store_id: 'a', plan_date: '2026-11-05' }),   // 5 visits -> 4+
      stop({ store_id: 'b' }),                                                                              // 1
      stop({ store_id: 'c', status: 'pending' }),                                                           // 0
      stop({ store_id: 'd' }), stop({ store_id: 'd', user_id: 'u2' }),                                       // 2 reps same day = 2 visits
    ]);
    expect(visitFrequency(calls).map((r) => [r.bucket, r.outlets])).toEqual([
      ['Not visited', 1], ['1 visit', 1], ['2 visits', 1], ['3 visits', 0], ['4+ visits', 1],
    ]);
  });
  it('visitHours buckets visited check-ins by IST hour (04:00Z = 09:30 IST) and skips calls without a time', () => {
    const calls = collapseStops([
      stop({ store_id: 'a', checkin_at: '2026-11-09T04:00:00Z' }),          // 09:30
      stop({ store_id: 'b', checkin_at: '2026-11-09T03:45:00Z' }),          // 09:15
      stop({ store_id: 'c', checkin_at: '2026-11-09T05:30:00Z' }),          // 11:00
      stop({ store_id: 'd' }),                                              // no check-in time
      stop({ store_id: 'e', status: 'pending', checkin_at: '2026-11-09T05:30:00Z' }),
    ]);
    expect(visitHours(calls)).toEqual([
      { hour: 9, hour_label: '09:00', visits: 2, share_pct: 66.7 },
      { hour: 11, hour_label: '11:00', visits: 1, share_pct: 33.3 },
    ]);
  });
  it('outletChurn splits outlets into retained / new-or-returning / lapsed with revenue per window', () => {
    const cur = [ord({ outlet_id: 'a', revenue: 100 }), ord({ outlet_id: 'a', revenue: 50 }), ord({ outlet_id: 'b', revenue: 300 })];
    const prior = [ord({ outlet_id: 'a', revenue: 70 }), ord({ outlet_id: 'c', revenue: 40 })];
    expect(outletChurn(cur, prior)).toEqual([
      { segment: 'Retained (ordered in both)', outlets: 1, revenue_last_30d_inr: 150, revenue_prior_30d_inr: 70 },
      { segment: 'New or returning (last 30 days only)', outlets: 1, revenue_last_30d_inr: 300, revenue_prior_30d_inr: 0 },
      { segment: 'Lapsed (earlier 30 days only)', outlets: 1, revenue_last_30d_inr: 0, revenue_prior_30d_inr: 40 },
    ]);
    expect(outletChurn([], [])).toEqual([]);
  });
});

describe('attendance', () => {
  const row = (over: Partial<AttLite> = {}): AttLite => ({ user_id: 'u1', date: '2026-11-09', status: 'checked_out', checkin_at: null, checkout_at: null, total_hours: null, is_regularised: false, ...over });
  it('hours: stored total wins, else check-out minus check-in, else none', () => {
    expect(attendanceHours({ total_hours: 8.5, checkin_at: null, checkout_at: null })).toBe(8.5);
    expect(attendanceHours({ total_hours: null, checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T11:00:00Z' })).toBe(7);
    expect(attendanceHours({ total_hours: 0, checkin_at: '2026-11-09T04:00:00Z', checkout_at: null })).toBeNull();
  });
  it('stats: present days, mean check-in/out (IST), hours, missed check-outs (closed days only), regularised', () => {
    const stats = attendanceStats([
      row({ date: '2026-11-09', checkin_at: '2026-11-09T03:30:00Z', checkout_at: '2026-11-09T12:00:00Z', total_hours: 8.5 }),   // 09:00 -> 17:30
      row({ date: '2026-11-06', status: 'checked_in', checkin_at: '2026-11-06T03:45:00Z' }),                                    // 09:15, no check-out, a closed day
      row({ date: '2026-11-05', status: 'absent' }),
      row({ date: '2026-11-04', checkin_at: '2026-11-04T04:00:00Z', checkout_at: '2026-11-04T11:00:00Z', is_regularised: true }), // 09:30 -> 16:30, 7.0 h
      row({ date: '2026-11-10', status: 'checked_in', checkin_at: '2026-11-10T03:30:00Z' }),                                     // today, still open: not "missed"
      row({ date: '2026-11-09', checkin_at: '2026-11-09T03:30:00Z' }),                                                           // duplicate day: ignored
    ], '2026-11-10');
    expect(stats.get('u1')).toEqual({
      user_id: 'u1', days_present: 4,                        // 11-09, 11-06, 11-04 and today; the absent day and the duplicate row do not count
      avg_checkin_min: 551, avg_checkin_time: '09:11',       // (540 + 555 + 570 + 540) / 4 = 551.25
      avg_checkout_min: 1020, avg_checkout_time: '17:00',    // (1050 + 990) / 2
      total_hours: 15.5, hours_days: 2, avg_hours: 7.8, missed_checkouts: 1, regularised_days: 1,
    });
  });
});

describe('repActivity', () => {
  const reps: RepLite[] = [{ id: 'u1', name: 'Asha', supervisor_id: 's1' }, { id: 'u2', name: 'Bala', supervisor_id: 's1' }, { id: 'u3', name: 'Quiet', supervisor_id: null }];
  const stops: Stop[] = [
    stop({ store_id: 'a', checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T04:20:00Z', planned_duration_min: 15, checkin_distance_m: 40, geofence_radius_m: 100 }),  // 09:30-09:50, 20 min
    stop({ store_id: 'b', checkin_at: '2026-11-09T04:40:00Z', checkout_at: '2026-11-09T04:45:00Z', planned_duration_min: 10, checkin_distance_m: 160, geofence_radius_m: 100 }), // 10:10-10:15, 5 min, outside
    stop({ store_id: 'c', status: 'pending' }),
    stop({ user_id: 'u2', store_id: 'a', checkin_at: '2026-11-09T05:30:00Z', checkout_at: '2026-11-09T05:31:00Z', checkin_distance_m: 20 }),                                   // 1 min
  ];
  const plans = [{ id: 'p1', user_id: 'u1', plan_date: '2026-11-09', km: 12.5 }, { id: 'p2', user_id: 'u2', plan_date: '2026-11-09', km: 0 }];
  const orders = [ord({ outlet_id: 'a', revenue: 1000 }), ord({ outlet_id: 'a', revenue: 500, day: '2026-11-09' })];
  const rows = repActivity({ reps, calls: collapseStops(stops), plans, orders, attendance: [], today: '2026-11-10' });
  const asha = rows.find((r) => r.fe_id === 'u1')!;

  it('per-rep counts, ratios and travel', () => {
    expect(asha.planned_stops).toBe(3);
    expect(asha.visited_stops).toBe(2);
    expect(asha.missed_stops).toBe(1);
    expect(asha.adherence_pct).toBe(66.7);
    expect(asha.active_days).toBe(1);
    expect(asha.calls_per_day).toBe(2);
    expect(asha.productive_visits).toBe(1);                 // only outlet a has an order
    expect(asha.productive_pct).toBe(50);
    expect(asha.orders).toBe(2);
    expect(asha.revenue_inr).toBe(1500);
    expect(asha.aov_inr).toBe(750);
    expect(asha.orders_per_day).toBe(2);
    expect(asha.km_total).toBe(12.5);
    expect(asha.km_per_visit).toBe(6.3);                    // 12.5 / 2 = 6.25 -> 6.3
    expect(asha.km_per_day).toBe(12.5);
  });
  it('time on site, first / last call and geofence evidence', () => {
    expect(asha.timed_visits).toBe(2);
    expect(asha.avg_dwell_min).toBe(12.5);                  // (20 + 5) / 2
    expect(asha.avg_planned_min).toBe(12.5);                // (15 + 10) / 2
    expect(asha.under_2min_pct).toBe(0);
    expect(asha.onsite_min).toBe(25);
    expect(asha.first_call_time).toBe('09:30');
    expect(asha.last_call_time).toBe('10:15');              // the last check-out of the day
    expect(asha.avg_span_hours).toBe(0.8);                  // 45 min = 0.75 h
    expect(asha.checkins).toBe(2);
    expect(asha.outside_geofence).toBe(1);                  // 160 m > 100 m
    expect(asha.outside_pct).toBe(50);
    expect(asha.max_distance_m).toBe(160);
  });
  it('a rep with only a 1-minute visit is flagged as under 2 minutes; a quiet rep reads as zeros / nulls, never NaN', () => {
    const bala = rows.find((r) => r.fe_id === 'u2')!;
    expect(bala.under_2min_pct).toBe(100);
    expect(bala.km_per_visit).toBe(0);                      // 0 km over one visit
    const quiet = rows.find((r) => r.fe_id === 'u3')!;
    expect(quiet.planned_stops).toBe(0);
    expect(quiet.adherence_pct).toBe(0);
    expect(quiet.avg_dwell_min).toBeNull();
    expect(quiet.first_call_time).toBeNull();
    expect(quiet.days_present).toBe(0);
    for (const v of Object.values(quiet)) if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false);
  });
});

describe('supervisorRollup', () => {
  it('groups by supervisor with team-size-neutral measures; reps with no supervisor get their own row', () => {
    const reps: RepLite[] = [
      { id: 'u1', name: 'A', supervisor_id: 's1' }, { id: 'u2', name: 'B', supervisor_id: 's1' }, { id: 'u3', name: 'C', supervisor_id: null },
    ];
    const calls = collapseStops([
      stop({ user_id: 'u1', store_id: 'a' }), stop({ user_id: 'u1', store_id: 'b', status: 'pending' }),
      stop({ user_id: 'u2', store_id: 'a' }), stop({ user_id: 'u2', store_id: 'b', plan_date: '2026-11-08' }),
    ]);
    const acts = repActivity({ reps, calls, plans: [], orders: [ord({ salesman_id: 'u1', revenue: 900 })], attendance: [], today: '2026-11-10' });
    const rows = supervisorRollup(acts, new Map([['s1', 'Meera']]));
    expect(rows[0]).toMatchObject({
      supervisor_id: 's1', supervisor_name: 'Meera', reps: 2, active_reps: 2, planned_stops: 4, visited_stops: 3, adherence_pct: 75,
      active_rep_days: 3, calls_per_rep_day: 1, orders: 1, revenue_inr: 900, revenue_per_rep_inr: 450,
    });
    expect(rows[1]).toMatchObject({ supervisor_id: null, supervisor_name: 'No supervisor on record', reps: 1, active_reps: 0, visited_stops: 0 });
  });
});

describe('outletGaps', () => {
  it('last visit, days since (relative to as-of), busiest rep, and the outlet\'s orders', () => {
    const calls = collapseStops([
      stop({ user_id: 'u1', store_id: 'a', plan_date: '2026-11-01' }),
      stop({ user_id: 'u2', store_id: 'a', plan_date: '2026-11-05' }),
      stop({ user_id: 'u2', store_id: 'a', plan_date: '2026-11-06', status: 'pending' }),
      stop({ user_id: 'u1', store_id: 'b', status: 'pending' }),
    ]);
    const gaps = outletGaps(calls, [ord({ outlet_id: 'a', revenue: 200, day: '2026-11-04' }), ord({ outlet_id: 'a', revenue: 100, day: '2026-11-08' })], '2026-11-10');
    const a = gaps.find((g) => g.store_id === 'a')!;
    expect(a).toMatchObject({ planned_calls: 3, visited_calls: 2, last_visit_date: '2026-11-05', days_since_last_visit: 5, top_rep_id: 'u2', last_order_date: '2026-11-08', orders: 2, revenue_inr: 300 });
    expect(gaps.find((g) => g.store_id === 'b')).toMatchObject({ visited_calls: 0, last_visit_date: null, days_since_last_visit: null, orders: 0 });
  });
});
