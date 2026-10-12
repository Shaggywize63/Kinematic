/**
 * Daily odometer trip — the pure rules behind the two-step (morning start / evening end) flow.
 * DB orchestration (start/end building the day's draft claim) is covered by the claim-flow tests;
 * here we pin the decisions: when the flow is on, which vehicle a trip takes, the distance maths,
 * the trip's status, and exactly what is still missing to start or to end.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import {
  dailyTripEnabled, photosRequired, resolveTripVehicle, tripDistance, tripStatus,
  startProblems, endProblems, tripTitle, tripDateIst, num, round2,
} from '../src/services/expenses/odometerTrip.service';

const BIKE = { id: 'bike', label: 'Bike', rate_per_km: 4 };
const CAR = { id: 'car', label: 'Car', rate_per_km: 10 };

describe('dailyTripEnabled', () => {
  it('needs both the flag AND at least one vehicle rate', () => {
    expect(dailyTripEnabled({ odometer_daily_trip: true, vehicle_rates: [BIKE] })).toBe(true);
    expect(dailyTripEnabled({ odometer_daily_trip: true, vehicle_rates: [] })).toBe(false);
    expect(dailyTripEnabled({ odometer_daily_trip: false, vehicle_rates: [BIKE] })).toBe(false);
    expect(dailyTripEnabled({ vehicle_rates: [BIKE] })).toBe(false);
    expect(dailyTripEnabled(null)).toBe(false);
    expect(dailyTripEnabled(undefined)).toBe(false);
  });
});

describe('photosRequired', () => {
  it('defaults to true, off only when explicitly false', () => {
    expect(photosRequired({})).toBe(true);
    expect(photosRequired({ odometer_photos_required: true })).toBe(true);
    expect(photosRequired({ odometer_photos_required: false })).toBe(false);
    expect(photosRequired(null)).toBe(true);
  });
});

describe('resolveTripVehicle', () => {
  const rules = { vehicle_rates: [BIKE, CAR] };
  it('keeps a valid chosen vehicle', () => {
    expect(resolveTripVehicle('car', rules)).toBe('car');
  });
  it('falls back to the sole vehicle when none/invalid is given and there is exactly one', () => {
    expect(resolveTripVehicle('', { vehicle_rates: [BIKE] })).toBe('bike');
    expect(resolveTripVehicle(null, { vehicle_rates: [BIKE] })).toBe('bike');
    expect(resolveTripVehicle('scooter', { vehicle_rates: [BIKE] })).toBe('bike');
  });
  it('returns null when several rates exist and none is chosen (the rep must pick)', () => {
    expect(resolveTripVehicle('', rules)).toBeNull();
    expect(resolveTripVehicle('van', rules)).toBeNull();
  });
  it('returns null with no rates at all', () => {
    expect(resolveTripVehicle('bike', { vehicle_rates: [] })).toBeNull();
  });
});

describe('tripDistance', () => {
  it('is end − start when both present and end ≥ start', () => {
    expect(tripDistance(100, 142)).toBe(42);
    expect(tripDistance(100, 100)).toBe(0);
    expect(tripDistance('1000', '1012.5')).toBe(12.5);
  });
  it('is null for a missing reading or an end below the start', () => {
    expect(tripDistance(100, null)).toBeNull();
    expect(tripDistance(null, 100)).toBeNull();
    expect(tripDistance('', '')).toBeNull();
    expect(tripDistance(142, 100)).toBeNull();
  });
});

describe('tripStatus', () => {
  it('none → open → closed as readings come in', () => {
    expect(tripStatus(null, null)).toBe('none');
    expect(tripStatus(100, null)).toBe('open');
    expect(tripStatus(100, 142)).toBe('closed');
    // An end with no start is still "none" — a trip is defined by its start.
    expect(tripStatus(null, 142)).toBe('none');
  });
});

describe('startProblems', () => {
  const rules = { vehicle_rates: [BIKE, CAR] };
  it('is empty for a complete start', () => {
    expect(startProblems({ odometer_start: 100, vehicle_type: 'bike', start_photo_url: 'https://x/a.jpg' }, rules)).toEqual([]);
  });
  it('flags a missing vehicle when several exist', () => {
    const codes = startProblems({ odometer_start: 100, start_photo_url: 'https://x/a.jpg' }, rules).map((p) => p.code);
    expect(codes).toContain('vehicle_missing');
  });
  it('does not flag the vehicle when there is a sole one to default to', () => {
    const codes = startProblems({ odometer_start: 100, start_photo_url: 'https://x/a.jpg' }, { vehicle_rates: [BIKE] }).map((p) => p.code);
    expect(codes).not.toContain('vehicle_missing');
  });
  it('flags a missing start reading', () => {
    const codes = startProblems({ vehicle_type: 'bike', start_photo_url: 'https://x/a.jpg' }, rules).map((p) => p.code);
    expect(codes).toContain('start_missing');
  });
  it('flags a missing photo only when photos are required', () => {
    expect(startProblems({ odometer_start: 100, vehicle_type: 'bike' }, rules).map((p) => p.code)).toContain('start_photo_missing');
    expect(startProblems({ odometer_start: 100, vehicle_type: 'bike' }, { ...rules, odometer_photos_required: false }).map((p) => p.code))
      .not.toContain('start_photo_missing');
  });
});

describe('endProblems', () => {
  const rules = { vehicle_rates: [BIKE] };
  it('is empty for a valid end', () => {
    expect(endProblems(100, { odometer_end: 142, end_photo_url: 'https://x/b.jpg' }, rules)).toEqual([]);
  });
  it('flags when no start is on file', () => {
    const codes = endProblems(null, { odometer_end: 142, end_photo_url: 'https://x/b.jpg' }, rules).map((p) => p.code);
    expect(codes).toContain('not_started');
  });
  it('flags a missing end reading', () => {
    const codes = endProblems(100, { end_photo_url: 'https://x/b.jpg' }, rules).map((p) => p.code);
    expect(codes).toContain('end_missing');
  });
  it('flags an end below the start', () => {
    const codes = endProblems(200, { odometer_end: 150, end_photo_url: 'https://x/b.jpg' }, rules).map((p) => p.code);
    expect(codes).toContain('end_before_start');
  });
  it('flags a missing end photo only when required', () => {
    expect(endProblems(100, { odometer_end: 142 }, rules).map((p) => p.code)).toContain('end_photo_missing');
    expect(endProblems(100, { odometer_end: 142 }, { ...rules, odometer_photos_required: false }).map((p) => p.code))
      .not.toContain('end_photo_missing');
  });
});

describe('helpers', () => {
  it('tripTitle names the day', () => {
    expect(tripTitle('2026-10-12')).toBe('Travel — 2026-10-12');
  });
  it('tripDateIst rolls the day at IST midnight, not UTC midnight', () => {
    // 2026-10-11 20:00 UTC = 2026-10-12 01:30 IST → already the 12th in IST.
    expect(tripDateIst(Date.parse('2026-10-11T20:00:00Z'))).toBe('2026-10-12');
    // 2026-10-11 17:00 UTC = 2026-10-11 22:30 IST → still the 11th.
    expect(tripDateIst(Date.parse('2026-10-11T17:00:00Z'))).toBe('2026-10-11');
  });
  it('num coerces, round2 rounds', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num('')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num('abc')).toBeNull();
    expect(round2(12.345)).toBe(12.35);
  });
});
