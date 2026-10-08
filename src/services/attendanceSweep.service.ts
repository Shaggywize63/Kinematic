/**
 * Attendance sweep — closes the loop on reps who forget to check out.
 *
 *  1. Reminder. Ten hours after check-in, a rep who is still checked in gets a push + bell notice
 *     ("don't forget to check out").
 *  2. Auto-checkout. A shift that is still open when its IST day ends is closed at 12:00 AM IST, so the
 *     register never carries an open shift into the next day (a shift forgotten in July was still "Shift
 *     Active" on a rep's phone in October).
 *
 * Applies to every tenant project and every client — the caller fans this out per project. No schema
 * change: the close uses existing attendance columns, the reminder reuses the notifications table (as its
 * own dedup ledger, keyed on data.kind + attendance_id) and is delivered by the dispatch-pushes loop.
 *
 * Deliberately conservative:
 *   - the close is a conditional update (still open at write time), so a real check-out that lands
 *     between the read and the write is never overwritten, and overlapping ticks are harmless;
 *   - a shift is closed at the midnight that ends the day it STARTED on, so a backlog is closed at a
 *     sensible time (never "now"), and a shift never shows more than 24 h;
 *   - an org can opt out per feature with org_settings `attendance_auto_checkout` /
 *     `attendance_checkout_reminder` = false (e.g. a client with genuine overnight shifts).
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { notify } from './notify';

export const CHECKOUT_REMINDER_KIND = 'checkout_reminder';
export const AUTO_CHECKOUT_SETTING = 'attendance_auto_checkout';
export const CHECKOUT_REMINDER_SETTING = 'attendance_checkout_reminder';
export const AUTO_CHECKOUT_NOTE = 'Auto checked out at 12:00 AM (no check-out was recorded)';

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
    .select('id, user_id, org_id, checkin_at')
    .in('status', OPEN_STATUSES)
    .is('checkout_at', null)
    .not('checkin_at', 'is', null)
    .gte('checkin_at', new Date(now - REMINDER_LOOKBACK_MS).toISOString())
    .lte('checkin_at', new Date(now - REMINDER_AFTER_MS).toISOString())
    .order('checkin_at', { ascending: true })
    .limit(MAX_REMIND_PER_RUN);
  if (error) { logger.warn(`[attendance-sweep] reminder query failed: ${error.message}`); return result; }
  const rows = (data ?? []) as Array<{ id: string; user_id: string; org_id: string; checkin_at: string }>;
  result.candidates = rows.length;
  if (rows.length === 0) return result;

  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const orgIds = Array.from(new Set(rows.map((r) => r.org_id)));
  const [{ data: users }, noReminder, noAutoClose, { data: prior }] = await Promise.all([
    supabaseAdmin.from('users').select('id').in('id', userIds).eq('is_active', true).is('deleted_at', null),
    optedOutOrgs(orgIds, CHECKOUT_REMINDER_SETTING),
    optedOutOrgs(orgIds, AUTO_CHECKOUT_SETTING),
    supabaseAdmin.from('notifications').select('data').eq('data->>kind', CHECKOUT_REMINDER_KIND).in('user_id', userIds)
      .gte('created_at', new Date(now - REMINDER_LOOKBACK_MS - 3_600_000).toISOString()).limit(20000),
  ]);
  const active = new Set(((users ?? []) as Array<{ id: string }>).map((u) => u.id));
  const already = new Set(((prior ?? []) as Array<{ data?: { attendance_id?: string } }>).map((n) => n.data?.attendance_id).filter(Boolean) as string[]);

  for (const row of rows) {
    if (!active.has(row.user_id) || noReminder.has(row.org_id) || already.has(row.id)) continue;
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

export interface AttendanceSweepResult { auto_checkout: AutoCheckoutResult; reminders: ReminderResult }

/** One pass for the current project: close what is overdue first, then remind who is still reachable. */
export async function runAttendanceSweep(opts: { now?: number } = {}): Promise<AttendanceSweepResult> {
  const now = opts.now ?? Date.now();
  const empty = { found: 0, closed: 0, skipped_opt_out: 0 };
  let auto_checkout: AutoCheckoutResult = empty;
  let reminders: ReminderResult = { candidates: 0, reminded: 0 };
  try { auto_checkout = await autoCheckoutOverdue(now); }
  catch (e: any) { logger.warn(`[attendance-sweep] auto-checkout failed: ${e?.message ?? e}`); }
  try { reminders = await sendCheckoutReminders(now); }
  catch (e: any) { logger.warn(`[attendance-sweep] reminders failed: ${e?.message ?? e}`); }
  return { auto_checkout, reminders };
}
