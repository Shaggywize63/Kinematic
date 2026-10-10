/**
 * Distance travelled (services/travel.service.ts) — the PURE computation, driven with fixtures and injected
 * data fetchers, so no database is involved. Covers: trail legs, the straight-line fallback, no forms,
 * forms (legs between check-out and the next check-in), overlapping / out-of-order visits, an open shift,
 * a forgotten check-out, mock fixes, missing coordinates and the fetcher orchestration. Also pins that the
 * shared trail maths (expenses/trail.ts) still gives mileageFromTrail its old answer.
 */
import {
  buildDayTravel, getDayTravel, normalizeVisit, shiftWindow, OPEN_SHIFT_MAX_MS,
  type RawVisitRow, type TrailRow, type TravelAttendanceRow, type TravelFetchers,
} from '../src/services/travel.service';
import { haversineKm, sumTrailKm } from '../src/services/expenses/trail';

const DATE = '2026-10-09';
const USER = '22222222-2222-4222-8222-222222222222';
const t = (hhmm: string, date = DATE) => new Date(Date.parse(`${date}T${hhmm}:00+05:30`)).toISOString();
const NOW_AFTER = Date.parse(`${DATE}T20:00:00+05:30`);

type Pt = [number, number];
const P = (k: number): Pt => [13.0 + 0.01 * k, 80.2];            // k hundredths of a degree north: ~1.11 km each
const kmBetween = (a: Pt, b: Pt) => haversineKm(a[0], a[1], b[0], b[1]);

const att = (over: Partial<TravelAttendanceRow> = {}): TravelAttendanceRow => ({
  id: 'att-1', status: 'checked_out',
  checkin_at: t('09:30'), checkout_at: t('18:00'),
  checkin_lat: 13.0, checkin_lng: 80.2, checkout_lat: 13.0, checkout_lng: 80.2,
  ...over,
});
const fix = (hhmm: string, p: Pt, extra: Partial<TrailRow> = {}): TrailRow => ({ lat: p[0], lng: p[1], captured_at: t(hhmm), ...extra });
const form = (id: string, inHm: string, outHm: string, inPt: Pt, outPt: Pt, extra: Record<string, any> = {}): RawVisitRow => ({
  source: 'form',
  row: {
    id, check_in_at: t(inHm), check_out_at: t(outHm),
    check_in_gps: `${inPt[0]},${inPt[1]}`, check_out_gps: `${outPt[0]},${outPt[1]}`,
    builder_forms: { title: 'Customer Visit' }, ...extra,
  },
});

const run = (over: { attendance?: TravelAttendanceRow | null; visits?: RawVisitRow[]; trail?: TrailRow[]; nowMs?: number } = {}) =>
  buildDayTravel({
    date: DATE, userId: USER,
    attendance: over.attendance === undefined ? att() : over.attendance,
    visits: over.visits ?? [], trail: over.trail ?? [], nowMs: over.nowMs ?? NOW_AFTER,
  });

describe('no attendance', () => {
  it('is an empty result, not an error', () => {
    expect(run({ attendance: null })).toEqual({
      date: DATE, user_id: USER, attendance_id: null, started_at: null, ended_at: null, in_progress: false,
      total_km: 0, method: 'none', legs: [], stops: [], points_used: 0, points_excluded: 0,
    });
  });

  it('a row with no check-in (leave / absent placeholder) is zero travel but keeps its id', () => {
    const r = run({ attendance: att({ id: 'att-leave', checkin_at: null, checkout_at: null, status: 'on_leave' }), trail: [fix('10:00', P(1))] });
    expect(r).toMatchObject({ attendance_id: 'att-leave', started_at: null, ended_at: null, total_km: 0, method: 'none', legs: [], stops: [] });
  });

  it('a check-out before the check-in is unusable: zero travel', () => {
    const r = run({ attendance: att({ checkin_at: t('12:00'), checkout_at: t('09:00') }) });
    expect(r).toMatchObject({ total_km: 0, method: 'none', legs: [] });
  });
});

describe('no forms: one leg, check-in -> check-out', () => {
  it('sums the GPS trail between the two punches', () => {
    const r = run({
      attendance: att({ checkout_at: t('10:10'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }),
      trail: [fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(3))],
    });
    expect(r.legs).toHaveLength(1);
    expect(r.method).toBe('gps_trail');
    expect(r.legs[0]).toMatchObject({
      index: 0, method: 'gps_trail',
      from: { kind: 'checkin', label: 'Check-in', lat: 13.0, lng: 80.2, at: t('09:30') },
      to: { kind: 'checkout', label: 'Check-out', lat: P(4)[0], lng: P(4)[1], at: t('10:10') },
    });
    expect(Math.abs(r.total_km - kmBetween(P(0), P(4)))).toBeLessThan(0.011);
    expect(r.total_km).toBe(r.legs[0].km);
    expect(r).toMatchObject({ attendance_id: 'att-1', started_at: t('09:30'), ended_at: t('10:10'), in_progress: false, points_used: 3, points_excluded: 0, stops: [] });
  });

  it('falls back to the straight line when there is no trail', () => {
    const r = run({ attendance: att({ checkout_at: t('10:10'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }) });
    expect(r.method).toBe('straight_line');
    expect(r.legs[0].method).toBe('straight_line');
    expect(r.total_km).toBe(Math.round(kmBetween(P(0), P(4)) * 100) / 100);
  });

  it('a single fix is not a trail: straight line', () => {
    const r = run({ attendance: att({ checkout_at: t('10:10'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }), trail: [fix('09:50', P(2))] });
    expect(r.method).toBe('straight_line');
    expect(r.points_used).toBe(1);
  });

  it('fixes so far apart that every segment is a lost-trail gap also fall back to the straight line', () => {
    const r = run({
      attendance: att({ checkout_at: t('10:50'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }),
      trail: [fix('09:55', P(1)), fix('10:20', P(2))],       // 25-minute gaps everywhere
    });
    expect(r.method).toBe('straight_line');
    expect(r.total_km).toBe(Math.round(kmBetween(P(0), P(4)) * 100) / 100);
  });

  it('is 0 km / none when a coordinate is missing and the trail cannot help', () => {
    const r = run({ attendance: att({ checkin_lat: null, checkin_lng: null, checkout_at: t('10:10') }) });
    expect(r).toMatchObject({ total_km: 0, method: 'none' });
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ km: 0, method: 'none', from: { lat: null, lng: null } });
  });

  it('(0, 0) is the apps\' "no fix" placeholder: treated as a missing coordinate', () => {
    const r = run({ attendance: att({ checkin_lat: 0, checkin_lng: 0, checkout_at: t('10:10') }) });
    expect(r.method).toBe('none');
  });

  it('uses the trail with one anchor missing (the other anchor and the fixes still carry it)', () => {
    const r = run({
      attendance: att({ checkin_lat: null, checkin_lng: null, checkout_at: t('10:10'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }),
      trail: [fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(3))],
    });
    expect(r.method).toBe('gps_trail');
    expect(Math.abs(r.total_km - kmBetween(P(1), P(4)))).toBeLessThan(0.011);
  });

  it('skips mock / suspect fixes and reports them', () => {
    const r = run({
      attendance: att({ checkout_at: t('10:10'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }),
      trail: [fix('09:40', P(1)), fix('09:45', [14.5, 80.2], { is_mock: true }), fix('09:50', P(2)), fix('09:55', [14.5, 80.2], { is_suspect: true }), fix('10:00', P(3))],
    });
    expect(r.method).toBe('gps_trail');
    expect(Math.abs(r.total_km - kmBetween(P(0), P(4)))).toBeLessThan(0.011);
    expect(r.points_used).toBe(3);
    expect(r.points_excluded).toBe(2);
  });

  it('drops a teleport hop (> 150 km/h) instead of adding it', () => {
    const r = run({
      attendance: att({ checkout_at: t('10:20'), checkout_lat: P(2)[0], checkout_lng: P(2)[1] }),
      // 09:40 P1, 09:45 a point 20 km north in 5 min (240 km/h), 09:50 back at P2
      trail: [fix('09:40', P(1)), fix('09:45', [13.2, 80.2]), fix('09:50', P(2))],
    });
    expect(r.total_km).toBeLessThan(5);
  });

  it('ignores fixes outside the shift', () => {
    const r = run({
      attendance: att({ checkout_at: t('10:10'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }),
      trail: [fix('08:00', [20, 70]), fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(3)), fix('11:00', [20, 70])],
    });
    expect(Math.abs(r.total_km - kmBetween(P(0), P(4)))).toBeLessThan(0.011);
    expect(r.points_used).toBe(3);
  });
});

describe('with forms: travel is the legs between visits, not the visits', () => {
  const visits = [
    form('f1', '10:00', '10:20', P(3), P(3)),
    form('f2', '11:00', '11:15', P(6), P(6), { builder_forms: { title: 'Dealer Visit' } }),
  ];
  const trail = [
    fix('09:40', P(1)), fix('09:50', P(2)),
    fix('10:10', P(3)),                                         // inside visit 1: belongs to no leg
    fix('10:30', P(4)), fix('10:40', P(5)), fix('10:50', [13.055, 80.2]),
    fix('11:25', P(7)), fix('11:35', P(8)), fix('11:45', [13.085, 80.2]),
  ];
  const closing = { checkout_at: t('12:00'), checkout_lat: P(9)[0], checkout_lng: P(9)[1] };

  it('makes legs checkin->f1, f1->f2, f2->checkout and lists the stops', () => {
    const r = run({ attendance: att(closing), visits, trail });
    expect(r.legs.map((l) => [l.from.kind, l.to.kind])).toEqual([['checkin', 'form_checkin'], ['form_checkout', 'form_checkin'], ['form_checkout', 'checkout']]);
    expect(r.legs.map((l) => l.index)).toEqual([0, 1, 2]);
    expect(r.legs.map((l) => l.method)).toEqual(['gps_trail', 'gps_trail', 'gps_trail']);
    expect(r.legs[0].to).toMatchObject({ label: 'Customer Visit', at: t('10:00') });
    expect(r.legs[1].from).toMatchObject({ label: 'Customer Visit', at: t('10:20') });
    expect(r.legs[1].to).toMatchObject({ label: 'Dealer Visit', at: t('11:00') });
    expect(r.legs[2].from).toMatchObject({ label: 'Dealer Visit', at: t('11:15') });
    expect(r.method).toBe('gps_trail');
    // 3 legs of ~3.34 km each = the whole 0 -> 9 hundredths-of-a-degree run, with the time spent AT forms not counted.
    for (const l of r.legs) expect(Math.abs(l.km - kmBetween(P(0), P(3)))).toBeLessThan(0.011);
    expect(r.total_km).toBe(Math.round(r.legs.reduce((s, l) => s + l.km, 0) * 100) / 100);
    expect(r.stops).toEqual([
      { submission_id: 'f1', label: 'Customer Visit', check_in_at: t('10:00'), check_out_at: t('10:20'), minutes: 20 },
      { submission_id: 'f2', label: 'Dealer Visit', check_in_at: t('11:00'), check_out_at: t('11:15'), minutes: 15 },
    ]);
    // 8 fixes lie inside legs; the one during visit 1 is in no leg.
    expect(r.points_used).toBe(8);
  });

  it('the straight-line fallback works leg by leg', () => {
    const r = run({ attendance: att(closing), visits });
    expect(r.legs.map((l) => l.method)).toEqual(['straight_line', 'straight_line', 'straight_line']);
    expect(r.method).toBe('straight_line');
    expect(Math.abs(r.total_km - kmBetween(P(0), P(9)))).toBeLessThan(0.03);
  });

  it('reports `mixed` when some legs ride the trail and some fall back', () => {
    const r = run({ attendance: att(closing), visits, trail: [fix('09:40', P(1)), fix('09:50', P(2))] });
    expect(r.legs.map((l) => l.method)).toEqual(['gps_trail', 'straight_line', 'straight_line']);
    expect(r.method).toBe('mixed');
  });

  it('does not depend on the order the visits arrive in', () => {
    const a = run({ attendance: att(closing), visits, trail });
    const b = run({ attendance: att(closing), visits: [...visits].reverse(), trail: [...trail].reverse() });
    expect(b).toEqual(a);
  });

  it('a visit touching the shift start (check-in at the same instant) adds no empty leg', () => {
    const r = run({ attendance: att({ checkout_at: t('12:00') }), visits: [form('f0', '09:30', '10:00', P(0), P(0))] });
    expect(r.legs.map((l) => [l.from.kind, l.to.kind])).toEqual([['form_checkout', 'checkout']]);
  });
});

describe('overlapping and out-of-order visits drop their legs', () => {
  const closing = { checkout_at: t('12:00'), checkout_lat: P(9)[0], checkout_lng: P(9)[1] };

  it('no leg is drawn into a visit that overlaps the previous one; the later check-out carries on', () => {
    const r = run({
      attendance: att(closing),
      visits: [
        form('v1', '10:00', '10:30', P(3), P(3)),
        form('v2', '10:15', '10:45', P(5), P(5)),             // overlaps v1
        form('v3', '10:35', '10:40', P(4), P(4)),             // wholly inside v2: ignored for legs
      ],
    });
    expect(r.legs.map((l) => [l.from.kind, l.to.kind, l.from.at, l.to.at])).toEqual([
      ['checkin', 'form_checkin', t('09:30'), t('10:00')],
      ['form_checkout', 'checkout', t('10:45'), t('12:00')],
    ]);
    expect(r.stops.map((s) => s.submission_id)).toEqual(['v1', 'v2', 'v3']);
    expect(r.legs[1].from).toMatchObject({ lat: P(5)[0] });          // continues from where v2 ended
  });

  it('skips visits that are not usable: outside the shift, no check-out, out < in, no coordinates', () => {
    const r = run({
      attendance: att(closing),
      visits: [
        form('early', '09:00', '09:20', P(1), P(1)),                                   // before check-in
        form('late', '12:10', '12:20', P(1), P(1)),                                    // after check-out
        form('open', '10:00', '10:20', P(1), P(1), { check_out_at: null }),
        form('backwards', '11:00', '10:50', P(1), P(1)),
        form('nowhere', '10:00', '10:20', P(1), P(1), { check_in_gps: null, check_out_gps: null }),
        form('zero', '10:00', '10:20', P(1), P(1), { check_in_gps: '0,0', check_out_gps: '0.0, 0.0' }),
        form('good', '10:30', '10:40', P(3), P(3)),
      ],
    });
    expect(r.stops.map((s) => s.submission_id)).toEqual(['good']);
    expect(r.legs).toHaveLength(2);
  });
});

describe('where a visit\'s coordinates come from', () => {
  it('check_in_gps / check_out_gps first, then latitude/longitude (forms), then location_lat/lng (builder)', () => {
    const base = { id: 'x', check_in_at: t('10:00'), check_out_at: t('10:20') };
    const gps = normalizeVisit({ source: 'form', row: { ...base, check_in_gps: '13.5,80.5', check_out_gps: '13.6,80.6', latitude: 1, longitude: 1 } })!;
    expect([gps.inPt, gps.outPt]).toEqual([{ lat: 13.5, lng: 80.5 }, { lat: 13.6, lng: 80.6 }]);

    const formLatLng = normalizeVisit({ source: 'form', row: { ...base, latitude: 13.1, longitude: 80.1 } })!;
    expect([formLatLng.inPt, formLatLng.outPt]).toEqual([{ lat: 13.1, lng: 80.1 }, { lat: 13.1, lng: 80.1 }]);

    const builder = normalizeVisit({ source: 'builder', row: { ...base, location_lat: '13.2', location_lng: '80.2' } })!;
    expect(builder.inPt).toEqual({ lat: 13.2, lng: 80.2 });

    // builder rows do not read form_submissions' latitude/longitude, and vice versa
    expect(normalizeVisit({ source: 'builder', row: { ...base, latitude: 13.1, longitude: 80.1 } })).toBeNull();
    expect(normalizeVisit({ source: 'form', row: { ...base, location_lat: 13.2, location_lng: 80.2 } })).toBeNull();

    // one end missing reuses the other end
    const half = normalizeVisit({ source: 'form', row: { ...base, check_in_gps: '13.5,80.5' } })!;
    expect([half.inPt, half.outPt]).toEqual([{ lat: 13.5, lng: 80.5 }, { lat: 13.5, lng: 80.5 }]);
  });

  it('labels a visit with the form title, else the outlet name, else a generic name', () => {
    const base = { id: 'x', check_in_at: t('10:00'), check_out_at: t('10:20'), check_in_gps: '13.5,80.5' };
    expect(normalizeVisit({ source: 'form', row: { ...base, builder_forms: { title: 'Site Audit' }, outlet_name: 'ACME' } })!.label).toBe('Site Audit');
    expect(normalizeVisit({ source: 'form', row: { ...base, builder_forms: [{ title: 'Site Audit' }] } })!.label).toBe('Site Audit');
    expect(normalizeVisit({ source: 'form', row: { ...base, outlet_name: ' ACME ' } })!.label).toBe('ACME');
    expect(normalizeVisit({ source: 'form', row: base })!.label).toBe('Form visit');
  });

  it('accepts a timestamptz as the database prints it', () => {
    const v = normalizeVisit({ source: 'form', row: { id: 'x', check_in_at: '2026-10-09T04:30:00+00:00', check_out_at: '2026-10-09T04:50:00.123456+00:00', check_in_gps: '13.5,80.5' } })!;
    expect(v.outMs - v.inMs).toBe(20 * 60_000 + 123);
  });
});

describe('an open shift', () => {
  const open = { checkout_at: null, checkout_lat: null, checkout_lng: null, status: 'checked_in' };
  const now = Date.parse(`${DATE}T11:00:00+05:30`);

  it('runs to "now" and stands the latest fix in for the end point', () => {
    const r = run({ attendance: att(open), nowMs: now, trail: [fix('09:40', P(1)), fix('09:50', P(2)), fix('10:00', P(3)), fix('10:50', P(9))] });
    expect(r.in_progress).toBe(true);
    expect(r.ended_at).toBeNull();
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].to).toMatchObject({ kind: 'now', at: new Date(now).toISOString(), lat: P(9)[0], lng: P(9)[1], label: 'Now' });
    expect(r.method).toBe('gps_trail');
    // 09:30 -> 09:40 -> 09:50 -> 10:00 counted (3 x 1.11); 10:00 -> 10:50 is a lost-trail gap
    expect(Math.abs(r.total_km - kmBetween(P(0), P(3)))).toBeLessThan(0.02);
  });

  it('with no fix yet there is nowhere to measure to: 0 km / none (not a made-up number)', () => {
    const r = run({ attendance: att(open), nowMs: now });
    expect(r.in_progress).toBe(true);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ km: 0, method: 'none', to: { kind: 'now', lat: null, lng: null } });
  });

  it('a completed visit during the open shift is a stop, its time is not travel, and the last leg runs to now', () => {
    const r = run({
      attendance: att(open), nowMs: now,
      visits: [form('f1', '10:00', '10:20', P(3), P(3))],
      trail: [fix('09:40', P(1)), fix('09:50', P(2)), fix('10:30', P(4)), fix('10:40', P(5))],
    });
    expect(r.stops.map((s) => s.submission_id)).toEqual(['f1']);
    expect(r.legs.map((l) => [l.from.kind, l.to.kind])).toEqual([['checkin', 'form_checkin'], ['form_checkout', 'now']]);
  });

  it('an open shift whose check-in is over 24 h old is a forgotten check-out: not in progress, no final leg', () => {
    const later = Date.parse(`${DATE}T09:30:00+05:30`) + OPEN_SHIFT_MAX_MS + 3_600_000;
    const r = run({ attendance: att(open), nowMs: later, visits: [form('f1', '10:00', '10:20', P(3), P(3))], trail: [fix('09:40', P(1)), fix('09:50', P(2))] });
    expect(r.in_progress).toBe(false);
    expect(r.ended_at).toBeNull();
    expect(r.legs.map((l) => [l.from.kind, l.to.kind])).toEqual([['checkin', 'form_checkin']]);
  });

  it('shiftWindow reports the cases', () => {
    expect(shiftWindow(att(open), now)).toMatchObject({ open: true, stale: false, inProgress: true, endMs: now });
    expect(shiftWindow(att(), now)).toMatchObject({ open: false, inProgress: false, endMs: Date.parse(t('18:00')) });
    expect(shiftWindow(att({ checkin_at: 'garbage' }), now)).toBeNull();
  });
});

describe('getDayTravel (injected fetchers)', () => {
  const fetchers = (a: TravelAttendanceRow | null, visits: RawVisitRow[] = [], trail: TrailRow[] = []) => {
    const f = {
      attendance: jest.fn().mockResolvedValue(a),
      visits: jest.fn().mockResolvedValue(visits),
      trail: jest.fn().mockResolvedValue(trail),
    };
    return { f, asFetchers: f as unknown as TravelFetchers };
  };

  it('asks for the attendance of that user and date, then visits and trail over the shift window', async () => {
    const { f, asFetchers } = fetchers(att({ checkout_at: t('10:10'), checkout_lat: P(4)[0], checkout_lng: P(4)[1] }), [], [fix('09:40', P(1)), fix('09:50', P(2))]);
    const r = await getDayTravel(asFetchers, { userId: USER, date: DATE, nowMs: NOW_AFTER });
    expect(f.attendance).toHaveBeenCalledWith(USER, DATE);
    expect(f.visits).toHaveBeenCalledWith(USER, t('09:30'), t('10:10'));
    expect(f.trail).toHaveBeenCalledWith(USER, t('09:30'), t('10:10'));
    expect(r.method).toBe('gps_trail');
  });

  it('does not read visits or trail when there is no attendance that day', async () => {
    const { f, asFetchers } = fetchers(null);
    const r = await getDayTravel(asFetchers, { userId: USER, date: DATE, nowMs: NOW_AFTER });
    expect(r).toMatchObject({ attendance_id: null, total_km: 0, method: 'none', legs: [], stops: [] });
    expect(f.visits).not.toHaveBeenCalled();
    expect(f.trail).not.toHaveBeenCalled();
  });

  it('an open shift is fetched up to now', async () => {
    const now = Date.parse(`${DATE}T11:00:00+05:30`);
    const { f, asFetchers } = fetchers(att({ checkout_at: null, status: 'checked_in' }));
    await getDayTravel(asFetchers, { userId: USER, date: DATE, nowMs: now });
    expect(f.trail).toHaveBeenCalledWith(USER, t('09:30'), new Date(now).toISOString());
  });
});

describe('the shared trail maths is still mileageFromTrail\'s', () => {
  it('sumTrailKm applies the gap / hop / speed guards and the mock exclusion', () => {
    const pts = [
      { lat: 13.0, lng: 80.2, captured_at: t('10:00') },
      { lat: 13.01, lng: 80.2, captured_at: t('10:05') },                       // 1.11 km / 5 min: counted
      { lat: 13.02, lng: 80.2, captured_at: t('10:25') },                       // 20 min gap: skipped
      { lat: 13.03, lng: 80.2, captured_at: t('10:30'), is_mock: true },        // excluded
      { lat: 13.04, lng: 80.2, captured_at: t('10:35') },                       // 5 min after the 10:25 fix: counted
    ];
    const s = sumTrailKm(pts);
    expect(s.points_used).toBe(4);
    expect(s.points_excluded).toBe(1);
    expect(s.segments_counted).toBe(2);
    expect(s.segments_skipped).toBe(1);
    expect(s.km).toBeCloseTo(haversineKm(13.0, 80.2, 13.01, 80.2) + haversineKm(13.02, 80.2, 13.04, 80.2), 6);
  });

  it('the same instant twice is not a segment (skipped, no distance)', () => {
    const s = sumTrailKm([{ lat: 13, lng: 80, captured_at: t('10:00') }, { lat: 13, lng: 80, captured_at: t('10:00') }]);
    expect(s).toMatchObject({ km: 0, segments_counted: 0, segments_skipped: 1, points_used: 2 });
  });
});
