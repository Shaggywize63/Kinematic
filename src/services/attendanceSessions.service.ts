// Multiple check-in / check-out per day.
//
// The daily public.attendance row stays the single source of truth that every
// hours / analytics / travel reader already consumes (first check-in, last
// check-out, rolled-up working_minutes, current status). On top of it we record
// one attendance_sessions row per punch pair, so a rep can check out and check in
// again any number of times in a day. The partial unique index
// `uq_att_sessions_open (user_id, date) WHERE status='open'` guarantees at most
// one open session per rep per day.
//
// Every write here is best-effort: the attendance row is written first and is
// authoritative, so a session write that loses the open-session race (a parallel
// check-in) or hits a transient error must never fail the rep's punch.
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';

/** The location/selfie payload a punch carries (same fields on both ends). */
export interface SessionPunch {
  latitude?: number | null;
  longitude?: number | null;
  selfie_url?: string | null;
  distance_m?: number | null;
  is_mock?: boolean;
  accuracy_m?: number | null;
  transport_mode?: string;
  address?: string | null;
}

/** Next 1-based punch number for the rep's day. */
export async function nextSessionSeq(userId: string, date: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('attendance_sessions')
    .select('seq')
    .eq('user_id', userId)
    .eq('date', date)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.seq as number | null) ?? 0) + 1;
}

/** Open a new check-in session for the day. Never throws. */
export async function openCheckinSession(params: {
  attendanceId: string;
  userId: string;
  orgId: string;
  clientId: string | null;
  date: string;
  checkinAt: string;
  punch: SessionPunch;
}): Promise<void> {
  try {
    const seq = await nextSessionSeq(params.userId, params.date);
    const row: Record<string, unknown> = {
      attendance_id: params.attendanceId,
      user_id: params.userId,
      org_id: params.orgId,
      client_id: params.clientId,
      date: params.date,
      seq,
      status: 'open',
      checkin_at: params.checkinAt,
      checkin_lat: params.punch.latitude,
      checkin_lng: params.punch.longitude,
      checkin_selfie_url: params.punch.selfie_url,
      checkin_distance_m: params.punch.distance_m,
      ...(params.punch.address != null && { checkin_address: params.punch.address }),
      ...(params.punch.is_mock !== undefined && { checkin_is_mock: params.punch.is_mock }),
      ...(params.punch.accuracy_m !== undefined && { checkin_accuracy_m: params.punch.accuracy_m }),
      ...(params.punch.transport_mode !== undefined && { transport_mode: params.punch.transport_mode }),
    };
    const { error } = await supabaseAdmin.from('attendance_sessions').insert(row);
    if (error) {
      logger.warn(`[AttendanceSessions] open session failed for user=${params.userId} ${params.date}: ${error.message}`);
    }
  } catch (err: any) {
    logger.warn(`[AttendanceSessions] open session threw for user=${params.userId} ${params.date}: ${err?.message || err}`);
  }
}

/** Close the rep's currently-open session (if any), stamping the checkout punch.
 *  Returns whether a session was closed and that session's worked minutes (gross
 *  of breaks — the daily row subtracts break_minutes once, for the whole day). */
export async function closeOpenSession(params: {
  userId: string;
  date: string;
  checkoutAt: string;
  punch: SessionPunch;
}): Promise<{ closed: boolean; minutes: number }> {
  try {
    const { data: open, error: findErr } = await supabaseAdmin
      .from('attendance_sessions')
      .select('id, checkin_at')
      .eq('user_id', params.userId)
      .eq('date', params.date)
      .eq('status', 'open')
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (findErr) {
      logger.warn(`[AttendanceSessions] open-session lookup failed for user=${params.userId} ${params.date}: ${findErr.message}`);
      return { closed: false, minutes: 0 };
    }
    if (!open) return { closed: false, minutes: 0 };

    const minutes = open.checkin_at
      ? Math.max(0, Math.round((Date.parse(params.checkoutAt) - Date.parse(open.checkin_at as string)) / 60_000))
      : 0;
    const { data: done, error: upErr } = await supabaseAdmin
      .from('attendance_sessions')
      .update({
        status: 'closed',
        checkout_at: params.checkoutAt,
        checkout_lat: params.punch.latitude,
        checkout_lng: params.punch.longitude,
        checkout_selfie_url: params.punch.selfie_url,
        working_minutes: minutes,
        ...(params.punch.is_mock !== undefined && { checkout_is_mock: params.punch.is_mock }),
        ...(params.punch.accuracy_m !== undefined && { checkout_accuracy_m: params.punch.accuracy_m }),
      })
      .eq('id', open.id)
      .eq('status', 'open') // lost-race guard: a parallel checkout already closed it
      .select('id');
    if (upErr) {
      logger.warn(`[AttendanceSessions] close session ${open.id} failed: ${upErr.message}`);
      return { closed: false, minutes: 0 };
    }
    if (!done || done.length === 0) return { closed: false, minutes: 0 };
    return { closed: true, minutes };
  } catch (err: any) {
    logger.warn(`[AttendanceSessions] close session threw for user=${params.userId} ${params.date}: ${err?.message || err}`);
    return { closed: false, minutes: 0 };
  }
}

/** The day's worked-minutes rollup and how many session rows exist. `count` lets the
 *  caller distinguish a sessions-tracked day (use `sum`, which excludes the gaps
 *  between punches) from a legacy day with no session rows (fall back to the single
 *  check-in → check-out span). */
export async function dayMinutes(userId: string, date: string): Promise<{ sum: number; count: number }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('attendance_sessions')
      .select('working_minutes, status')
      .eq('user_id', userId)
      .eq('date', date);
    if (error) {
      logger.warn(`[AttendanceSessions] day-minutes lookup failed for user=${userId} ${date}: ${error.message}`);
      return { sum: 0, count: 0 };
    }
    const rows = (data ?? []) as Array<{ working_minutes: number | null; status: string }>;
    const sum = rows.reduce((a, r) => a + (r.status === 'closed' ? (r.working_minutes || 0) : 0), 0);
    return { sum, count: rows.length };
  } catch (err: any) {
    logger.warn(`[AttendanceSessions] day-minutes threw for user=${userId} ${date}: ${err?.message || err}`);
    return { sum: 0, count: 0 };
  }
}

/** Attach the day's punch list (ascending by seq) to an attendance record so the
 *  apps can render each check-in/out. Additive — readers that ignore it are fine. */
export async function attachSessions(record: any, userId: string): Promise<void> {
  if (!record?.date) return;
  try {
    const { data } = await supabaseAdmin
      .from('attendance_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('date', record.date)
      .order('seq', { ascending: true });
    record.sessions = data ?? [];
  } catch {
    record.sessions = [];
  }
}
