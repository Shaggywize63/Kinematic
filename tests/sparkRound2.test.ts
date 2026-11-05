/**
 * Spark & Ray round 2: upcoming-activity reminder planning (7 / 3 / 1 days), the deal pricing helper, and the
 * "other clients are untouched" guarantee of the deal sections.
 */
jest.mock('../src/lib/supabase', () => ({ supabaseAdmin: { from: jest.fn(() => { throw new Error('db must not be touched'); }) } }));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock('../src/services/notify', () => ({ notifyUsers: jest.fn() }));

import { planReminder, reminderOffsets, dueInWords } from '../src/services/crm/activityReminders.service';
import { applyDealSections, finalPrice, DEAL_SECTION_KEYS } from '../src/services/crm/dealSections.service';
import { SPARK_CLIENT_ID } from '../src/lib/b2bClients';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T06:00:00Z');

describe('reminderOffsets', () => {
  it('defaults to 7 / 3 / 1', () => expect(reminderOffsets(undefined)).toEqual([7, 3, 1]));
  it('sorts descending, de-duplicates and drops junk', () => {
    expect(reminderOffsets([1, 7, 3, 3, 0, -2, 'x', 90])).toEqual([7, 3, 1]);
  });
  it('falls back when nothing valid is left', () => expect(reminderOffsets([0, 99])).toEqual([7, 3, 1]));
});

describe('planReminder', () => {
  const offsets = [7, 3, 1];
  it('sends nothing while the due date is further than the largest offset', () => {
    expect(planReminder(NOW + 8 * DAY, NOW, offsets, new Set())).toEqual({ send: null, log: [] });
  });
  it('sends the 1-week reminder once it is within 7 days', () => {
    expect(planReminder(NOW + 6.5 * DAY, NOW, offsets, new Set())).toEqual({ send: 7, log: [7] });
  });
  it('does not repeat an offset that already went out', () => {
    expect(planReminder(NOW + 6.5 * DAY, NOW, offsets, new Set([7]))).toEqual({ send: null, log: [] });
  });
  it('sends the 3-day reminder next, logging only what is new', () => {
    expect(planReminder(NOW + 2.5 * DAY, NOW, offsets, new Set([7]))).toEqual({ send: 3, log: [3] });
  });
  it('sends the 1-day reminder', () => {
    expect(planReminder(NOW + 0.5 * DAY, NOW, offsets, new Set([7, 3]))).toEqual({ send: 1, log: [1] });
  });
  it('an activity created 2 days ahead gets ONE reminder (not a 7-day and a 3-day burst), and 1-day still follows', () => {
    const first = planReminder(NOW + 2 * DAY, NOW, offsets, new Set());
    expect(first.send).toBe(3);
    expect(first.log.sort()).toEqual([3, 7]);
    expect(planReminder(NOW + 0.9 * DAY, NOW, offsets, new Set(first.log)).send).toBe(1);
  });
  it('never fires for a due date already in the past', () => {
    expect(planReminder(NOW - 1000, NOW, offsets, new Set())).toEqual({ send: null, log: [] });
  });
});

describe('dueInWords', () => {
  it('says today / tomorrow / in N days by IST calendar day', () => {
    expect(dueInWords('2026-11-05T10:00:00Z', NOW)).toMatch(/^today/);
    expect(dueInWords('2026-11-06T06:00:00Z', NOW)).toMatch(/^tomorrow/);
    expect(dueInWords('2026-11-12T06:00:00Z', NOW)).toMatch(/^in 7 days/);
  });
});

describe('finalPrice', () => {
  it('applies the discount and rounds to paise', () => {
    expect(finalPrice(1000, 10)).toBe(900);
    expect(finalPrice('1999.99', 12.5)).toBe(1749.99);
  });
  it('treats a missing discount as none and a missing quote as nothing to price', () => {
    expect(finalPrice(500, null)).toBe(500);
    expect(finalPrice(null, 10)).toBeNull();
  });
  it('clamps the discount to 0-100%', () => {
    expect(finalPrice(100, 150)).toBe(0);
    expect(finalPrice(100, -5)).toBe(100);
  });
});

describe('applyDealSections', () => {
  const full = () => Object.fromEntries(DEAL_SECTION_KEYS.map((k) => [k, 'x'])) as Record<string, unknown>;
  it('removes every section key for a client outside the connected-B2B flow (and never touches the database)', async () => {
    const payload = { ...full(), name: 'Deal' };
    await applyDealSections({ orgId: 'o', clientId: '99999999-9999-4999-8999-999999999999', payload });
    expect(payload).toEqual({ name: 'Deal' });
  });
  it('treats a missing client the same way', async () => {
    const payload = { ...full() };
    await applyDealSections({ orgId: 'o', clientId: null, payload });
    expect(payload).toEqual({});
  });
  it('prices the final amount from the quote + discount for a connected-B2B client', async () => {
    const payload: Record<string, unknown> = { pricing_quoted: 2000, pricing_discount_pct: 25 };
    await applyDealSections({ orgId: 'o', clientId: SPARK_CLIENT_ID, payload });
    expect(payload.pricing_final).toBe(1500);
  });
  it('re-prices against the stored quote when only the discount changes', async () => {
    const payload: Record<string, unknown> = { pricing_discount_pct: 50 };
    await applyDealSections({ orgId: 'o', clientId: SPARK_CLIENT_ID, payload, existing: { pricing_quoted: 400, pricing_discount_pct: 0 } });
    expect(payload.pricing_final).toBe(200);
  });
  it('keeps an explicit final price', async () => {
    const payload: Record<string, unknown> = { pricing_quoted: 2000, pricing_discount_pct: 25, pricing_final: 1400 };
    await applyDealSections({ orgId: 'o', clientId: SPARK_CLIENT_ID, payload });
    expect(payload.pricing_final).toBe(1400);
  });
  it('rejects a trial that ends before it starts', async () => {
    await expect(applyDealSections({
      orgId: 'o', clientId: SPARK_CLIENT_ID, payload: { trial_start: '2026-11-10', trial_end: '2026-11-01' },
    })).rejects.toThrow(/trial end date/i);
  });
});
