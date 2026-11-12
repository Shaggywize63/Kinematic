/**
 * Lead numbers — a unique, human-readable reference on every lead of a connected-B2B client, e.g. `SR/LD/2627-12`:
 *
 *   SR/LD  the client's prefix (clients.settings.lead_ref_prefix; DEFAULT `SR/LD` when unset — the format the
 *          customer, Spark & Ray, asked for)
 *   2627   the Indian financial year (Apr 2026 – Mar 2027), shared with form refs (formRef.financialYearCode)
 *   12     a running number, restarting at 1 each financial year, no zero padding
 *
 * It is quoted in e-mail subjects (`[SR/LD/2627-12] …`) so replies and updates can be traced back to the lead.
 *
 * Same shape as form refs (formRef.ts): only connected-B2B clients (an in-memory check, so every other tenant
 * makes no extra database call), an atomic counter in the database (`next_lead_ref`, migration_lead_ref_and_type.sql),
 * and it never throws — a numbering problem leaves the lead without a number (and is logged), so a lead is always saved.
 */
import { supabaseAdmin } from './supabase';
import { getClientSettings } from './clientFlags';
import { isB2bClient } from './b2bClients';
import { financialYearCode } from './formRef';
import { logger } from './logger';

/** The prefix used when `clients.settings.lead_ref_prefix` is not set. */
export const DEFAULT_LEAD_REF_PREFIX = 'SR/LD';

/** The two lead types. A lead has one of them, or none (null). */
export const LEAD_TYPES = ['requirement', 'discussion'] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

/**
 * The prefix as stored: trimmed, upper-case, `/`-separated groups of letters/digits (e.g. `SR/LD`), at most 16
 * characters. Anything else = no usable prefix (null).
 */
export function normalizeLeadPrefix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().toUpperCase();
  return p.length >= 1 && p.length <= 16 && /^[A-Z0-9]+(\/[A-Z0-9]+)*$/.test(p) ? p : null;
}

/** `SR/LD` + `2627` + `12` → `SR/LD/2627-12`. */
export function formatLeadRef(prefix: string, fyCode: string, n: number): string {
  return `${prefix}/${fyCode}-${n}`;
}

/**
 * The prefix for a client's settings: the configured one, else `SR/LD`. A value that is set but not a valid prefix
 * also falls back to the default (and is logged) rather than silently stopping numbering.
 */
export function leadRefPrefixFromSettings(settings: Record<string, unknown> | null | undefined): string {
  const raw = settings?.lead_ref_prefix;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return DEFAULT_LEAD_REF_PREFIX;
  const p = normalizeLeadPrefix(raw);
  if (p) return p;
  logger.warn({ lead_ref_prefix: String(raw).slice(0, 40) }, 'lead ref: invalid lead_ref_prefix setting, using the default prefix');
  return DEFAULT_LEAD_REF_PREFIX;
}

/**
 * What a person types for a lead number, as stored: trimmed, upper-case, any dash look-alike (– — − ‑) turned into a
 * plain hyphen, inner spaces removed. Null unless it looks like PREFIX/YYYY-N so a stray string never reaches the
 * database lookup.
 */
export function normalizeLeadRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[‐-―−]/g, '-').replace(/\s+/g, '').toUpperCase();
  return s.length <= 40 && /^[A-Z0-9]+(\/[A-Z0-9]+)*\/\d{4}-\d{1,9}$/.test(s) ? s : null;
}

export interface LeadRefAllocation {
  /** The new number, or null when none was assigned. */
  ref: string | null;
  /** True when the reason is that the counter function / table does not exist in this database (not migrated). */
  notMigrated: boolean;
}

const MISSING_FN_CODES = new Set(['PGRST202', 'PGRST205', '42883', '42P01']);
function isCounterMissing(e: { code?: string; message?: string } | null | undefined): boolean {
  if (!e) return false;
  if (e.code && MISSING_FN_CODES.has(e.code)) return true;
  return /could not find the function|function .*next_lead_ref.* does not exist|lead_ref_counters.*does not exist|could not find the table/i.test(String(e.message ?? ''));
}

/** Like allocateLeadRef, but also says whether a null is because the database has not been migrated. Never throws. */
export async function tryAllocateLeadRef(clientId: string | null | undefined, at: Date = new Date()): Promise<LeadRefAllocation> {
  if (!clientId || !isB2bClient(clientId)) return { ref: null, notMigrated: false };
  try {
    const prefix = leadRefPrefixFromSettings(await getClientSettings(clientId));
    const fy = financialYearCode(at);
    const { data, error } = await supabaseAdmin.rpc('next_lead_ref', { p_client: clientId, p_series: `${prefix}/${fy}` });
    const n = typeof data === 'number' ? data : Number(data);
    if (error || !Number.isInteger(n) || n < 1) {
      logger.warn({ err: error?.message, clientId }, 'lead ref: counter unavailable, lead saved without a number');
      return { ref: null, notMigrated: isCounterMissing(error) };
    }
    return { ref: formatLeadRef(prefix, fy, n), notMigrated: false };
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, clientId }, 'lead ref: allocation failed, lead saved without a number');
    return { ref: null, notMigrated: false };
  }
}

/**
 * The next lead number for this client in the financial-year series of `at` (default: now), or null when the client
 * does not use lead numbers or the counter is unavailable. Never throws.
 */
export async function allocateLeadRef(clientId: string | null | undefined, at: Date = new Date()): Promise<string | null> {
  return (await tryAllocateLeadRef(clientId, at)).ref;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `subject` already mentions this exact lead number (case-insensitive; `…-1` is not found inside `…-12`). */
export function subjectHasLeadRef(subject: string, ref: string): boolean {
  if (!ref) return false;
  return new RegExp(`(?<![A-Za-z0-9/])${escapeRegExp(ref.trim())}(?![0-9])`, 'i').test(subject);
}

/**
 * The subject with the lead number in front — `[SR/LD/2627-12] Quote for pumps` — unless it is already mentioned
 * (case-insensitive). No lead number → the subject unchanged. An empty subject becomes just `[SR/LD/2627-12]`.
 */
export function withLeadRefInSubject(subject: string | null | undefined, ref: string | null | undefined): string {
  const s = typeof subject === 'string' ? subject : '';
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r) return s;
  if (subjectHasLeadRef(s, r)) return s;
  const rest = s.trim();
  return rest ? `[${r}] ${rest}` : `[${r}]`;
}

/**
 * The lead number of a lead, for stamping an e-mail subject. Never throws: any lookup problem (an unmigrated
 * database has no such column) reads as "no number".
 */
export async function getLeadRefNo(orgId: string, leadId: string | null | undefined): Promise<string | null> {
  if (!leadId) return null;
  try {
    const { data, error } = await supabaseAdmin.from('crm_leads').select('ref_no').eq('org_id', orgId).eq('id', leadId).maybeSingle();
    if (error) return null;
    const ref = (data as { ref_no?: unknown } | null)?.ref_no;
    return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
  } catch {
    return null;
  }
}
