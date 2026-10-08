/**
 * Attendance sweep: a rep still checked in 10 h after starting gets a reminder (once), and any shift still
 * open when its IST day ends is closed at 12:00 AM IST. Both must be safe to run on every tick, for every
 * client, without ever overwriting a real check-out or touching a shift that is still legitimately open.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import {
  autoCheckoutOverdue, sendCheckoutReminders, runAttendanceSweep, istDayStartMs, istDayEndMs, workedMinutes,
  CHECKOUT_REMINDER_KIND, AUTO_CHECKOUT_NOTE, AUTO_CHECKOUT_SETTING, CHECKOUT_REMINDER_SETTING,
} from '../src/services/attendanceSweep.service';

const supa = () => (global as any).__supa;
const iso = (s: string) => new Date(s).toISOString();
const has = (chain: any, method: string, ...args: unknown[]) =>
  chain.ops.some((o: any) => o.method === method && args.every((a, i) => JSON.stringify(o.args[i]) === JSON.stringify(a)));
const updatesOf = (table: string) =>
  supa().chainsFor(table).filter((c: any) => has(c, 'update')).map((c: any) => ({ chain: c, patch: c.ops.find((o: any) => o.method === 'update').args[0] }));
const insertsOf = (table: string) =>
  supa().chainsFor(table).flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert').map((o: any) => o.args[0]));

// 2026-10-08 10:00 UTC = 15:30 IST. IST day = 2026-10-07T18:30Z .. 2026-10-08T18:30Z.
const NOW = Date.parse('2026-10-08T10:00:00Z');
const TODAY_START = iso('2026-10-07T18:30:00Z');

const shift = (id: string, o: Record<string, unknown> = {}) => ({
  id, user_id: `u-${id}`, org_id: 'org-1', checkin_at: iso('2026-10-07T03:30:00Z'), // 09:00 IST yesterday
  status: 'checked_in', break_minutes: 0, notes: null, ...o,
});

/** attendance: the open-shift select (has lt/gte), the conditional update, and the "still open" recheck. */
function seedAttendance(open: Array<Record<string, any>>, opts: { updated?: unknown[]; stillOpen?: Array<{ user_id: string }> } = {}) {
  supa().setDefault('attendance', (chain: any) => {
    if (has(chain, 'update')) return { data: opts.updated ?? [{ id: 'x' }] };
    if (chain.ops.some((o: any) => o.method === 'lt' || o.method === 'gte')) return { data: open };
    return { data: opts.stillOpen ?? [] };
  });
}

beforeEach(() => { supa().reset(); });

describe('IST day boundaries', () => {
  it('a shift is closed at the midnight that ends the day it started on', () => {
    expect(new Date(istDayEndMs(Date.parse('2026-10-08T10:00:00Z'))).toISOString()).toBe('2026-10-08T18:30:00.000Z');
    expect(new Date(istDayEndMs(Date.parse('2026-10-08T18:29:00Z'))).toISOString()).toBe('2026-10-08T18:30:00.000Z'); // 23:59 IST
    expect(new Date(istDayEndMs(Date.parse('2026-10-08T18:30:00Z'))).toISOString()).toBe('2026-10-09T18:30:00.000Z'); // 00:00 IST is the NEXT day
    expect(new Date(istDayStartMs(NOW)).toISOString()).toBe(TODAY_START);
  });

  it('worked minutes are elapsed minus breaks and never negative', () => {
    expect(workedMinutes(0, 600 * 60_000, 45)).toBe(555);
    expect(workedMinutes(0, 30 * 60_000, 90)).toBe(0);
  });
});

describe('auto-checkout at 12:00 AM IST', () => {
  it('closes a shift left open from yesterday at yesterday\'s midnight, with its hours', async () => {
    seedAttendance([shift('a')]); // 09:00 IST yesterday -> 15 h to midnight
    const r = await autoCheckoutOverdue(NOW);
    expect(r).toMatchObject({ found: 1, closed: 1, skipped_opt_out: 0 });
    const [{ patch }] = updatesOf('attendance');
    expect(patch).toMatchObject({
      status: 'checked_out', checkout_at: iso('2026-10-07T18:30:00Z'), working_minutes: 900, total_hours: 15,
      notes: AUTO_CHECKOUT_NOTE,
    });
  });

  it('only looks at open shifts that started before today (IST) and writes conditionally', async () => {
    seedAttendance([shift('a')]);
    await autoCheckoutOverdue(NOW);
    const sel = supa().chainsFor('attendance')[0];
    expect(has(sel, 'in', 'status', ['checked_in', 'on_break'])).toBe(true);
    expect(has(sel, 'is', 'checkout_at', null)).toBe(true);
    expect(has(sel, 'lt', 'checkin_at', TODAY_START)).toBe(true);
    const upd = updatesOf('attendance')[0].chain;
    expect(has(upd, 'is', 'checkout_at', null)).toBe(true);          // never overwrite a real check-out
    expect(has(upd, 'in', 'status', ['checked_in', 'on_break'])).toBe(true);
  });

  it('keeps an existing note and subtracts logged break time', async () => {
    seedAttendance([shift('a', { break_minutes: 60, notes: 'Client visit' })]);
    await autoCheckoutOverdue(NOW);
    expect(updatesOf('attendance')[0].patch).toMatchObject({ working_minutes: 840, total_hours: 14, notes: `Client visit · ${AUTO_CHECKOUT_NOTE}` });
  });

  it('a shift closed mid-break also ends the break and counts it', async () => {
    seedAttendance([shift('a', { status: 'on_break' })]);
    supa().setDefault('breaks', { data: [{ id: 'b1', attendance_id: 'a', started_at: iso('2026-10-07T16:30:00Z') }] }); // 22:00 IST, 2 h before midnight
    await autoCheckoutOverdue(NOW);
    expect(updatesOf('attendance')[0].patch).toMatchObject({ break_minutes: 120, working_minutes: 780 });
    const brk = updatesOf('breaks');
    expect(brk).toHaveLength(1);
    expect(brk[0].patch).toEqual({ ended_at: iso('2026-10-07T18:30:00Z') });
  });

  it('closes a backlog at the midnight of the day each shift started, not at "now"', async () => {
    seedAttendance([shift('old', { checkin_at: iso('2026-07-31T07:46:00Z') })]); // 13:16 IST on 31 Jul
    await autoCheckoutOverdue(NOW);
    expect(updatesOf('attendance')[0].patch.checkout_at).toBe(iso('2026-07-31T18:30:00Z'));
  });

  it('leaves orgs that opted out alone', async () => {
    seedAttendance([shift('a'), shift('b', { org_id: 'org-night' })]);
    supa().setDefault('org_settings', { data: [{ org_id: 'org-night', value: false }] });
    const r = await autoCheckoutOverdue(NOW);
    expect(r).toMatchObject({ found: 2, closed: 1, skipped_opt_out: 1 });
    expect(updatesOf('attendance')).toHaveLength(1);
    const q = supa().chainsFor('org_settings')[0];
    expect(q.eqs.key).toBe(AUTO_CHECKOUT_SETTING);
  });

  it('does not count a shift that a real check-out beat us to', async () => {
    seedAttendance([shift('a')], { updated: [] }); // conditional update matched nothing
    const r = await autoCheckoutOverdue(NOW);
    expect(r.closed).toBe(0);
    expect(updatesOf('users')).toHaveLength(0);
  });

  it('takes the rep off the live map only when they have no other open shift', async () => {
    seedAttendance([shift('a', { user_id: 'gone' }), shift('b', { user_id: 'working' })], { stillOpen: [{ user_id: 'working' }] });
    await autoCheckoutOverdue(NOW);
    const users = updatesOf('users');
    expect(users).toHaveLength(1);
    expect(users[0].patch).toEqual({ last_latitude: null, last_longitude: null });
    expect(users[0].chain.ops.find((o: any) => o.method === 'in').args).toEqual(['id', ['gone']]);
  });

  it('does nothing when no shift is overdue', async () => {
    seedAttendance([]);
    expect(await autoCheckoutOverdue(NOW)).toEqual({ found: 0, closed: 0, skipped_opt_out: 0 });
    expect(updatesOf('attendance')).toHaveLength(0);
  });
});

describe('10-hour check-out reminder', () => {
  // 22:30Z yesterday = 04:00 IST today: 11.5 h before NOW, so past the 10 h mark.
  const eleven = iso('2026-10-07T22:30:00Z');
  function seedReminders(rows: Array<Record<string, any>>, o: { active?: string[]; prior?: Array<Record<string, unknown>>; settings?: Array<Record<string, unknown>> } = {}) {
    supa().setDefault('attendance', { data: rows });
    supa().setDefault('users', { data: (o.active ?? rows.map((r) => r.user_id)).map((id) => ({ id })) });
    supa().setDefault('org_settings', (chain: any) => ({ data: (o.settings ?? []).filter((s) => s.key === chain.eqs.key) }));
    supa().setDefault('notifications', (chain: any) => (has(chain, 'insert') ? { data: [] } : { data: o.prior ?? [] }));
  }
  const row = (id: string, x: Record<string, unknown> = {}) => ({ id, user_id: `u-${id}`, org_id: 'org-1', checkin_at: eleven, ...x });

  it('reminds a rep still checked in after 10 hours, with a deep link to the shift', async () => {
    seedReminders([row('a')]);
    const r = await sendCheckoutReminders(NOW);
    expect(r).toEqual({ candidates: 1, reminded: 1 });
    const [n] = insertsOf('notifications');
    expect(n).toMatchObject({ org_id: 'org-1', user_id: 'u-a', title: "Don't forget to check out", type: 'general', sent_at: null, is_read: false });
    expect(n.data).toMatchObject({ kind: CHECKOUT_REMINDER_KIND, attendance_id: 'a', checkin_at: eleven });
    expect(n.body).toMatch(/automatically at 12:00 AM/);
  });

  it('only selects open shifts that started between 10 h and 36 h ago', async () => {
    seedReminders([]);
    await sendCheckoutReminders(NOW);
    const q = supa().chainsFor('attendance')[0];
    expect(has(q, 'is', 'checkout_at', null)).toBe(true);
    expect(has(q, 'in', 'status', ['checked_in', 'on_break'])).toBe(true);
    expect(has(q, 'lte', 'checkin_at', new Date(NOW - 10 * 3_600_000).toISOString())).toBe(true);
    expect(has(q, 'gte', 'checkin_at', new Date(NOW - 36 * 3_600_000).toISOString())).toBe(true);
  });

  it('never reminds twice for the same shift', async () => {
    seedReminders([row('a')], { prior: [{ data: { attendance_id: 'a' } }] });
    expect((await sendCheckoutReminders(NOW)).reminded).toBe(0);
    expect(insertsOf('notifications')).toHaveLength(0);
  });

  it('skips inactive users and orgs that turned reminders off', async () => {
    seedReminders([row('a'), row('b', { org_id: 'org-quiet' }), row('c')], {
      active: ['u-a', 'u-b'], // u-c is deactivated
      settings: [{ key: CHECKOUT_REMINDER_SETTING, org_id: 'org-quiet', value: false }],
    });
    const r = await sendCheckoutReminders(NOW);
    expect(r.reminded).toBe(1);
    expect(insertsOf('notifications').map((n: any) => n.user_id)).toEqual(['u-a']);
  });

  it('does not promise an auto-checkout to an org that opted out of it', async () => {
    seedReminders([row('a')], { settings: [{ key: AUTO_CHECKOUT_SETTING, org_id: 'org-1', value: false }] });
    await sendCheckoutReminders(NOW);
    const [n] = insertsOf('notifications');
    expect(n.body).not.toMatch(/automatically/);
  });

  it('does nothing when nobody has been on shift that long', async () => {
    seedReminders([]);
    expect(await sendCheckoutReminders(NOW)).toEqual({ candidates: 0, reminded: 0 });
    expect(supa().chainsFor('users')).toHaveLength(0);
  });
});

describe('runAttendanceSweep', () => {
  it('runs both steps, auto-checkout first', async () => {
    seedAttendance([]);
    const r = await runAttendanceSweep({ now: NOW });
    expect(r.auto_checkout.found).toBe(0);
    expect(r.reminders.candidates).toBe(0);
    const order = supa().chainsFor('attendance').map((c: any) => (has(c, 'lt', 'checkin_at', TODAY_START) ? 'close' : 'remind'));
    expect(order).toEqual(['close', 'remind']);
  });

  it('a failure in one step never stops the other', async () => {
    supa().setDefault('attendance', (chain: any) => (has(chain, 'lt')
      ? { data: null, error: { message: 'boom' } }
      : { data: [{ id: 'a', user_id: 'u-a', org_id: 'org-1', checkin_at: iso('2026-10-07T22:30:00Z') }] }));
    supa().setDefault('users', { data: [{ id: 'u-a' }] });
    const r = await runAttendanceSweep({ now: NOW });
    expect(r.auto_checkout.closed).toBe(0);
    expect(r.reminders.reminded).toBe(1);
  });
});
