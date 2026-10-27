import { evaluateClientAccess, istTodayISO } from '../src/lib/clientAccess';

/**
 * Pure client-access gate logic: a client blocks its users when it is manually
 * deactivated (is_active=false) or its trial end_date is a past IST day.
 */
describe('evaluateClientAccess', () => {
  const TODAY = '2026-10-27';
  const withTrial = (end_date: string | null | undefined) =>
    ({ is_active: true, settings: { trial: { end_date } } });

  it('allows an active client with no trial record', () => {
    expect(evaluateClientAccess({ is_active: true }, TODAY)).toEqual({ blocked: false, reason: null, message: '' });
  });

  it('allows an active client whose trial ends in the future', () => {
    expect(evaluateClientAccess(withTrial('2026-11-30'), TODAY).blocked).toBe(false);
  });

  it('still allows the last trial day itself (end_date === today)', () => {
    expect(evaluateClientAccess(withTrial(TODAY), TODAY).blocked).toBe(false);
  });

  it('blocks once the trial ended (end_date before today)', () => {
    const r = evaluateClientAccess(withTrial('2026-10-26'), TODAY);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('trial_ended');
    expect(r.message).toMatch(/trial/i);
  });

  it('blocks a manually deactivated client even with a future trial', () => {
    const r = evaluateClientAccess({ is_active: false, settings: { trial: { end_date: '2099-01-01' } } }, TODAY);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('inactive');
  });

  it('reports "inactive" ahead of "trial_ended" when both apply', () => {
    const r = evaluateClientAccess({ is_active: false, settings: { trial: { end_date: '2026-10-26' } } }, TODAY);
    expect(r.reason).toBe('inactive');
  });

  it('fails open on an unknown/missing client row (null)', () => {
    expect(evaluateClientAccess(null, TODAY).blocked).toBe(false);
  });

  it('ignores an empty, null or missing trial end_date', () => {
    expect(evaluateClientAccess(withTrial(''), TODAY).blocked).toBe(false);
    expect(evaluateClientAccess(withTrial(null), TODAY).blocked).toBe(false);
    expect(evaluateClientAccess(withTrial(undefined), TODAY).blocked).toBe(false);
    expect(evaluateClientAccess({ is_active: true, settings: {} }, TODAY).blocked).toBe(false);
    expect(evaluateClientAccess({ is_active: true, settings: null }, TODAY).blocked).toBe(false);
  });

  it('compares a full ISO-timestamp end_date by its calendar date', () => {
    expect(evaluateClientAccess(withTrial('2026-10-26T23:59:59Z'), TODAY).blocked).toBe(true);
    expect(evaluateClientAccess(withTrial('2026-10-27T00:00:00Z'), TODAY).blocked).toBe(false);
  });
});

describe('istTodayISO', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(istTodayISO(new Date('2026-10-27T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses the IST wall-calendar, so late-UTC is already the next IST day', () => {
    // 20:00 UTC = 01:30 IST next day; 10:00 UTC = 15:30 IST same day.
    expect(istTodayISO(new Date('2026-10-27T20:00:00Z'))).toBe('2026-10-28');
    expect(istTodayISO(new Date('2026-10-27T10:00:00Z'))).toBe('2026-10-27');
  });
});
