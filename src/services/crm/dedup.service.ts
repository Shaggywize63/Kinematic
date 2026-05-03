/**
 * Deduplication helpers using citext + pg_trgm.
 */
import { supabaseAdmin } from '../../lib/supabase';

export async function findLeadByEmail(org_id: string, email: string) {
  const { data } = await supabaseAdmin.from('crm_leads').select('id, first_name, last_name, email, company')
    .eq('org_id', org_id).eq('email', email).is('deleted_at', null).is('converted_at', null).maybeSingle();
  return data;
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
