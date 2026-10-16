/**
 * normalizeUpsellInput — the pure validate/normalise step before an upsell is
 * inserted. Mirrors the table's constraints (must link a deal or lead; amount
 * required + non-negative; status in proposed|won|lost) so bad input is a clean
 * 400, not a DB error.
 */
import { normalizeUpsellInput } from '../src/services/crm/upsells.service';

describe('normalizeUpsellInput', () => {
  it('accepts a minimal upsell on a deal and defaults status/currency', () => {
    const r = normalizeUpsellInput({ deal_id: 'd1', amount: 5000 });
    expect(r.deal_id).toBe('d1');
    expect(r.lead_id).toBeNull();
    expect(r.amount).toBe(5000);
    expect(r.status).toBe('won');
    expect(r.currency).toBe('INR');
    expect(r.quantity).toBeNull();
  });

  it('accepts a lead-only upsell', () => {
    expect(normalizeUpsellInput({ lead_id: 'l1', amount: 1 }).lead_id).toBe('l1');
  });

  it('requires a deal or a lead', () => {
    expect(() => normalizeUpsellInput({ amount: 100 })).toThrow(/deal or a lead/i);
    expect(() => normalizeUpsellInput({ deal_id: '  ', lead_id: '', amount: 100 })).toThrow(/deal or a lead/i);
  });

  it('requires a valid, non-negative amount', () => {
    expect(() => normalizeUpsellInput({ deal_id: 'd1' })).toThrow(/amount/i);
    expect(() => normalizeUpsellInput({ deal_id: 'd1', amount: 'abc' })).toThrow(/amount/i);
    expect(() => normalizeUpsellInput({ deal_id: 'd1', amount: -5 })).toThrow(/amount/i);
  });

  it('parses an amount sent as a string with commas', () => {
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: '1,25,000' }).amount).toBe(125000);
  });

  it('validates status and lower-cases it', () => {
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: 1, status: 'Proposed' }).status).toBe('proposed');
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: 1, status: 'LOST' }).status).toBe('lost');
    expect(() => normalizeUpsellInput({ deal_id: 'd1', amount: 1, status: 'maybe' })).toThrow(/status must be/i);
  });

  it('keeps a positive quantity, drops a zero/negative one', () => {
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: 1, quantity: 3 }).quantity).toBe(3);
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: 1, quantity: 0 }).quantity).toBeNull();
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: 1, quantity: -2 }).quantity).toBeNull();
  });

  it('keeps a readable date and drops an unreadable one (falls to now() at insert)', () => {
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: 1, occurred_at: '2026-10-16' }).occurred_at).toBe('2026-10-16');
    expect(normalizeUpsellInput({ deal_id: 'd1', amount: 1, occurred_at: 'whenever' }).occurred_at).toBeNull();
  });

  it('trims product name and note, nulling blanks', () => {
    const r = normalizeUpsellInput({ deal_id: 'd1', amount: 1, product_name: '  Extended Warranty ', note: '   ' });
    expect(r.product_name).toBe('Extended Warranty');
    expect(r.note).toBeNull();
  });
});
