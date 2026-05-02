import { supabaseAdmin } from '../lib/supabase';
import { computeLineTax, isIntraState, summariseTotals } from './tax';

/**
 * M1 order pricer (no schemes yet — schemes engine arrives in M3 and replaces
 * this with a richer pipeline. The interface stays the same so callers don't
 * change.)
 *
 * Resolves the active price list for the customer-class/region/date, hydrates
 * each line with HSN + GST + MRP from product_distribution_ext, computes per-line
 * tax (intra/inter state) and aggregates totals.
 */

export const ENGINE_VERSION = 'pricer-1.0.0';

export interface CartLineInput {
  sku_id: string;
  qty: number;
  uom?: string;
  // Optional client-computed numbers — we ignore them and use ours.
  unit_price?: number;
}

export interface PricedLine {
  sku_id: string;
  sku_name: string | null;
  sku_code: string | null;
  hsn_code: string | null;
  qty: number;
  uom: string;
  pack_size: number;
  unit_price: number;
  mrp: number;
  discount_pct: number;
  discount_amt: number;
  scheme_id: string | null;
  scheme_version: number | null;
  is_free_good: boolean;
  taxable_value: number;
  gst_rate: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;
  price_list_version: number;
  line_no: number;
}

export interface PriceCartContext {
  org_id: string;
  client_id?: string | null;
  customer_class: string;
  region?: string | null;
  distributor_state_code?: string | null;
  outlet_state_code?: string | null;
  place_of_supply?: string | null;
  date?: string;
}

export interface PriceCartResult {
  lines: PricedLine[];
  applied_schemes: Array<{ scheme_id: string; scheme_version: number; inputs: any; outputs: any }>;
  totals: ReturnType<typeof summariseTotals>;
  price_list_id: string;
  price_list_version: number;
  intra_state: boolean;
  engine_version: string;
}

export class PricerError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export async function priceCart(cart: CartLineInput[], ctx: PriceCartContext): Promise<PriceCartResult> {
  if (!cart.length) throw new PricerError('EMPTY_CART', 'Cart is empty');

  // 1. Resolve active price list.
  const region = ctx.region || 'ALL';
  const { data: priceList } = await supabaseAdmin
    .from('price_lists').select('*')
    .eq('org_id', ctx.org_id)
    .eq('customer_class', ctx.customer_class)
    .or(`region.eq.${region},region.eq.ALL`)
    .eq('is_active', true)
    .order('region', { ascending: false })   // exact region beats ALL
    .order('version', { ascending: false })
    .limit(1).maybeSingle();
  if (!priceList) throw new PricerError('NO_PRICE_LIST', `No active price list for ${ctx.customer_class}/${region}`);

  // 2. Fetch price list items for our SKUs.
  const skuIds = Array.from(new Set(cart.map((c) => c.sku_id)));
  const [{ data: priceItems }, { data: prodExt }, { data: skuRows }] = await Promise.all([
    supabaseAdmin.from('price_list_items').select('sku_id, base_price, min_qty, max_qty')
      .eq('price_list_id', priceList.id).in('sku_id', skuIds),
    supabaseAdmin.from('product_distribution_ext')
      .select('sku_id, hsn_code, gst_rate, cess_rate, uom, pack_size, mrp, is_active')
      .in('sku_id', skuIds),
    supabaseAdmin.from('skus').select('id, name, code').in('id', skuIds),
  ]);

  const priceMap = new Map((priceItems || []).map((p: any) => [p.sku_id, p]));
  const extMap = new Map((prodExt || []).map((p: any) => [p.sku_id, p]));
  const skuMap = new Map((skuRows || []).map((s: any) => [s.id, s]));

  const intra = isIntraState(ctx.distributor_state_code, ctx.place_of_supply || ctx.outlet_state_code);

  // 3. Compute per-line.
  const lines: PricedLine[] = cart.map((c, idx) => {
    const ext: any = extMap.get(c.sku_id);
    const pi: any = priceMap.get(c.sku_id);
    const sku: any = skuMap.get(c.sku_id);
    if (!pi) throw new PricerError('SKU_NOT_PRICED', `SKU ${c.sku_id} not in active price list`, { sku_id: c.sku_id });
    if (ext && ext.is_active === false) throw new PricerError('SKU_INACTIVE', `SKU ${c.sku_id} is inactive`, { sku_id: c.sku_id });
    if (c.qty <= 0) throw new PricerError('INVALID_QTY', `Qty must be > 0 for ${c.sku_id}`, { sku_id: c.sku_id });
    if (pi.min_qty && c.qty < pi.min_qty) throw new PricerError('BELOW_MIN_QTY', `Min qty for ${c.sku_id} is ${pi.min_qty}`, { sku_id: c.sku_id, min_qty: pi.min_qty });
    if (pi.max_qty && c.qty > pi.max_qty) throw new PricerError('ABOVE_MAX_QTY', `Max qty for ${c.sku_id} is ${pi.max_qty}`, { sku_id: c.sku_id, max_qty: pi.max_qty });

    const unit_price = Number(pi.base_price);
    const taxable = Math.round(unit_price * c.qty * 100) / 100;
    const taxOut = computeLineTax(
      { taxable_value: taxable, gst_rate: Number(ext?.gst_rate || 0), cess_rate: Number(ext?.cess_rate || 0) },
      intra,
    );

    return {
      sku_id: c.sku_id,
      sku_name: sku?.name || null,
      sku_code: sku?.code || null,
      hsn_code: ext?.hsn_code || null,
      qty: c.qty,
      uom: c.uom || ext?.uom || 'PCS',
      pack_size: ext?.pack_size || 1,
      unit_price,
      mrp: Number(ext?.mrp || 0),
      discount_pct: 0,
      discount_amt: 0,
      scheme_id: null,
      scheme_version: null,
      is_free_good: false,
      taxable_value: taxable,
      gst_rate: Number(ext?.gst_rate || 0),
      cgst: taxOut.cgst,
      sgst: taxOut.sgst,
      igst: taxOut.igst,
      cess: taxOut.cess,
      total: taxOut.total,
      price_list_version: priceList.version,
      line_no: idx + 1,
    };
  });

  const totals = summariseTotals(lines, { roundOff: true });
  return {
    lines,
    applied_schemes: [],
    totals,
    price_list_id: priceList.id,
    price_list_version: priceList.version,
    intra_state: intra,
    engine_version: ENGINE_VERSION,
  };
}

/**
 * Haversine in metres.
 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(a)));
}
