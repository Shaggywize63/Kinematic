/**
 * Deduplication helpers using citext + pg_trgm.
 */
import { supabaseAdmin } from '../../lib/supabase';
import crypto from 'crypto';

export async function findLeadByEmail(org_id: string, email: string) {
  // Hash-based lookup using the generated email_hash column. The hash
  // input is lower-cased and trimmed exactly like the column, so "Foo@bar.com"
  // and "foo@bar.com " collide. Falls back to a raw .eq() lookup only
  // when the input doesn't hash (empty / whitespace) — that branch
  // returns null too in practice, but the structure is kept for clarity.
  const hash = hashEmail(email);
  if (!hash) return null;
  const { data } = await supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, email, phone, company')
    .eq('org_id', org_id)
    .eq('email_hash', hash)
    .is('deleted_at', null)
    .is('converted_at', null)
    .maybeSingle();
  return data;
}

/**
 * Phone-based dedup. Hashes the input phone the same way the generated
 * crm_leads.phone_hash column does — strip every non-digit, sha256 the
 * remainder, hex-encode — and looks up by phone_hash. This catches every
 * format variant the previous ilike-suffix matcher missed (stored
 * "+91 98765 43210" never ended with the bare "9876543210" string, so
 * the suffix match silently failed and a duplicate slipped through).
 *
 * Excludes already-converted leads from the dedup window so a customer
 * coming back as a fresh inquiry can still be captured as a new lead.
 */
export async function findLeadByPhone(org_id: string, phone: string) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  if (!digits || digits.length < 7) return null;
  // hashPhone uses the same crypto.sha256(hex) as the generated column,
  // so a JS-side hash collides with the column on every common format
  // variant (+919876543210, +91 98765 43210, 09876543210, …).
  const hash = hashPhone(digits);
  if (!hash) return null;
  const { data } = await supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, email, phone, company')
    .eq('org_id', org_id)
    .eq('phone_hash', hash)
    .is('deleted_at', null)
    .is('converted_at', null)
    .limit(1);
  return data?.[0] ?? null;
}

export async function findContactByEmail(org_id: string, email: string) {
  const { data } = await supabaseAdmin.from('crm_contacts').select('id, first_name, last_name, email, account_id')
    .eq('org_id', org_id).eq('email', email).is('deleted_at', null).maybeSingle();
  return data;
}

export async function findAccountByDomain(org_id: string, domain: string) {
  const { data } = await supabaseAdmin.from('crm_accounts').select('id, name, domain')
    .eq('org_id', org_id).eq('domain', domain).is('deleted_at', null).maybeSingle();
  return data;
}

export async function findProbableLeadMatches(org_id: string, name: string) {
  // Uses pg_trgm ILIKE for a quick similarity hit (full RPC version planned).
  if (!name) return [];
  const { data } = await supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, email, company')
    .eq('org_id', org_id).is('deleted_at', null)
    .ilike('company', `%${name.replace(/[%_]/g, '')}%`).limit(5);
  return data ?? [];
}

// ── Hash-indexed lookup (used by integration ingestion + bulk import) ────────
//
// Mirrors the generated columns `crm_leads.phone_hash` / `email_hash`:
//   phone_hash = sha256(digits-only(phone))
//   email_hash = sha256(lowercase-trim(email))
//
// Lookup hits the partial indexes `idx_crm_leads_(phone|email)_hash` for
// constant-time dedup even on millions of leads, where the existing
// ilike-suffix phone match degrades to a full scan.

/** Hash a phone the same way the generated column does. Returns null for empty/too-short input. */
export function hashPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  return crypto.createHash('sha256').update(digits).digest('hex');
}

/** Hash an email the same way the generated column does. Returns null for empty input. */
export function hashEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  if (normalized.length === 0) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Indexed dedup — looks up an existing lead by phone-hash OR email-hash.
 * Returns the first match (id + key fields for logging). Pass either hash
 * as null when the source lead lacks that field. If both are null the
 * function returns null without hitting the DB.
 *
 * Includes converted leads (unlike findLeadByEmail/Phone above) because
 * the orchestrator wants to attribute the new source to the existing
 * customer record rather than open a parallel duplicate.
 */
export async function findByHashes(
  org_id: string,
  phone_hash: string | null,
  email_hash: string | null,
): Promise<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null } | null> {
  if (!phone_hash && !email_hash) return null;

  const filters: string[] = [];
  if (phone_hash) filters.push(`phone_hash.eq.${phone_hash}`);
  if (email_hash) filters.push(`email_hash.eq.${email_hash}`);

  const { data } = await supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, email, phone')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .or(filters.join(','))
    .limit(1);
  return data?.[0] ?? null;
}
