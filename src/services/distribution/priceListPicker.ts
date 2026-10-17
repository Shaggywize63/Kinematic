import { supabaseAdmin } from '../../lib/supabase';

export interface PickPriceListOpts {
  org_id: string;
  customer_class: string;
  region: string;
  /** Selected company (user.client_id). Only used when `company_scoped`. */
  client_id?: string | null;
  /** True for a rep who sells for several companies: each company has its own prices. */
  company_scoped?: boolean;
  select?: string;
}

/** A rep assigned to more than one company prices from the picked company's own list. */
export const isCompanyScoped = (user: { company_client_ids?: string[] } | null | undefined): boolean =>
  (user?.company_client_ids?.length ?? 0) > 1;

/**
 * The active price list for an order or the catalogue.
 *
 * Everyone else (Tata, single-company users) gets exactly the old lookup: by org, customer class and region.
 * A multi-company rep gets the picked company's own list first; if that company has none they fall back to
 * org-wide lists (no company), never another company's prices.
 */
export async function pickPriceList(o: PickPriceListOpts) {
  const sel = o.select ?? '*';
  const regionOr = `region.eq.${o.region},region.eq.ALL`;
  if (o.company_scoped && o.client_id) {
    const own = await supabaseAdmin.from('price_lists').select(sel)
      .eq('org_id', o.org_id).eq('client_id', o.client_id)
      .or(regionOr).eq('is_active', true)
      .order('region', { ascending: false }).order('version', { ascending: false })
      .limit(1).maybeSingle();
    if (own.data) return own.data as any;
    const shared = await supabaseAdmin.from('price_lists').select(sel)
      .eq('org_id', o.org_id).is('client_id', null).eq('customer_class', o.customer_class)
      .or(regionOr).eq('is_active', true)
      .order('region', { ascending: false }).order('version', { ascending: false })
      .limit(1).maybeSingle();
    return (shared.data as any) ?? null;
  }
  const { data } = await supabaseAdmin.from('price_lists').select(sel)
    .eq('org_id', o.org_id).eq('customer_class', o.customer_class)
    .or(regionOr).eq('is_active', true)
    .order('region', { ascending: false }).order('version', { ascending: false })
    .limit(1).maybeSingle();
  return (data as any) ?? null;
}
