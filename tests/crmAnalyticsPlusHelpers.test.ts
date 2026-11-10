/** Pure helpers behind the Lead Management "plus" analytics. */
import {
  activityBucket, assertUuid, avg, callOutcome, dayBucket, dealSizeBand, enumParam, intParam, median, mondayOf, pct,
  percentile, resolveWindow, round1,
} from '../src/services/crm/analytics-plus.helpers';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');

describe('resolveWindow', () => {
  it('expands a date-only upper bound to the end of that UTC day (the last day is included)', () => {
    const w = resolveWindow({ from: '2026-10-01', to: '2026-10-31' }, 30, NOW);
    expect(w.fromIso).toBe('2026-10-01T00:00:00.000Z');
    expect(w.toIso).toBe('2026-10-31T23:59:59.999Z');
    expect(w.days).toBe(31);
  });
  it('keeps full timestamps as given', () => {
    const w = resolveWindow({ from: '2026-10-01T05:30:00.000Z', to: '2026-10-02T05:30:00.000Z' }, 30, NOW);
    expect([w.fromIso, w.toIso]).toEqual(['2026-10-01T05:30:00.000Z', '2026-10-02T05:30:00.000Z']);
  });
  it('defaults to the last N days ending now', () => {
    const w = resolveWindow(undefined, 30, NOW);
    expect(w.toIso).toBe('2026-11-10T12:00:00.000Z');
    expect(w.fromIso).toBe('2026-10-11T12:00:00.000Z');
  });
  it('a lone from runs to now; a lone to runs back the default span', () => {
    expect(resolveWindow({ from: '2026-11-01' }, 30, NOW).toIso).toBe('2026-11-10T12:00:00.000Z');
    expect(resolveWindow({ to: '2026-11-10' }, 10, NOW).fromIso).toBe('2026-10-31T23:59:59.999Z');
  });
  it('from after to is a 400', () => {
    expect(() => resolveWindow({ from: '2026-11-05', to: '2026-11-01' }, 30, NOW)).toThrow(/from must not be after to/);
  });
});

describe('validators', () => {
  it('intParam: default, bounds, whole numbers only', () => {
    expect(intParam(undefined, 'n', 6, 1, 24)).toBe(6);
    expect(intParam('', 'n', 6, 1, 24)).toBe(6);
    expect(intParam('12', 'n', 6, 1, 24)).toBe(12);
    for (const bad of ['0', '25', '-1', '1.5', 'abc', 'NaN', '1e3']) expect(() => intParam(bad, 'n', 6, 1, 24)).toThrow(/between 1 and 24/);
  });
  it('assertUuid accepts a UUID and rejects anything that could break out of a PostgREST filter', () => {
    const id = 'b1111111-1111-1111-1111-111111111111';
    expect(assertUuid(id, 'x')).toBe(id);
    expect(assertUuid(undefined, 'x')).toBeUndefined();
    expect(assertUuid('', 'x')).toBeUndefined();
    for (const bad of [`${id},id.eq.1`, `${id})`, 'abc', '123', ['a']]) expect(() => assertUuid(bad, 'x')).toThrow(/valid id/);
  });
  it('enumParam', () => {
    expect(enumParam('b', 'k', ['a', 'b'] as const, 'a')).toBe('b');
    expect(enumParam(undefined, 'k', ['a', 'b'] as const, 'a')).toBe('a');
    expect(() => enumParam('z', 'k', ['a', 'b'] as const, 'a')).toThrow(/one of: a, b/);
  });
});

describe('statistics', () => {
  it('median of odd / even / empty lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it('nearest-rank percentile', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([0.5, 2, 7, 49], 90)).toBe(49);
    expect(percentile([], 90)).toBeNull();
  });
  it('avg, pct and round1', () => {
    expect(avg([1, 2, 3, 4])).toBe(2.5);
    expect(avg([])).toBeNull();
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(2, 3)).toBe(66.7);
    expect(pct(0, 5)).toBe(0);
    expect(pct(1, 0)).toBeNull();
    expect(round1(14.625)).toBe(14.6);
  });
});

describe('bucketing', () => {
  it('dayBucket uses whole days', () => {
    expect([0, 0.9, 1, 3.9, 4, 7.99, 8, 14, 15, 30, 31, 60, 61, 400].map(dayBucket)).toEqual(
      ['<1d', '<1d', '1–3d', '1–3d', '4–7d', '4–7d', '8–14d', '8–14d', '15–30d', '15–30d', '31–60d', '31–60d', '60d+', '60d+'],
    );
  });
  it('dealSizeBand edges (INR)', () => {
    expect([null, 0, -5, 1, 9_999, 10_000, 49_999, 50_000, 99_999, 100_000, 499_999, 500_000, 999_999, 1_000_000, 9e9].map((a) => dealSizeBand(Number(a ?? 0)))).toEqual([
      'No amount', 'No amount', 'No amount', 'Under ₹10K', 'Under ₹10K', '₹10K–50K', '₹10K–50K', '₹50K–1L', '₹50K–1L',
      '₹1L–5L', '₹1L–5L', '₹5L–10L', '₹5L–10L', '₹10L+', '₹10L+',
    ]);
  });
  it('mondayOf puts Sunday in the week that started the Monday before', () => {
    expect(mondayOf(Date.parse('2026-11-10T12:00:00Z'))).toBe('2026-11-09'); // Tuesday
    expect(mondayOf(Date.parse('2026-11-09T00:00:00Z'))).toBe('2026-11-09'); // Monday
    expect(mondayOf(Date.parse('2026-11-08T23:59:59Z'))).toBe('2026-11-02'); // Sunday
  });
  it('activityBucket folds type spellings', () => {
    expect(['call', 'CALL', 'Email', 'meeting', 'visit', 'site_visit', 'task', 'note', 'sms', 'whatsapp', 'demo', null, ''].map(activityBucket)).toEqual(
      ['call', 'call', 'email', 'meeting', 'site_visit', 'site_visit', 'task', 'note', 'message', 'message', 'other', 'other', 'other'],
    );
  });
  it('callOutcome: connected by prefix, blanks are not counted', () => {
    expect(['Connected', 'connected – interested', 'Connected - not interested', 'Not reachable', 'Busy', '', null, undefined].map(callOutcome)).toEqual(
      ['connected', 'connected', 'connected', 'not_connected', 'not_connected', 'none', 'none', 'none'],
    );
  });
});
