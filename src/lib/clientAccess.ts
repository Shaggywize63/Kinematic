import { supabaseAdmin } from './supabase';

/**
 * Client-level access gate.
 *
 * A client (tenant workspace in Client Management) blocks ALL of its users
 * from signing in / using the API when either:
 *   - it has been manually deactivated (`clients.is_active = false`), or
 *   - its trial period has ended (`clients.settings.trial.end_date` is a past
 *     calendar day).
 *
 * This is the server-side enforcement behind the product rule "if the trial
 * has ended, the client is deactivated and its users can't log in again — same
 * for a manually deactivated client". It is applied at login (fresh sign-in)
 * and in the auth middleware (so an active session is cut too, not just new
 * logins). It is a CLIENT-level gate: platform/org operators (users with no
 * `client_id`, and super_admins) are never blocked by it.
 */

export type ClientAccessReason = 'inactive' | 'trial_ended';

export interface ClientAccess {
  blocked: boolean;
  reason: ClientAccessReason | null;
  /** User-facing message safe to return on a 401/403. */
  message: string;
}

const ALLOWED: ClientAccess = { blocked: false, reason: null, message: '' };

const MSG_INACTIVE =
  'This account has been deactivated. Please contact your administrator.';
const MSG_TRIAL_ENDED =
  'Your trial period has ended. Please contact your administrator to continue.';

// Trials are expressed as IST calendar dates (the dashboard computes end_date
// from the admin's local day), so "today" is compared on the Asia/Kolkata
// wall-calendar — not UTC — to avoid an off-by-one around midnight. `en-CA`
// formats as YYYY-MM-DD, which also sorts lexicographically as a date.
export function istTodayISO(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

type ClientRow = {
  is_active?: boolean | null;
  settings?: { trial?: { end_date?: string | null } | null } | null;
} | null;

/**
 * Pure evaluator — no DB, unit-testable. A trial is "ended" only once its
 * end_date is strictly BEFORE today (the end_date day itself is still live,
 * matching the dashboard's "Nd left" / "Ended Nd ago" boundary). A client with
 * no trial record (a paid/active tenant) is never blocked by the trial rule.
 * A null row (unknown/missing client) is NOT blocked — the gate fails open so a
 * data gap never locks a tenant out; the definite `is_active=false` and
 * past-trial cases are the only ones that block.
 */
export function evaluateClientAccess(row: ClientRow, todayISO: string = istTodayISO()): ClientAccess {
  if (!row) return ALLOWED;
  if (row.is_active === false) {
    return { blocked: true, reason: 'inactive', message: MSG_INACTIVE };
  }
  const end = row.settings?.trial?.end_date;
  if (typeof end === 'string' && DATE_RE.test(end) && end.slice(0, 10) < todayISO.slice(0, 10)) {
    return { blocked: true, reason: 'trial_ended', message: MSG_TRIAL_ENDED };
  }
  return ALLOWED;
}

/**
 * DB-backed gate for a given client id, scoped to the caller's project (the
 * `clients` table lives per-project; supabaseAdmin already points at the
 * current request's project). Returns "not blocked" for a null client id
 * (platform/org users) and fails OPEN on any lookup error so a transient DB
 * hiccup can't lock every tenant out — the authoritative deny cases come from
 * `evaluateClientAccess` on a row we actually read.
 */
export async function checkClientAccess(clientId: string | null | undefined): Promise<ClientAccess> {
  if (!clientId) return ALLOWED;
  try {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('is_active, settings')
      .eq('id', clientId)
      .maybeSingle();
    if (error) return ALLOWED;
    return evaluateClientAccess(data as ClientRow);
  } catch {
    return ALLOWED;
  }
}
