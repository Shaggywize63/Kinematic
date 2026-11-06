import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

/**
 * The location master (crm_states / crm_cities) is per organisation. An organisation that was never seeded has an
 * empty State picker everywhere, so the first read of /crm/states fills it in: the database's
 * crm_seed_indian_locations() (all states + the major cities, idempotent) and, if that function is not there, the
 * 36 states and union territories from the list below so State is always selectable. Never throws.
 */
export const INDIAN_STATES: ReadonlyArray<{ name: string; code: string }> = [
  { name: 'Andhra Pradesh', code: 'AP' }, { name: 'Arunachal Pradesh', code: 'AR' }, { name: 'Assam', code: 'AS' },
  { name: 'Bihar', code: 'BR' }, { name: 'Chhattisgarh', code: 'CG' }, { name: 'Goa', code: 'GA' },
  { name: 'Gujarat', code: 'GJ' }, { name: 'Haryana', code: 'HR' }, { name: 'Himachal Pradesh', code: 'HP' },
  { name: 'Jharkhand', code: 'JH' }, { name: 'Karnataka', code: 'KA' }, { name: 'Kerala', code: 'KL' },
  { name: 'Madhya Pradesh', code: 'MP' }, { name: 'Maharashtra', code: 'MH' }, { name: 'Manipur', code: 'MN' },
  { name: 'Meghalaya', code: 'ML' }, { name: 'Mizoram', code: 'MZ' }, { name: 'Nagaland', code: 'NL' },
  { name: 'Odisha', code: 'OD' }, { name: 'Punjab', code: 'PB' }, { name: 'Rajasthan', code: 'RJ' },
  { name: 'Sikkim', code: 'SK' }, { name: 'Tamil Nadu', code: 'TN' }, { name: 'Telangana', code: 'TS' },
  { name: 'Tripura', code: 'TR' }, { name: 'Uttar Pradesh', code: 'UP' }, { name: 'Uttarakhand', code: 'UK' },
  { name: 'West Bengal', code: 'WB' },
  // Union territories
  { name: 'Andaman and Nicobar Islands', code: 'AN' }, { name: 'Chandigarh', code: 'CH' },
  { name: 'Dadra and Nagar Haveli and Daman and Diu', code: 'DN' }, { name: 'Delhi', code: 'DL' },
  { name: 'Jammu and Kashmir', code: 'JK' }, { name: 'Ladakh', code: 'LA' }, { name: 'Lakshadweep', code: 'LD' },
  { name: 'Puducherry', code: 'PY' },
];

const checked = new Set<string>();

export async function ensureLocationMaster(orgId: string): Promise<void> {
  if (!orgId || checked.has(orgId)) return;
  try {
    const { data, error } = await supabaseAdmin.from('crm_states').select('id').eq('org_id', orgId).limit(1);
    if (error) return; // table unreadable: leave it alone, the caller's own read will report it
    if ((data ?? []).length > 0) { checked.add(orgId); return; }
    const { error: rpcErr } = await supabaseAdmin.rpc('crm_seed_indian_locations', { p_org_id: orgId });
    if (rpcErr) {
      logger.warn({ err: rpcErr.message, orgId }, 'location master: seed function unavailable, inserting the states only');
      const { error: insErr } = await supabaseAdmin.from('crm_states')
        .insert(INDIAN_STATES.map((s) => ({ org_id: orgId, name: s.name, code: s.code, country: 'India' })));
      if (insErr) { logger.warn({ err: insErr.message, orgId }, 'location master: state insert failed'); return; }
    }
    checked.add(orgId);
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, orgId }, 'location master: seed check failed');
  }
}
