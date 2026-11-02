/**
 * Form reference numbers — a unique, human-readable id stamped on every form a
 * rep fills, e.g. `SRPR2627-1`:
 *
 *   SRPR   the client's prefix (clients.settings.form_ref_prefix)
 *   2627   the Indian financial year (Apr 2026 – Mar 2027)
 *   1      a running number, restarting at 1 each financial year
 *
 * Opt-in, twice over: only connected-B2B clients (Spark & Ray — an in-memory check,
 * so every other tenant makes no extra database call at all) AND only when the client
 * has a `form_ref_prefix` setting. Everyone else gets no reference and their
 * submissions are written exactly as before (so a tenant whose database has not run
 * migration_form_ref_no.sql is never touched).
 */
import { supabaseAdmin } from './supabase';
import { getClientSettings } from './clientFlags';
import { isB2bClient } from './b2bClients';
import { logger } from './logger';

/** `2627` for any moment from 1 Apr 2026 to 31 Mar 2027, IST. */
export function financialYearCode(at: Date): string {
  const ist = new Date(at.getTime() + (5 * 60 + 30) * 60 * 1000);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const start = month >= 4 ? year : year - 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `${yy(start)}${yy(start + 1)}`;
}

/** The prefix as stored: trimmed, upper-case, letters/digits only (1–12). Anything else = no prefix. */
export function normalizePrefix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(p) ? p : null;
}

/** `SRPR` + `2627` + `-` + `1` → `SRPR2627-1`. */
export function formatFormRef(prefix: string, fyCode: string, n: number): string {
  return `${prefix}${fyCode}-${n}`;
}

/**
 * The next reference for this client, or null when the client has no prefix or
 * the counter is unavailable. Never throws: a submission must always be saved,
 * so a numbering problem just leaves the reference empty (and is logged).
 */
export async function allocateFormRef(clientId: string | null | undefined, at: Date = new Date()): Promise<string | null> {
  if (!clientId || !isB2bClient(clientId)) return null;
  try {
    const prefix = normalizePrefix((await getClientSettings(clientId)).form_ref_prefix);
    if (!prefix) return null;
    const fy = financialYearCode(at);
    const { data, error } = await supabaseAdmin.rpc('next_form_ref', { p_client: clientId, p_series: `${prefix}${fy}` });
    const n = typeof data === 'number' ? data : Number(data);
    if (error || !Number.isInteger(n) || n < 1) {
      logger.warn({ err: error?.message, clientId }, 'form ref: counter unavailable, submission saved without a reference');
      return null;
    }
    return formatFormRef(prefix, fy, n);
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, clientId }, 'form ref: allocation failed, submission saved without a reference');
    return null;
  }
}
