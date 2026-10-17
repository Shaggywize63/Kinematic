import { supabaseAdmin } from '../../lib/supabase';

/**
 * The company's own active price list, created on first use. Imported Tally stock items are added to it so
 * the company's catalogue has something to show. The (org, class, region, version) key is unique, so a
 * company's list gets a class of its own (`co-<first 8 of its id>`).
 */
export async function ensureCompanyPriceList(org_id: string, client_id: string, created_by?: string): Promise<string | null> {
  const found = await supabaseAdmin.from('price_lists').select('id')
    .eq('org_id', org_id).eq('client_id', client_id).eq('is_active', true)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (found.data?.id) return found.data.id as string;

  const co = await supabaseAdmin.from('clients').select('name').eq('id', client_id).eq('org_id', org_id).maybeSingle();
  const created = await supabaseAdmin.from('price_lists').insert({
    org_id, client_id, name: `${co.data?.name ?? 'Company'} price list`,
    customer_class: `co-${client_id.slice(0, 8)}`, region: 'ALL', version: 1, is_active: true, created_by: created_by ?? null,
  }).select('id').single();
  return (created.data?.id as string) ?? null;
}

/** Tally's selling rate, else the MRP; null when Tally has neither (we never sell at 0). */
export function tallyPrice(d: Record<string, unknown>): number | null {
  for (const k of ['rate', 'mrp']) {
    const v = Number(d[k]);
    if (Number.isFinite(v) && v > 0) return Math.round(v * 100) / 100;
  }
  return null;
}
