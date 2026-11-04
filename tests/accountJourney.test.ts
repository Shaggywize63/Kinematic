/**
 * Connected-B2B account journey extras: form-serial parsing, assignee-list parsing, the journey's step
 * composition, and the "other clients are untouched" guarantee of applyActivityExtras.
 */
jest.mock('../src/lib/supabase', () => ({ supabaseAdmin: { from: jest.fn(() => { throw new Error('db must not be touched'); }) } }));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock('../src/services/notify', () => ({ notifyUsers: jest.fn() }));

import { normalizeFormSerial } from '../src/lib/formRef';
import {
  normalizeAssigneeIds, applyActivityExtras, coAssignedActivityIds, isCoAssignee, MAX_ASSIGNEES,
} from '../src/services/crm/activityExtras.service';
import { composeSteps } from '../src/services/crm/accountJourney.service';
import { SPARK_CLIENT_ID } from '../src/lib/b2bClients';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIENT = '99999999-9999-4999-8999-999999999999';

describe('normalizeFormSerial', () => {
  it('accepts a plain serial and upper-cases it', () => {
    expect(normalizeFormSerial('SRPR2627-12')).toBe('SRPR2627-12');
    expect(normalizeFormSerial('  srpr2627-1 ')).toBe('SRPR2627-1');
  });
  it('accepts typographic dashes and stray spaces (what a phone keyboard produces)', () => {
    expect(normalizeFormSerial('SRPR2627–12')).toBe('SRPR2627-12');
    expect(normalizeFormSerial('SRPR2627 — 12')).toBe('SRPR2627-12');
    expect(normalizeFormSerial('SRPR 2627 - 12')).toBe('SRPR2627-12');
  });
  it('rejects anything that is not a serial', () => {
    for (const bad of ['', 'abc', 'SRPR-12', 'SRPR2627', 'SRPR2627-', '2627-12x', 'SRPR2627-12; drop table', null, undefined, 42]) {
      expect(normalizeFormSerial(bad as never)).toBeNull();
    }
  });
});

describe('normalizeAssigneeIds', () => {
  it('keeps order, lower-cases and drops duplicates / junk', () => {
    expect(normalizeAssigneeIds([U2.toUpperCase(), U1, U2, 'nope', 7, null])).toEqual([U2, U1]);
  });
  it('is empty for non-arrays', () => {
    expect(normalizeAssigneeIds(undefined)).toEqual([]);
    expect(normalizeAssigneeIds('x')).toEqual([]);
  });
  it('caps the list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(normalizeAssigneeIds(many)).toHaveLength(MAX_ASSIGNEES);
  });
});

describe('applyActivityExtras for a client outside the connected-B2B flow', () => {
  it('drops the extras and never touches the database', async () => {
    const payload: Record<string, unknown> = {
      subject: 's', assignee_ids: [U1, U2], form_serial: 'SRPR2627-1', product_ids: [U1], assigned_to: U2,
    };
    const ids = await applyActivityExtras({ orgId: 'o', clientId: OTHER_CLIENT, payload });
    expect(ids).toBeUndefined();
    expect(payload).toEqual({ subject: 's', assigned_to: U2 });
  });
  it('treats a missing client the same way', async () => {
    const payload: Record<string, unknown> = { assignee_ids: [U1] };
    expect(await applyActivityExtras({ orgId: 'o', clientId: null, payload })).toBeUndefined();
    expect(payload).toEqual({});
  });
  it('co-assignee lookups short-circuit without a database call', async () => {
    expect(await coAssignedActivityIds('o', OTHER_CLIENT, [U1])).toEqual([]);
    expect(await isCoAssignee('o', null, 'a', [U1])).toBe(false);
  });
});

describe('applyActivityExtras for a connected-B2B client', () => {
  it('leaves the payload alone when no extra is mentioned (and clears nothing)', async () => {
    const payload: Record<string, unknown> = { subject: 's', product_ids: [U1] };
    expect(await applyActivityExtras({ orgId: 'o', clientId: SPARK_CLIENT_ID, payload })).toBeUndefined();
    expect(payload).toEqual({ subject: 's', product_ids: [U1] });
  });
});

describe('composeSteps', () => {
  const none = { leads: 0, contacts: 0, visits: 0, forms: 0, activities: 0, updates: 0, deals: 0, quotations: 0, won: 0, expenses: 0, at: {} };

  it('always lists the seven steps in flow order', () => {
    expect(composeSteps(none).map((s) => s.key)).toEqual(['lead', 'account', 'contacts', 'visits', 'followups', 'deals', 'expenses']);
  });
  it('marks the furthest populated step as current and earlier populated ones as done', () => {
    const steps = composeSteps({ ...none, leads: 1, contacts: 2, visits: 2, forms: 1 });
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.lead.state).toBe('done');
    expect(by.account.state).toBe('done');
    expect(by.contacts.state).toBe('done');
    expect(by.visits.state).toBe('current');
    expect(by.visits.note).toBe('2 visits · 1 form');
    expect(by.followups.state).toBe('todo');
    expect(by.deals.state).toBe('todo');
  });
  it('words deals with quotations and wins', () => {
    const steps = composeSteps({ ...none, deals: 3, quotations: 2, won: 1 });
    const deals = steps.find((s) => s.key === 'deals')!;
    expect(deals.note).toBe('3 deals · 2 quotations · 1 won');
    expect(deals.state).toBe('current');
  });
  it('a brand-new account is just "account" (current), with every later step still to do', () => {
    const steps = composeSteps(none);
    expect(steps.find((s) => s.key === 'account')!.state).toBe('current');
    expect(steps.filter((s) => s.state === 'todo').map((s) => s.key)).toEqual(['lead', 'contacts', 'visits', 'followups', 'deals', 'expenses']);
  });
});
