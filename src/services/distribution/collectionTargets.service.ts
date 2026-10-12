/**
 * Employee-wise monthly ₹ collection targets — the pure rules, unit-tested. The DB access lives in the controller;
 * this file normalises the month, builds the UTC range to sum payments over, decides who may hold a target, and does
 * the achievement maths.
 *
 * Actual collection for a user in a month = the sum of that user's payments (`salesman_id`) whose status is counted
 * (cleared or pending — the same set the collection screens treat as money in) and whose `received_at` falls in the
 * month. Computed at read time; never stored.
 */

/** Payment statuses that count toward a collection actual (money received or clearing). A cancelled/bounced one does not. */
export const COUNTED_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['cleared', 'pending']);

/** Roles that may be given a collection target: field reps and their supervisors / managers. */
const TARGET_ROLES: ReadonlySet<string> = new Set([
  'field_executive', 'executive', 'salesman', 'sales_rep',
  'city_manager', 'supervisor', 'manager', 'area_manager', 'regional_manager',
]);

export function isTargetRole(role: string | null | undefined): boolean {
  return !!role && TARGET_ROLES.has(role.trim().toLowerCase());
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The first day of the month, `YYYY-MM-01`, from `YYYY-MM` or any `YYYY-MM-DD`. Null for anything unparseable, so a bad
 * query never becomes a silent whole-table scan.
 */
export function monthStart(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(input.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/**
 * The half-open UTC instant range `[start, end)` covering the IST month that begins on `monthStartDate` (`YYYY-MM-01`).
 * IST is UTC+5:30, so the month's first IST midnight is 18:30 UTC on the last day of the previous month. Using IST
 * keeps the actual aligned with how payment days are shown everywhere else in the app.
 */
export function monthRangeUtc(monthStartDate: string): { startUtc: string; endUtc: string } {
  const [y, m] = monthStartDate.split('-').map(Number);
  // IST midnight on the 1st = previous day 18:30 UTC.
  const startUtc = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 5.5 * 3600 * 1000);
  const endUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0) - 5.5 * 3600 * 1000); // first of next month, IST midnight
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() };
}

/** Percentage of target achieved, rounded to 2 dp. 0 target ⇒ 0 (nothing to measure against, never divide by zero). */
export function achievementPct(actual: number, target: number): number {
  if (!target || target <= 0) return 0;
  return round2((actual / target) * 100);
}

/** 'exceeded' (≥100%), 'on_track' (≥60%), 'behind' (>0), or 'none' (no collection yet). Thresholds are display-only. */
export function achievementBand(actual: number, target: number): 'exceeded' | 'on_track' | 'behind' | 'none' {
  if (actual <= 0) return 'none';
  const pct = achievementPct(actual, target);
  if (target <= 0) return 'none';
  if (pct >= 100) return 'exceeded';
  if (pct >= 60) return 'on_track';
  return 'behind';
}

/** A whole, non-negative ₹ amount, or null for blank / invalid. Never throws. */
export function cleanAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return round2(n);
}

export interface TargetRow { user_id: string; target_amount: number; id: string; note?: string | null }
export interface CollectorActual { user_id: string; actual: number }
export interface UserLite { id: string; name: string | null; role: string | null; employee_id?: string | null }

/**
 * One report row per eligible user: their target (0 when none set), their actual collection for the month, the % and
 * the band. Users with neither a target nor any collection are still listed (so an admin can set one), as long as they
 * are a target-role user.
 */
export function buildReport(users: UserLite[], targets: TargetRow[], actuals: CollectorActual[]) {
  const targetByUser = new Map<string, TargetRow>();
  for (const t of targets) targetByUser.set(t.user_id, t);
  const actualByUser = new Map<string, number>();
  for (const a of actuals) actualByUser.set(a.user_id, round2(a.actual));

  return users
    .filter((u) => isTargetRole(u.role))
    .map((u) => {
      const t = targetByUser.get(u.id);
      const target = t ? round2(t.target_amount) : 0;
      const actual = actualByUser.get(u.id) ?? 0;
      return {
        user_id: u.id,
        name: u.name ?? null,
        employee_id: u.employee_id ?? null,
        role: u.role ?? null,
        target_id: t ? t.id : null,
        target_amount: target,
        note: t ? t.note ?? null : null,
        actual,
        balance: round2(target - actual),
        achievement_pct: achievementPct(actual, target),
        band: achievementBand(actual, target),
      };
    });
}
