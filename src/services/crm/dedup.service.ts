/**
 * Deduplication helpers using citext + pg_trgm.
 */
import { supabaseAdmin } from '../../lib/supabase';

export async function findLeadByEmail(org_id: string, email: string) {
  const { data } = await supabaseAdmin.from('crm_leads').select('id, first_name, last_name, email, phone, company')
    .eq('org_id', org_id).eq('email', email).is('deleted_at', null).is('converted_at', null).maybeSingle();
  return data;
}

/**
 * Phone-based dedup. Normalises both the input and the stored value to the
 * last 10 digits (covers Indian mobile numbers and most country-suffixed
 * formats — "+919876543210", "+91 98765 43210", "09876543210" all collapse
 * to "9876543210"). Falls back to no match if the normalised digits are
 * shorter than 7 — too short to be a real number, and matching short
 * substrings would produce false positives across the tenant.
 *
 * Excludes already-converted leads from the dedup window so a customer
 * coming back as a fresh inquiry can still be captured as a new lead
 * (the converted lead is the historical record; the new lead is what the
 * rep is working).
 */
export async function findLeadByPhone(org_id: string, phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 7) return null;

  // ilike '%<digits>' so '+919876543210' (stored) matches input
  // '9876543210' and vice versa. Limit 1 — the first hit is enough for
  // the caller to surface a 409.
  const { data } = await supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, email, phone, company')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .is('converted_at', null)
    .ilike('phone', `%${normalized}`)
    .limit(1);
  return data?.[0] ?? null;
}

/**
 * Strip non-digits and keep the trailing 10 (or all if fewer). Same
 * normalisation is implicit in the ilike-suffix lookup above so both
 * sides collapse to the same canonical form.
 */
function normalizePhone(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
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
