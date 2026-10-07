/**
 * The activity reminder text must read as a sentence in every case. It used to splice a phrase
 * that already started with "was" after a fixed "is", so an overdue reminder read
 * "Your meeting “X” is was due 23h ago."
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { dueClause, dispatchActivityReminders } from '../src/services/crm/activityReminders.service';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const at = (deltaMin: number) => new Date(NOW + deltaMin * 60_000).toISOString();

describe('dueClause', () => {
  it('upcoming: "is due in N min"', () => {
    expect(dueClause(at(25), NOW)).toBe('is due in 25 min');
  });
  it('right now: "is now due"', () => {
    expect(dueClause(at(0), NOW)).toBe('is now due');
    expect(dueClause(at(0.4), NOW)).toBe('is now due');
  });
  it('overdue: "was due …" with no leading "is"', () => {
    expect(dueClause(at(-20), NOW)).toBe('was due 20 min ago');
    expect(dueClause(at(-23 * 60), NOW)).toBe('was due 23h ago');
  });
  it('never produces "is was"', () => {
    for (const d of [60, 25, 1, 0, -1, -30, -90, -1380, -4000]) {
      expect(dueClause(at(d), NOW)).not.toMatch(/\bis was\b/);
    }
  });
});

describe('dispatchActivityReminders', () => {
  beforeEach(() => __mock.reset());

  it('writes a grammatical body for an overdue meeting', async () => {
    const user = '11111111-1111-1111-1111-111111111111';
    __mock.setDefault('crm_activities', {
      data: [{
        id: '22222222-2222-2222-2222-222222222222', org_id: '00000000-0000-0000-0000-000000000001',
        subject: 'Ujing brand kamdhanu', type: 'meeting', due_at: new Date(Date.now() - 23 * 3_600_000).toISOString(),
        assigned_to: user, owner_id: null, created_by: null, lead_id: null, deal_id: null,
      }],
    });
    const out = await dispatchActivityReminders();
    expect(out).toEqual({ checked: 1, created: 1 });
    const insert = __mock.chainsFor('notifications')[0].ops.find((o) => o.method === 'insert');
    const row = (insert?.args[0] ?? {}) as { body: string; type: string; user_id: string };
    expect(row.user_id).toBe(user);
    expect(row.type).toBe('crm_activity_due');
    expect(row.body).toBe('Your meeting “Ujing brand kamdhanu” was due 23h ago.');
  });
});
