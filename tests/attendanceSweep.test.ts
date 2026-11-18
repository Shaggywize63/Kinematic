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
  autoCheckoutOverdue, sendCheckoutReminders, sendScheduledCheckoutReminders, sendCheckinReminders, runAttendanceSweep,
  istDayStartMs, istDayEndMs, istMinuteOfDay, workedMinutes, scheduledReminderMinute,
  CHECKOUT_REMINDER_KIND, CHECKIN_REMINDER_KIND, AUTO_CHECKOUT_NOTE, AUTO_CHECKOUT_SETTING, CHECKOUT_REMINDER_SETTING,
  SCHEDULED_CHECKOUT_REMINDER_SETTING,
} from '../src/services/attendanceSweep.service';
import { istDateOf, weekdayOf } from '../src/services/attendanceRules.service';

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

  it('suppresses the 10 h reminder for a client that uses a fixed-time one', async () => {
    seedReminders([row('a', { client_id: 'c-fixed' }), row('b', { client_id: 'c-other' })]);
    supa().setDefault('clients', { data: [{ id: 'c-fixed', org_id: 'org-1', settings: { [SCHEDULED_CHECKOUT_REMINDER_SETTING]: '18:30' } }] });
    const r = await sendCheckoutReminders(NOW);
    expect(r.reminded).toBe(1);
    expect(insertsOf('notifications').map((n: any) => n.user_id)).toEqual(['u-b']);
  });
});

describe('fixed-time (6:30 PM) check-out reminder', () => {
  const NOW_E = Date.parse('2026-10-08T13:10:00Z');   // 18:40 IST — past 18:30
  const DAY_START = iso('2026-10-07T18:30:00Z');       // 00:00 IST of that day
  const morning = iso('2026-10-08T03:30:00Z');         // 09:00 IST
  const evening = iso('2026-10-08T13:05:00Z');         // 18:35 IST — after the reminder time
  const crow = (id: string, x: Record<string, unknown> = {}) =>
    ({ id, user_id: `u-${id}`, org_id: 'org-1', client_id: 'c-efocus', checkin_at: morning, ...x });

  function seed(att: Array<Record<string, any>>, o: { settings?: unknown; active?: string[]; prior?: Array<Record<string, unknown>> } = {}) {
    supa().setDefault('clients', { data: [{ id: 'c-efocus', org_id: 'org-1', settings: { [SCHEDULED_CHECKOUT_REMINDER_SETTING]: o.settings ?? '18:30' } }] });
    supa().setDefault('attendance', { data: att });
    supa().setDefault('users', { data: (o.active ?? att.map((r) => r.user_id)).map((id) => ({ id })) });
    supa().setDefault('notifications', (chain: any) => (has(chain, 'insert') ? { data: [] } : { data: o.prior ?? [] }));
  }

  it('istMinuteOfDay is the IST minute-of-day', () => {
    expect(istMinuteOfDay(NOW_E)).toBe(18 * 60 + 40);
    expect(istMinuteOfDay(NOW)).toBe(15 * 60 + 30);
  });

  it('reminds a rep on an open shift once the time has passed, scoped to the opted-in client', async () => {
    seed([crow('a')]);
    const r = await sendScheduledCheckoutReminders(NOW_E);
    expect(r).toEqual({ candidates: 1, reminded: 1 });
    const [n] = insertsOf('notifications');
    expect(n).toMatchObject({ org_id: 'org-1', user_id: 'u-a', title: 'Time to check out', type: 'general', sent_at: null });
    expect(n.data).toMatchObject({ kind: CHECKOUT_REMINDER_KIND, attendance_id: 'a', scheduled: true });
    expect(n.body).toMatch(/6:30 PM/);
    // today's open shifts, scoped to the opted-in client
    const q = supa().chainsFor('attendance')[0];
    expect(has(q, 'is', 'checkout_at', null)).toBe(true);
    expect(has(q, 'gte', 'checkin_at', DAY_START)).toBe(true);
    expect(has(q, 'in', 'client_id', ['c-efocus'])).toBe(true);
  });

  it('does not fire before the configured time (no attendance query)', async () => {
    seed([crow('a')]);
    expect(await sendScheduledCheckoutReminders(NOW)).toEqual({ candidates: 0, reminded: 0 });
    expect(supa().chainsFor('attendance')).toHaveLength(0);
    expect(insertsOf('notifications')).toHaveLength(0);
  });

  it('excludes a rep who checked in after the reminder time', async () => {
    seed([crow('a', { checkin_at: evening })]);
    expect(await sendScheduledCheckoutReminders(NOW_E)).toEqual({ candidates: 0, reminded: 0 });
  });

  it('never reminds the same shift twice in a day', async () => {
    seed([crow('a')], { prior: [{ data: { attendance_id: 'a' } }] });
    expect((await sendScheduledCheckoutReminders(NOW_E)).reminded).toBe(0);
    expect(insertsOf('notifications')).toHaveLength(0);
  });

  it('does nothing when no client opted in', async () => {
    supa().setDefault('attendance', { data: [crow('a')] });
    expect(await sendScheduledCheckoutReminders(NOW_E)).toEqual({ candidates: 0, reminded: 0 });
    expect(supa().chainsFor('attendance')).toHaveLength(0);   // short-circuits on the clients lookup
  });

  it('reads the time from HH:MM, true (⇒ default) and { enabled, time }, and treats off as off', () => {
    const k = SCHEDULED_CHECKOUT_REMINDER_SETTING;
    expect(scheduledReminderMinute({ [k]: '18:30' })).toBe(1110);
    expect(scheduledReminderMinute({ [k]: '07:05' })).toBe(425);
    expect(scheduledReminderMinute({ [k]: true })).toBe(1110);
    expect(scheduledReminderMinute({ [k]: { enabled: true } })).toBe(1110);
    expect(scheduledReminderMinute({ [k]: { time: '20:00' } })).toBe(1200);
    expect(scheduledReminderMinute({ [k]: false })).toBeNull();
    expect(scheduledReminderMinute({ [k]: { enabled: false, time: '18:30' } })).toBeNull();
    expect(scheduledReminderMinute({ [k]: 'nope' })).toBeNull();
    expect(scheduledReminderMinute({})).toBeNull();
  });
});

describe('check-in reminder (shift-configured clients)', () => {
  // 05:00Z = 10:30 IST on 2026-10-08. Shift 09:30 + 15 min grace -> deadline 09:45 IST (minute 585),
  // window open through 13:45 IST (minute 825).
  const NOW_IN = Date.parse('2026-10-08T05:00:00Z');
  const TODAY = istDateOf(NOW_IN) as string;
  const BEFORE_DEADLINE = Date.parse('2026-10-08T03:00:00Z');  // 08:30 IST
  const AFTER_WINDOW = Date.parse('2026-10-08T09:00:00Z');     // 14:30 IST

  const client = (id: string, rules: Record<string, unknown> = {}) =>
    ({ id, org_id: 'org-1', settings: { attendance_rules: { shift_start: '09:30', grace_minutes: 15, weekly_off: [], ...rules } } });
  const user = (id: string, x: Record<string, unknown> = {}) => ({ id: `u-${id}`, org_id: 'org-1', client_id: 'c-1', created_at: '2020-01-01T00:00:00Z', ...x });

  function seed(users: Array<Record<string, any>>, o: {
    clients?: Array<Record<string, any>>; attendance?: Array<Record<string, any>>; leaves?: Array<Record<string, any>>; prior?: Array<Record<string, unknown>>;
  } = {}) {
    supa().setDefault('clients', { data: o.clients ?? [client('c-1')] });
    supa().setDefault('users', { data: users });
    supa().setDefault('attendance', { data: o.attendance ?? [] });
    supa().setDefault('leave_requests', { data: o.leaves ?? [] });
    supa().setDefault('notifications', (chain: any) => (has(chain, 'insert') ? { data: [] } : { data: o.prior ?? [] }));
  }

  it('reminds a field rep with no check-in once the deadline has passed', async () => {
    seed([user('a')]);
    const r = await sendCheckinReminders(NOW_IN);
    expect(r).toEqual({ candidates: 1, reminded: 1 });
    const [n] = insertsOf('notifications');
    expect(n).toMatchObject({ org_id: 'org-1', user_id: 'u-a', title: "Don't forget to check in", type: 'general', sent_at: null, is_read: false });
    expect(n.data).toMatchObject({ kind: CHECKIN_REMINDER_KIND, date: TODAY });
    expect(n.body).toMatch(/9:30 AM/);   // the label is the shift start, not the grace-inclusive deadline
  });

  it('the roster query scopes to field roles, active users, the due clients', async () => {
    seed([user('a')]);
    await sendCheckinReminders(NOW_IN);
    const q = supa().chainsFor('users')[0];
    expect(has(q, 'in', 'client_id', ['c-1'])).toBe(true);
    expect(has(q, 'in', 'role', ['executive', 'field_executive'])).toBe(true);
    expect(has(q, 'eq', 'is_active', true)).toBe(true);
    expect(has(q, 'is', 'deleted_at', null)).toBe(true);
  });

  it('does nothing when no client has shift rules configured (no roster query)', async () => {
    seed([user('a')], { clients: [] });
    expect(await sendCheckinReminders(NOW_IN)).toEqual({ candidates: 0, reminded: 0 });
    expect(supa().chainsFor('users')).toHaveLength(0);
  });

  it('does nothing before the deadline', async () => {
    seed([user('a')]);
    expect(await sendCheckinReminders(BEFORE_DEADLINE)).toEqual({ candidates: 0, reminded: 0 });
    expect(supa().chainsFor('users')).toHaveLength(0);
  });

  it('does nothing once the reminder window has closed', async () => {
    seed([user('a')]);
    expect(await sendCheckinReminders(AFTER_WINDOW)).toEqual({ candidates: 0, reminded: 0 });
    expect(supa().chainsFor('users')).toHaveLength(0);
  });

  it('skips a client\'s weekly-off day', async () => {
    seed([user('a')], { clients: [client('c-1', { weekly_off: [weekdayOf(TODAY)] })] });
    expect(await sendCheckinReminders(NOW_IN)).toEqual({ candidates: 0, reminded: 0 });
  });

  it('excludes a rep who already checked in today', async () => {
    seed([user('a'), user('b')], { attendance: [{ user_id: 'u-a', checkin_at: '2026-10-08T03:45:00Z' }] });
    const r = await sendCheckinReminders(NOW_IN);
    expect(r).toEqual({ candidates: 2, reminded: 1 });
    expect(insertsOf('notifications').map((n: any) => n.user_id)).toEqual(['u-b']);
  });

  it('excludes a rep on approved leave today', async () => {
    seed([user('a'), user('b')], { leaves: [{ user_id: 'u-a' }] });
    const r = await sendCheckinReminders(NOW_IN);
    expect(r.reminded).toBe(1);
    expect(insertsOf('notifications').map((n: any) => n.user_id)).toEqual(['u-b']);
  });

  it('never reminds the same rep twice in a day', async () => {
    seed([user('a')], { prior: [{ user_id: 'u-a' }] });
    expect((await sendCheckinReminders(NOW_IN)).reminded).toBe(0);
    expect(insertsOf('notifications')).toHaveLength(0);
  });

  it('a user who joined after today is not a candidate', async () => {
    seed([user('a'), user('b', { created_at: '2099-01-01T00:00:00Z' })]);
    const r = await sendCheckinReminders(NOW_IN);
    expect(r.candidates).toBe(1);
    expect(insertsOf('notifications').map((n: any) => n.user_id)).toEqual(['u-a']);
  });

  it('does nothing when there is no roster', async () => {
    seed([]);
    expect(await sendCheckinReminders(NOW_IN)).toEqual({ candidates: 0, reminded: 0 });
    expect(supa().chainsFor('attendance')).toHaveLength(0);
  });
});

describe('runAttendanceSweep', () => {
  it('runs every step, auto-checkout first', async () => {
    seedAttendance([]);
    const r = await runAttendanceSweep({ now: NOW });
    expect(r.auto_checkout.found).toBe(0);
    expect(r.reminders.candidates).toBe(0);
    expect(r.checkin_reminders).toEqual({ candidates: 0, reminded: 0 }); // no client has shift rules configured here
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
