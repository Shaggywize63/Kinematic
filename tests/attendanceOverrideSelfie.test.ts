/**
 * Admin attendance-override selfie set/clear semantics.
 *
 * Bug: removing a check-in / check-out selfie from the dashboard attendance
 * override form did nothing — the override controller never read the selfie
 * fields, so the column was neither set nor cleared. The fix routes both
 * override handlers through `applyOverrideSelfies`, which:
 *   - sets the column to a trimmed URL when a non-empty string is sent,
 *   - clears it (null) when an empty string / null is sent (the "remove" case),
 *   - leaves it untouched when the key is absent (so other callers can't
 *     clobber an existing selfie).
 */
import { applyOverrideSelfies, emptySelfieToNull } from '../src/controllers/attendance.controller';

describe('emptySelfieToNull', () => {
  it('keeps a non-empty URL (trimmed)', () => {
    expect(emptySelfieToNull('https://x/s.jpg')).toBe('https://x/s.jpg');
    expect(emptySelfieToNull('  https://x/s.jpg  ')).toBe('https://x/s.jpg');
  });
  it('maps empty / blank / null / undefined / non-string to null', () => {
    expect(emptySelfieToNull('')).toBeNull();
    expect(emptySelfieToNull('   ')).toBeNull();
    expect(emptySelfieToNull(null)).toBeNull();
    expect(emptySelfieToNull(undefined)).toBeNull();
    expect(emptySelfieToNull(123)).toBeNull();
  });
});

describe('applyOverrideSelfies', () => {
  it('clears a selfie when the form sends an empty value (the remove case)', () => {
    const target: Record<string, unknown> = {};
    applyOverrideSelfies({ checkin_selfie_url: '', checkout_selfie_url: null }, target);
    expect(target).toEqual({ checkin_selfie_url: null, checkout_selfie_url: null });
  });

  it('sets a selfie when a URL is sent', () => {
    const target: Record<string, unknown> = {};
    applyOverrideSelfies({ checkin_selfie_url: 'https://x/ci.jpg' }, target);
    expect(target).toEqual({ checkin_selfie_url: 'https://x/ci.jpg' });
    // checkout key absent → not written
    expect('checkout_selfie_url' in target).toBe(false);
  });

  it('leaves selfies untouched when the keys are absent', () => {
    const target: Record<string, unknown> = { status: 'present' };
    applyOverrideSelfies({ status: 'present' }, target);
    expect(target).toEqual({ status: 'present' });
    expect('checkin_selfie_url' in target).toBe(false);
    expect('checkout_selfie_url' in target).toBe(false);
  });

  it('handles each side independently', () => {
    const target: Record<string, unknown> = {};
    applyOverrideSelfies({ checkin_selfie_url: 'https://x/ci.jpg', checkout_selfie_url: '' }, target);
    expect(target).toEqual({ checkin_selfie_url: 'https://x/ci.jpg', checkout_selfie_url: null });
  });
});
