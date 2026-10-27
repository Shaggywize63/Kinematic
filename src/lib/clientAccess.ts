import { supabaseAdmin } from './supabase';
import { logger } from './logger';

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
    const access = evaluateClientAccess(data as ClientRow);
    // Auto-deactivate the stored flag the first time we see an ended trial on a
    // still-active client, so the Client Management "Active" toggle reflects the
    // block (matching the daily sweep). Fire-and-forget and guarded on
    // is_active=true so it writes only on the transition, never on every request
    // once it is already off. Access is already blocked above, so a failed flip
    // is harmless — the next request retries it.
    if (access.reason === 'trial_ended' && (data as ClientRow)?.is_active === true) {
      void Promise.resolve(
        supabaseAdmin.from('clients').update({ is_active: false }).eq('id', clientId).eq('is_active', true),
      ).then((res) => {
        const e = (res as { error?: { message?: string } } | null)?.error;
        if (e) logger.warn(`[clientAccess] trial auto-deactivate failed for ${clientId}: ${e.message}`);
      }).catch((e: any) => logger.warn(`[clientAccess] trial auto-deactivate threw for ${clientId}: ${e?.message ?? e}`));
    }
    return access;
  } catch {
    return ALLOWED;
  }
}

/**
 * Sweep: flip `is_active=false` for every client in the CURRENT project whose
 * trial has ended but is still marked active, so the Client Management "Active"
 * toggle automatically turns off at trial expiry (the access gate already blocks
 * logins — this keeps the stored flag/toggle honest). Idempotent: only
 * still-active clients are touched, so repeat runs (or several server instances)
 * are no-ops once flipped. The `clients` table is the small per-tenant control
 * table, so scanning it in full is cheap. Called by the daily in-process tick in
 * server.ts via forEachProject.
 */
export async function deactivateExpiredTrials(): Promise<{ scanned: number; deactivated: number }> {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id, settings')
    .eq('is_active', true);
  if (error || !Array.isArray(data)) return { scanned: 0, deactivated: 0 };
  const today = istTodayISO();
  const expiredIds = (data as Array<{ id: string; settings?: NonNullable<ClientRow>['settings'] }>)
    .filter((c) => evaluateClientAccess({ is_active: true, settings: c.settings }, today).reason === 'trial_ended')
    .map((c) => c.id);
  if (expiredIds.length === 0) return { scanned: data.length, deactivated: 0 };
  const { error: upErr } = await supabaseAdmin
    .from('clients')
    .update({ is_active: false })
    .in('id', expiredIds)
    .eq('is_active', true);
  if (upErr) {
    logger.warn(`[clientAccess] trial sweep update failed: ${upErr.message}`);
    return { scanned: data.length, deactivated: 0 };
  }
  return { scanned: data.length, deactivated: expiredIds.length };
}
