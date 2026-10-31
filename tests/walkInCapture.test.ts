/**
 * Walk-in "Not Purchased" quick-capture detection.
 *
 * The lead-create route (`POST /crm/leads`) uses `isWalkInCapture` to decide
 * whether to enforce required *custom* fields. Walk-in captures (reception's
 * minimal intake) must be exempt, because a client admin can mark fields like
 * "Approx. Budget" / "Area" required for the MAIN lead form — enforcing those
 * on the minimal walk-in form 400'd every save ("Couldn't save the lead").
 */
import { isWalkInCapture } from '../src/services/crm/walkIn';

describe('isWalkInCapture', () => {
  it('detects a walk-in via campaign=Walk-in', () => {
    expect(isWalkInCapture({ campaign: 'Walk-in', purchase_status: 'not_purchased' })).toBe(true);
    expect(isWalkInCapture({ campaign: 'Walk-in' })).toBe(true);
  });

  it('detects a walk-in via the purchase_status fallback marker', () => {
    expect(isWalkInCapture({ purchase_status: 'not_purchased' })).toBe(true);
  });

  it('is false for an ordinary lead (no walk-in markers)', () => {
    expect(isWalkInCapture({ campaign: 'Gold Scheme' })).toBe(false);
    expect(isWalkInCapture({ area: 'Andheri', approx_budget: '1-2L' })).toBe(false);
    expect(isWalkInCapture({})).toBe(false);
  });

  it('is false for missing / non-object custom_fields', () => {
    expect(isWalkInCapture(undefined)).toBe(false);
    expect(isWalkInCapture(null)).toBe(false);
    expect(isWalkInCapture('Walk-in')).toBe(false);
    expect(isWalkInCapture(42)).toBe(false);
  });

  it('does not treat a non-Walk-in campaign or other purchase_status as walk-in', () => {
    expect(isWalkInCapture({ campaign: 'walkin' })).toBe(false); // exact label only
    expect(isWalkInCapture({ purchase_status: 'purchased' })).toBe(false);
  });
});
