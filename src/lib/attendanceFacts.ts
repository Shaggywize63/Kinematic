/**
 * The two footer facts on the dashboard's Attendance card: when the day's FIRST check-in happened, and how many people
 * checked in AFTER the shift-start cut-off. Pure (no clock, no DB) so the rule is unit-tested in tests/attendanceFacts.test.ts.
 *
 * The cut-off is a wall-clock time in India (IST, UTC+5:30), whatever timezone the server runs in. "After" is strict:
 * a check-in at exactly 10:00 is on time.
 */

/** Shift start: 10:00 am IST, in minutes after midnight. */
export const LATE_AFTER_MINUTES_IST = 10 * 60;

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

/** Minutes after midnight, IST, for an instant. */
export function istMinutesOfDay(ms: number): number {
  return Math.floor((((ms + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
}

export interface AttendanceFacts {
  /** ISO timestamp of the earliest check-in, or null when nobody has checked in. */
  first_check_in: string | null;
  /** Check-ins strictly after the cut-off. */
  late_checkins: number;
}

export function computeAttendanceFacts(
  rows: ReadonlyArray<{ checkin_at?: string | null }>,
  lateAfterMinutes: number = LATE_AFTER_MINUTES_IST,
): AttendanceFacts {
  let first = Infinity;
  let late = 0;
  for (const r of rows) {
    if (!r?.checkin_at) continue;
    const ms = Date.parse(r.checkin_at);
    if (!Number.isFinite(ms)) continue;                       // a malformed timestamp is ignored, never thrown on
    if (ms < first) first = ms;
    if (istMinutesOfDay(ms) > lateAfterMinutes) late++;
  }
  return { first_check_in: Number.isFinite(first) ? new Date(first).toISOString() : null, late_checkins: late };
}
