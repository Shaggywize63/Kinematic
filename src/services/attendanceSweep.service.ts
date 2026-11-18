/**
 * Attendance sweep — closes the loop on reps who forget to check out, and nudges reps who have not
 * checked in.
 *
 *  1. Check-out reminder. Ten hours after check-in, a rep who is still checked in gets a push + bell
 *     notice ("don't forget to check out"). A client may instead opt in (clients.settings) to a
 *     FIXED-TIME reminder at a clock time (default 6:30 PM IST); the 10 h one is then suppressed for that
 *     client so a rep gets exactly one nudge. See sendScheduledCheckoutReminders.
 *  2. Auto-checkout. A shift that is still open when its IST day ends is closed at 12:00 AM IST, so the
 *     register never carries an open shift into the next day (a shift forgotten in July was still "Shift
 *     Active" on a rep's phone in October).
 *  3. Check-in reminder. For a client with shift rules explicitly configured (Client Management →
 *     Attendance rules), once a working day's shift-start + grace period has passed, a field rep who has
 *     no check-in yet (and is not on approved leave) gets one nudge — see sendCheckinReminders. Clients
 *     with no shift rules configured have no deadline to remind against, so they get nothing here (same
 *     as today).
 *
 * Applies to every tenant project and every client — the caller fans this out per project. No schema
 * change: the close uses existing attendance columns, and every reminder reuses the notifications table
 * (as its own dedup ledger, keyed on data.kind + an id / the day) and is delivered by the dispatch-pushes
 * loop. Both reminder kinds are also gated by the ordinary Client Management → Notifications catalog
 * (`notify()` writes nothing for a client that has not switched the kind on) — nothing here bypasses it.
 *
 * Deliberately conservative:
 *   - the close is a conditional update (still open at write time), so a real check-out that lands
 *     between the read and the write is never overwritten, and overlapping ticks are harmless;
 *   - a shift is closed at the midnight that ends the day it STARTED on, so a backlog is closed at a
 *     sensible time (never "now"), and a shift never shows more than 24 h;
 *   - an org can opt out per feature with org_settings `attendance_auto_checkout` /
 *     `attendance_checkout_reminder` = false (e.g. a client with genuine overnight shifts);
 *   - the check-in reminder only fires inside a bounded window after the deadline (not all day), so a
 *     rep who checks in at 3 PM never gets a stale "you're late" nudge from the morning.
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { notify } from './notify';
import { resolveAttendanceRules, lateTrackingOn, parseHHMM, istDateOf, weekdayOf } from './attendanceRules.service';

export const CHECKOUT_REMINDER_KIND = 'checkout_reminder';
export const AUTO_CHECKOUT_SETTING = 'attendance_auto_checkout';
export const CHECKOUT_REMINDER_SETTING = 'attendance_checkout_reminder';
export const AUTO_CHECKOUT_NOTE = 'Auto checked out at 12:00 AM (no check-out was recorded)';

/**
 * Per-client opt-in to a FIXED-TIME checkout reminder (clients.settings jsonb). A client that sets this
 * gets a reminder at a clock time (default 6:30 PM IST) instead of the relative 10 h one. Value may be
 * "HH:MM" (24 h, IST), `true` (⇒ default), or `{ enabled, time }`. This is the eFocus 6:30 PM reminder.
 */
export const SCHEDULED_CHECKOUT_REMINDER_SETTING = 'attendance_checkout_reminder_time';
export const DEFAULT_SCHEDULED_REMINDER_TIME = '18:30';

export const REMINDER_AFTER_MS = 10 * 3_600_000;
/** A reminder is only for a shift that is still reachable: older ones are auto-closed (or opted out). */
const REMINDER_LOOKBACK_MS = 36 * 3_600_000;
const MAX_CLOSE_PER_RUN = 500;
const MAX_REMIND_PER_RUN = 500;

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const OPEN_STATUSES = ['checked_in', 'on_break'];

/** 12:00 AM IST at the start of the day containing `ms`. */
export function istDayStartMs(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** The 12:00 AM IST that ends the day containing `ms`. */
export function istDayEndMs(ms: number): number {
  return istDayStartMs(ms) + DAY_MS;
}

/** Minute-of-day (0..1439) in IST for an epoch-ms instant. */
export function istMinuteOfDay(ms: number): number {
  return Math.floor((((ms - istDayStartMs(ms)) % DAY_MS)) / 60_000);
}

/** "HH:MM" (24 h) → minute-of-day (0..1439), or null when not a valid time string. */
export function parseHhmm(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** "6:30 PM" from a minute-of-day. */
export function clockLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The configured fixed-time checkout-reminder minute-of-day (IST) for a client's `settings`, or null when
 * the client has not opted in / disabled it. Accepts "HH:MM", `true` (⇒ default), or `{ enabled, time }`.
 */
export function scheduledReminderMinute(settings: unknown): number | null {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)[SCHEDULED_CHECKOUT_REMINDER_SETTING]
    : undefined;
  if (s == null || s === false) return null;
  if (s === true) return parseHhmm(DEFAULT_SCHEDULED_REMINDER_TIME);
  if (typeof s === 'string') return parseHhmm(s);
  if (typeof s === 'object' && !Array.isArray(s)) {
    const o = s as Record<string, unknown>;
    if (o.enabled === false) return null;
    const t = parseHhmm(o.time ?? o.value);
    if (t != null) return t;
    if (o.enabled === true) return parseHhmm(DEFAULT_SCHEDULED_REMINDER_TIME);
  }
  return null;
}

interface ScheduledClient { id: string; org_id: string; minute: number }

/** Clients that have opted in to a fixed-time checkout reminder, with the minute-of-day (IST) each chose. */
async function scheduledReminderClients(): Promise<ScheduledClient[]> {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id, org_id, settings')
    .not(`settings->${SCHEDULED_CHECKOUT_REMINDER_SETTING}`, 'is', null);
  if (error) { logger.warn(`[attendance-sweep] scheduled-reminder client lookup failed: ${error.message}`); return []; }
  const out: ScheduledClient[] = [];
  for (const r of (data ?? []) as Array<{ id: string; org_id: string; settings: unknown }>) {
    const minute = scheduledReminderMinute(r.settings);
    if (minute != null) out.push({ id: r.id, org_id: r.org_id, minute });
  }
  return out;
}

/** Working time for a shift closed at `endMs`: elapsed minus breaks, never negative. */
export function workedMinutes(checkinMs: number, endMs: number, breakMinutes: number): number {
  return Math.max(0, Math.round((endMs - checkinMs) / 60_000) - breakMinutes);
}

const isOff = (v: unknown): boolean =>
  v === false || v === 'false' ||
  (!!v && typeof v === 'object' && ((v as any).enabled === false || (v as any).value === false));

/** Orgs that switched `key` off in org_settings. */
async function optedOutOrgs(orgIds: string[], key: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (orgIds.length === 0) return out;
  const { data, error } = await supabaseAdmin.from('org_settings').select('org_id, value').eq('key', key).in('org_id', orgIds);
  if (error) { logger.warn(`[attendance-sweep] ${key} lookup failed: ${error.message}`); return out; }
  for (const r of (data ?? []) as Array<{ org_id: string; value: unknown }>) if (isOff(r.value)) out.add(r.org_id);
  return out;
}

interface OpenShift { id: string; user_id: string; org_id: string; checkin_at: string; status: string; break_minutes: number | null; notes: string | null }

export interface AutoCheckoutResult { found: number; closed: number; skipped_opt_out: number }

/** Close every shift still open from a previous IST day, at the midnight that ended its day. */
export async function autoCheckoutOverdue(now: number = Date.now()): Promise<AutoCheckoutResult> {
  const result: AutoCheckoutResult = { found: 0, closed: 0, skipped_opt_out: 0 };
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('id, user_id, org_id, checkin_at, status, break_minutes, notes')
    .in('status', OPEN_STATUSES)
    .is('checkout_at', null)
    .not('checkin_at', 'is', null)
    .lt('checkin_at', new Date(istDayStartMs(now)).toISOString())
    .order('checkin_at', { ascending: true })
    .limit(MAX_CLOSE_PER_RUN);
  if (error) { logger.warn(`[attendance-sweep] open-shift query failed: ${error.message}`); return result; }
  const rows = (data ?? []) as OpenShift[];
  result.found = rows.length;
  if (rows.length === 0) return result;

  const optOut = await optedOutOrgs(Array.from(new Set(rows.map((r) => r.org_id))), AUTO_CHECKOUT_SETTING);
  const todo = rows.filter((r) => !optOut.has(r.org_id));
  result.skipped_opt_out = rows.length - todo.length;
  if (todo.length === 0) return result;

  // A shift closed mid-break also ends the break, at the same moment.
  const onBreak = todo.filter((r) => r.status === 'on_break').map((r) => r.id);
  const openBreaks = new Map<string, Array<{ id: string; started_at: string }>>();
  if (onBreak.length) {
    const { data: brk } = await supabaseAdmin.from('breaks').select('id, attendance_id, started_at').in('attendance_id', onBreak).is('ended_at', null);
    for (const b of (brk ?? []) as Array<{ id: string; attendance_id: string; started_at: string }>) {
      const list = openBreaks.get(b.attendance_id) ?? [];
      list.push({ id: b.id, started_at: b.started_at });
      openBreaks.set(b.attendance_id, list);
    }
  }

  const closedUsers = new Set<string>();
  for (const row of todo) {
    const checkinMs = Date.parse(row.checkin_at);
    const endMs = istDayEndMs(checkinMs);
    const endIso = new Date(endMs).toISOString();

    let breakMinutes = row.break_minutes ?? 0;
    const breaks = openBreaks.get(row.id) ?? [];
    for (const b of breaks) breakMinutes += Math.max(0, Math.round((endMs - Date.parse(b.started_at)) / 60_000));

    const working = workedMinutes(checkinMs, endMs, breakMinutes);
    const { data: done, error: upErr } = await supabaseAdmin
      .from('attendance')
      .update({
        status: 'checked_out',
        checkout_at: endIso,
        break_minutes: breakMinutes,
        working_minutes: working,
        total_hours: Number((working / 60).toFixed(2)),
        notes: [row.notes, AUTO_CHECKOUT_NOTE].filter(Boolean).join(' · '),
      })
      .eq('id', row.id)
      .is('checkout_at', null)              // still open: never overwrite a real check-out
      .in('status', OPEN_STATUSES)
      .select('id');
    if (upErr) { logger.warn(`[attendance-sweep] auto-checkout of ${row.id} failed: ${upErr.message}`); continue; }
    if (!done || (Array.isArray(done) && done.length === 0)) continue; // lost the race to a real check-out
    result.closed++;
    closedUsers.add(row.user_id);
    if (breaks.length) await supabaseAdmin.from('breaks').update({ ended_at: endIso }).in('id', breaks.map((b) => b.id));
    // Mirror the auto-checkout onto any still-open session for this shift. The daily
    // row above stays authoritative for every reader; this just keeps the per-punch
    // session list consistent (no session left 'open' on a closed day).
    await supabaseAdmin.from('attendance_sessions')
      .update({ status: 'closed', checkout_at: endIso })
      .eq('attendance_id', row.id).eq('status', 'open');
  }

  // Like a real check-out, take the rep off the live map — but only when they have no other open shift
  // (a backlog row from last week must not blank someone who is working today).
  if (closedUsers.size) {
    const ids = Array.from(closedUsers);
    const { data: stillOpen } = await supabaseAdmin.from('attendance').select('user_id').in('user_id', ids).in('status', OPEN_STATUSES).is('checkout_at', null);
    const working = new Set(((stillOpen ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    const clear = ids.filter((id) => !working.has(id));
    if (clear.length) await supabaseAdmin.from('users').update({ last_latitude: null, last_longitude: null }).in('id', clear);
  }

  if (result.closed) logger.info(`[attendance-sweep] auto-checked-out ${result.closed} open shift(s) at 12:00 AM IST`);
  return result;
}

export interface ReminderResult { candidates: number; reminded: number }

/** Remind reps who are still checked in ten hours after they started. Once per shift. */
export async function sendCheckoutReminders(now: number = Date.now()): Promise<ReminderResult> {
  const result: ReminderResult = { candidates: 0, reminded: 0 };
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('id, user_id, org_id, client_id, checkin_at')
    .in('status', OPEN_STATUSES)
    .is('checkout_at', null)
    .not('checkin_at', 'is', null)
    .gte('checkin_at', new Date(now - REMINDER_LOOKBACK_MS).toISOString())
    .lte('checkin_at', new Date(now - REMINDER_AFTER_MS).toISOString())
    .order('checkin_at', { ascending: true })
    .limit(MAX_REMIND_PER_RUN);
  if (error) { logger.warn(`[attendance-sweep] reminder query failed: ${error.message}`); return result; }
  const rows = (data ?? []) as Array<{ id: string; user_id: string; org_id: string; client_id: string | null; checkin_at: string }>;
  result.candidates = rows.length;
  if (rows.length === 0) return result;

  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const orgIds = Array.from(new Set(rows.map((r) => r.org_id)));
  const [{ data: users }, noReminder, noAutoClose, { data: prior }, scheduled] = await Promise.all([
    supabaseAdmin.from('users').select('id').in('id', userIds).eq('is_active', true).is('deleted_at', null),
    optedOutOrgs(orgIds, CHECKOUT_REMINDER_SETTING),
    optedOutOrgs(orgIds, AUTO_CHECKOUT_SETTING),
    supabaseAdmin.from('notifications').select('data').eq('data->>kind', CHECKOUT_REMINDER_KIND).in('user_id', userIds)
      .gte('created_at', new Date(now - REMINDER_LOOKBACK_MS - 3_600_000).toISOString()).limit(20000),
    scheduledReminderClients(),
  ]);
  const active = new Set(((users ?? []) as Array<{ id: string }>).map((u) => u.id));
  const already = new Set(((prior ?? []) as Array<{ data?: { attendance_id?: string } }>).map((n) => n.data?.attendance_id).filter(Boolean) as string[]);
  // Clients that use a FIXED-TIME checkout reminder are reminded by that, not by this relative 10 h one.
  const fixedTimeClients = new Set(scheduled.map((c) => c.id));

  for (const row of rows) {
    if (!active.has(row.user_id) || noReminder.has(row.org_id) || already.has(row.id)) continue;
    if (row.client_id && fixedTimeClients.has(row.client_id)) continue;
    await notify({
      orgId: row.org_id,
      userId: row.user_id,
      kind: CHECKOUT_REMINDER_KIND,
      title: "Don't forget to check out",
      body: noAutoClose.has(row.org_id)
        ? "You've been checked in for over 10 hours. Please check out when your day is done."
        : "You've been checked in for over 10 hours. Please check out when your day is done — otherwise you'll be checked out automatically at 12:00 AM.",
      data: { attendance_id: row.id, checkin_at: row.checkin_at },
    });
    already.add(row.id);
    result.reminded++;
  }
  if (result.reminded) logger.info(`[attendance-sweep] sent ${result.reminded} check-out reminder(s)`);
  return result;
}

/**
 * Fixed-time checkout reminder. For each client that configured a time (clients.settings), once the IST
 * clock has reached it, remind every rep still on an open shift that STARTED before that time today — once
 * per shift per day. Opt-in per client; the 10 h reminder is suppressed for these clients so a rep gets
 * exactly one nudge, at the chosen time. This is the eFocus 6:30 PM reminder.
 *
 * It reuses the `checkout_reminder` kind (so the tap still deep-links to Attendance) and marks the row
 * `data.scheduled = true`. No upper time bound is needed: the "checked in before the target time" filter
 * keeps a rep who starts an evening shift out of it, and the per-shift dedup keeps it to one send even if
 * several ticks fall after the target time.
 */
export async function sendScheduledCheckoutReminders(now: number = Date.now()): Promise<ReminderResult> {
  const result: ReminderResult = { candidates: 0, reminded: 0 };
  const clients = await scheduledReminderClients();
  if (clients.length === 0) return result;

  const nowMin = istMinuteOfDay(now);
  const dayStartMs = istDayStartMs(now);
  const due = clients.filter((c) => nowMin >= c.minute);   // the reminder time has arrived today
  if (due.length === 0) return result;

  const byClient = new Map(due.map((c) => [c.id, c] as const));
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('id, user_id, org_id, client_id, checkin_at')
    .in('status', OPEN_STATUSES)
    .is('checkout_at', null)
    .not('checkin_at', 'is', null)
    .gte('checkin_at', new Date(dayStartMs).toISOString())
    .in('client_id', due.map((c) => c.id))
    .order('checkin_at', { ascending: true })
    .limit(MAX_REMIND_PER_RUN);
  if (error) { logger.warn(`[attendance-sweep] scheduled reminder query failed: ${error.message}`); return result; }
  const rows = ((data ?? []) as Array<{ id: string; user_id: string; org_id: string; client_id: string | null; checkin_at: string }>)
    .filter((r) => {                                        // only reps already on shift when the time passed
      const c = r.client_id ? byClient.get(r.client_id) : undefined;
      return !!c && Date.parse(r.checkin_at) <= dayStartMs + c.minute * 60_000;
    });
  result.candidates = rows.length;
  if (rows.length === 0) return result;

  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const [{ data: users }, { data: prior }] = await Promise.all([
    supabaseAdmin.from('users').select('id').in('id', userIds).eq('is_active', true).is('deleted_at', null),
    supabaseAdmin.from('notifications').select('data').eq('data->>kind', CHECKOUT_REMINDER_KIND).in('user_id', userIds)
      .gte('created_at', new Date(dayStartMs).toISOString()).limit(20000),
  ]);
  const active = new Set(((users ?? []) as Array<{ id: string }>).map((u) => u.id));
  const already = new Set(((prior ?? []) as Array<{ data?: { attendance_id?: string } }>).map((n) => n.data?.attendance_id).filter(Boolean) as string[]);

  for (const row of rows) {
    if (!active.has(row.user_id) || already.has(row.id)) continue;
    const c = byClient.get(row.client_id as string) as ScheduledClient;
    await notify({
      orgId: row.org_id,
      userId: row.user_id,
      kind: CHECKOUT_REMINDER_KIND,
      title: 'Time to check out',
      body: `It's ${clockLabel(c.minute)} — please remember to check out for the day.`,
      data: { attendance_id: row.id, checkin_at: row.checkin_at, scheduled: true },
    });
    already.add(row.id);
    result.reminded++;
  }
  if (result.reminded) logger.info(`[attendance-sweep] sent ${result.reminded} scheduled check-out reminder(s)`);
  return result;
}

// ── check-in reminder ───────────────────────────────────────────────────────

export const CHECKIN_REMINDER_KIND = 'checkin_reminder';
/** How long (minutes) after the shift-start deadline a rep may still get the one reminder for the day —
 *  bounded so a late afternoon check-in never earns a stale "you're late" nudge from the morning. */
export const CHECKIN_REMINDER_WINDOW_MINUTES = 240;
const MAX_CHECKIN_ROSTER_PER_RUN = 2000;

// Mirrors the FIELD_ROLES set in controllers/attendance.controller.ts (isFieldRep). Duplicated rather than
// imported so this sweep stays self-contained and side-effect-free to import (that file pulls in the full
// attendance controller surface); keep the two in step if field roles ever change.
const CHECKIN_FIELD_ROLES = ['executive', 'field_executive'];

interface ShiftClient { id: string; org_id: string; deadlineMinute: number; weeklyOff: number[]; shiftLabel: string }

/**
 * Clients with shift rules EXPLICITLY configured (Client Management → Attendance rules: at least one of
 * shift_start / shift_end / grace_minutes / weekly_off stored — see lateTrackingEnabled), each resolved to
 * the minute-of-day a check-in becomes late (shift_start + grace_minutes). A client that never configured
 * shift rules has no deadline to remind against and is skipped — same as today, nothing changes for it.
 */
async function shiftConfiguredClients(): Promise<ShiftClient[]> {
  const { data, error } = await supabaseAdmin.from('clients').select('id, org_id, settings').not('settings->attendance_rules', 'is', null);
  if (error) { logger.warn(`[attendance-sweep] shift-rule client lookup failed: ${error.message}`); return []; }
  const out: ShiftClient[] = [];
  for (const r of (data ?? []) as Array<{ id: string; org_id: string; settings: unknown }>) {
    const resolved = resolveAttendanceRules(r.settings);
    if (!lateTrackingOn(resolved)) continue;
    const start = parseHHMM(resolved.rules.shift_start);
    if (start === null) continue;
    out.push({ id: r.id, org_id: r.org_id, deadlineMinute: start + resolved.rules.grace_minutes, weeklyOff: resolved.rules.weekly_off, shiftLabel: clockLabel(start) });
  }
  return out;
}

/**
 * Remind a field rep who has not checked in once shift-start + grace has passed on a working day (once
 * per rep per day). Only for clients with shift rules configured (see shiftConfiguredClients) — a client
 * that has not set a shift start has no "late" to remind against.
 */
export async function sendCheckinReminders(now: number = Date.now()): Promise<ReminderResult> {
  const result: ReminderResult = { candidates: 0, reminded: 0 };
  const clients = await shiftConfiguredClients();
  if (clients.length === 0) return result;

  const todayYmd = istDateOf(now);
  if (!todayYmd) return result;
  const nowMinute = istMinuteOfDay(now);
  const weekday = weekdayOf(todayYmd);
  const due = clients.filter((c) => !c.weeklyOff.includes(weekday) && nowMinute >= c.deadlineMinute && nowMinute < c.deadlineMinute + CHECKIN_REMINDER_WINDOW_MINUTES);
  if (due.length === 0) return result;

  const byClient = new Map(due.map((c) => [c.id, c] as const));
  const { data: userRows, error } = await supabaseAdmin
    .from('users')
    .select('id, org_id, client_id, created_at')
    .in('client_id', due.map((c) => c.id))
    .in('role', CHECKIN_FIELD_ROLES)
    .eq('is_active', true)
    .is('deleted_at', null)
    .limit(MAX_CHECKIN_ROSTER_PER_RUN);
  if (error) { logger.warn(`[attendance-sweep] check-in reminder roster lookup failed: ${error.message}`); return result; }
  const rows = ((userRows ?? []) as Array<{ id: string; org_id: string; client_id: string | null; created_at: string | null }>)
    .filter((u) => !u.created_at || (istDateOf(u.created_at) ?? todayYmd) <= todayYmd);   // not before they joined
  result.candidates = rows.length;
  if (rows.length === 0) return result;

  const userIds = rows.map((u) => u.id);
  const dayStartIso = new Date(istDayStartMs(now)).toISOString();
  const [{ data: att }, { data: leaves }, { data: prior }] = await Promise.all([
    supabaseAdmin.from('attendance').select('user_id, checkin_at').eq('date', todayYmd).in('user_id', userIds),
    supabaseAdmin.from('leave_requests').select('user_id').eq('status', 'approved').lte('from_date', todayYmd).gte('to_date', todayYmd).in('user_id', userIds),
    supabaseAdmin.from('notifications').select('user_id').eq('data->>kind', CHECKIN_REMINDER_KIND).in('user_id', userIds).gte('created_at', dayStartIso),
  ]);
  const checkedIn = new Set(((att ?? []) as Array<{ user_id: string; checkin_at: string | null }>).filter((r) => r.checkin_at).map((r) => r.user_id));
  const onLeave = new Set(((leaves ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  const already = new Set(((prior ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));

  for (const u of rows) {
    if (checkedIn.has(u.id) || onLeave.has(u.id) || already.has(u.id)) continue;
    const c = u.client_id ? byClient.get(u.client_id) : undefined;
    if (!c) continue;
    await notify({
      orgId: u.org_id,
      userId: u.id,
      kind: CHECKIN_REMINDER_KIND,
      title: "Don't forget to check in",
      body: `It's past ${c.shiftLabel} — please check in to start your day.`,
      data: { date: todayYmd },
    });
    already.add(u.id);
    result.reminded++;
  }
  if (result.reminded) logger.info(`[attendance-sweep] sent ${result.reminded} check-in reminder(s)`);
  return result;
}

export interface AttendanceSweepResult { auto_checkout: AutoCheckoutResult; reminders: ReminderResult; scheduled_reminders: ReminderResult; checkin_reminders: ReminderResult }

/** One pass for the current project: close what is overdue first, then the fixed-time, 10 h and check-in reminders. */
export async function runAttendanceSweep(opts: { now?: number } = {}): Promise<AttendanceSweepResult> {
  const now = opts.now ?? Date.now();
  const empty = { found: 0, closed: 0, skipped_opt_out: 0 };
  let auto_checkout: AutoCheckoutResult = empty;
  let reminders: ReminderResult = { candidates: 0, reminded: 0 };
  let scheduled_reminders: ReminderResult = { candidates: 0, reminded: 0 };
  let checkin_reminders: ReminderResult = { candidates: 0, reminded: 0 };
  try { auto_checkout = await autoCheckoutOverdue(now); }
  catch (e: any) { logger.warn(`[attendance-sweep] auto-checkout failed: ${e?.message ?? e}`); }
  try { scheduled_reminders = await sendScheduledCheckoutReminders(now); }
  catch (e: any) { logger.warn(`[attendance-sweep] scheduled reminders failed: ${e?.message ?? e}`); }
  try { reminders = await sendCheckoutReminders(now); }
  catch (e: any) { logger.warn(`[attendance-sweep] reminders failed: ${e?.message ?? e}`); }
  try { checkin_reminders = await sendCheckinReminders(now); }
  catch (e: any) { logger.warn(`[attendance-sweep] check-in reminders failed: ${e?.message ?? e}`); }
  return { auto_checkout, reminders, scheduled_reminders, checkin_reminders };
}
