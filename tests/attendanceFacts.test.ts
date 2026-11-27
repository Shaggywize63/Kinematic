/**
 * computeAttendanceFacts — the rule behind the Attendance card's footer ("N checked in after 10:00 am", "First check-in 8:02 am").
 * The cut-off is IST wall-clock time, independent of the server's timezone.
 */
import { computeAttendanceFacts, istMinutesOfDay, LATE_AFTER_MINUTES_IST } from '../src/lib/attendanceFacts';

// An instant at h:m IST on 2026-11-27 (IST = UTC+5:30, so subtract 330 minutes from the UTC reading).
const ist = (h: number, m: number) => new Date(Date.UTC(2026, 10, 27, 0, 0) + (h * 60 + m - 330) * 60_000).toISOString();

describe('istMinutesOfDay', () => {
  it('converts a UTC instant to minutes after midnight IST', () => {
    expect(istMinutesOfDay(Date.parse(ist(8, 2)))).toBe(8 * 60 + 2);
    expect(istMinutesOfDay(Date.parse(ist(0, 0)))).toBe(0);
    expect(istMinutesOfDay(Date.parse(ist(23, 59)))).toBe(23 * 60 + 59);
  });
  it('is the same whatever the server timezone (it only uses epoch maths)', () => {
    const iso = ist(9, 30);
    expect(istMinutesOfDay(Date.parse(iso))).toBe(9 * 60 + 30);
  });
});

describe('computeAttendanceFacts', () => {
  it('finds the earliest check-in and counts those strictly after 10:00 IST', () => {
    const rows = [
      { checkin_at: ist(9, 15) }, { checkin_at: ist(8, 2) }, { checkin_at: ist(10, 0) },   // on time (10:00 exactly is not late)
      { checkin_at: ist(10, 1) }, { checkin_at: ist(11, 30) }, { checkin_at: ist(14, 5) },
    ];
    const f = computeAttendanceFacts(rows);
    expect(f.first_check_in).toBe(ist(8, 2));
    expect(f.late_checkins).toBe(3);
  });

  it('is null / 0 when nobody has checked in', () => {
    expect(computeAttendanceFacts([])).toEqual({ first_check_in: null, late_checkins: 0 });
    expect(computeAttendanceFacts([{ checkin_at: null }, {}])).toEqual({ first_check_in: null, late_checkins: 0 });
  });

  it('ignores a malformed timestamp instead of throwing', () => {
    const f = computeAttendanceFacts([{ checkin_at: 'not-a-date' }, { checkin_at: ist(9, 0) }]);
    expect(f.first_check_in).toBe(ist(9, 0));
    expect(f.late_checkins).toBe(0);
  });

  it('takes a custom cut-off', () => {
    const rows = [{ checkin_at: ist(9, 0) }, { checkin_at: ist(9, 45) }];
    expect(computeAttendanceFacts(rows, 9 * 60 + 30).late_checkins).toBe(1);
  });

  it('defaults to a 10:00 am cut-off', () => {
    expect(LATE_AFTER_MINUTES_IST).toBe(600);
  });
});
