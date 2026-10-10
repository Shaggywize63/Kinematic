/**
 * Form visit times — DB-facing half (the pure sanitiser is formVisit.service.ts).
 *
 * The client's `form_checkin_required` attendance rule (clients.settings.attendance_rules, 60 s
 * cached read) is only consulted when it can matter: a valid check-in that arrived without a
 * check-out. Every other submission costs nothing extra.
 */
import { rulesForClient } from './attendanceRules.store';
import { mayAutoCheckout, sanitiseVisitTimes, type VisitTimes } from './formVisit.service';

/**
 * The check-in / check-out / duration to store for a submission by a user of `clientId`.
 * Never throws and never rejects: a failed rule lookup reads as "rule off".
 */
export async function resolveVisitTimes(
  clientId: string | null | undefined,
  input: { check_in_at?: unknown; check_out_at?: unknown },
  nowMs: number = Date.now(),
): Promise<VisitTimes> {
  let autoCheckout = false;
  if (clientId && mayAutoCheckout(input)) {
    try { autoCheckout = (await rulesForClient(clientId)).rules.form_checkin_required === true; }
    catch { autoCheckout = false; }
  }
  return sanitiseVisitTimes(input, { nowMs, autoCheckout });
}
