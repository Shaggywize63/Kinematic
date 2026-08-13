// ═══════════════════════════════════════════════════════════
// src/services/distribution/orderPlacement.service.ts
//
// "Place in Orders" handoff for the distribution AI layer. Turns a reviewed
// replenishment DRAFT (a per-distributor plan: SKU + suggested qty) into a REAL
// order for one chosen outlet, priced through the SAME engine the salesman
// order-create uses — buildPriceContext → priceCart → applySchemes →
// summariseTotals — so GST / schemes / totals are identical, never re-derived.
//
// The salesman order-create in orders.controller stays the untouched hot path;
// this mirrors its insert shape (kept in sync deliberately) for an admin-placed
// order (no salesman, no geofence, no caps).
// ═══════════════════════════════════════════════════════════
import { supabaseAdmin } from '../../lib/supabase';
import { buildPriceContext } from '../../controllers/distribution/orders.controller';
import { priceCart, CartLineInput } from '../../services/order-pricer';
import { applySchemes, SCHEME_ENGINE_VERSION } from '../../services/scheme-engine';
import { summariseTotals } from '../../services/tax';

export type PlaceItem = { sku_id: string; qty: number };

// Outlets served by a distributor — the candidate targets a draft can be placed
// against. Org-scoped, active only.
export async function listOutletsForDistributor(
  org_id: string,
  distributor_id: string,
): Promise<Array<{ id: string; name: string }>> {
  const { data: ext } = await supabaseAdmin
    .from('outlet_distribution_ext')
    .select('outlet_id')
    .eq('assigned_distributor_id', distributor_id)
    .limit(2000);
  const outletIds = Array.from(new Set(((ext as any[]) || []).map((r) => r.outlet_id).filter(Boolean)));
  if (!outletIds.length) return [];

  const { data: stores } = await supabaseAdmin
    .from('stores')
    .select('id, name')
    .eq('org_id', org_id)
    .eq('is_active', true)
    .in('id', outletIds)
    .order('name', { ascending: true })
    .limit(2000);
  return ((stores as any[]) || []).map((s) => ({ id: s.id, name: s.name || 'Outlet' }));
}

/**
 * Price the draft's items for `outlet_id` and insert a real order (status
 * 'placed'). Returns the created order joined with its items. Throws PricerError
 * (from buildPriceContext / priceCart) on a resolution/pricing failure, or a
 * plain Error on a DB failure — the caller maps these to HTTP responses.
 */
export async function placeDraftOrder(
  user: { id: string; org_id: string; client_id?: string | null },
  draft: { id: string; distributor_id: string | null; items: PlaceItem[] },
  outlet_id: string,
): Promise<any> {
  const items: CartLineInput[] = (draft.items || [])
    .filter((i) => i && i.sku_id && Number(i.qty) > 0)
    .map((i) => ({ sku_id: i.sku_id, qty: Math.round(Number(i.qty)) } as CartLineInput));
  if (!items.length) throw new Error('Draft has no orderable lines.');

  const ctx = await buildPriceContext(user, outlet_id, draft.distributor_id || undefined);

  const priced: any = await priceCart(items, {
    org_id: user.org_id,
    client_id: user.client_id,
    customer_class: ctx.customer_class,
    region: ctx.distributor.region,
    distributor_state_code: ctx.distributor.state_code,
    outlet_state_code: ctx.ext?.state_code || null,
    place_of_supply: ctx.place_of_supply,
  });
  const schemeOut = await applySchemes(priced.lines, {
    org_id: user.org_id,
    customer_class: ctx.customer_class,
    date: new Date().toISOString().slice(0, 10),
    outlet_id,
    intra_state: priced.intra_state,
    brand_ids: [],
  });
  priced.lines = schemeOut.lines;
  priced.totals = summariseTotals(schemeOut.lines, { roundOff: true });

  const { data: orderNoRow } = await supabaseAdmin.rpc('gen_order_no', { p_org: user.org_id });
  const orderNo = orderNoRow || `ORD-${draft.id.slice(0, 8)}`;

  // Mirror of orders.controller.create's insert shape, minus the salesman-app
  // fields (geofence/device/route/idempotency) — admin places from a plan.
  const orderRow: any = {
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    order_no: orderNo,
    outlet_id,
    distributor_id: ctx.distributor.id,
    salesman_id: null,
    status: 'placed',
    placed_at: new Date().toISOString(),
    price_list_id: priced.price_list_id,
    price_list_version: priced.price_list_version,
    customer_class: ctx.customer_class,
    place_of_supply: ctx.place_of_supply,
    is_reverse_charge: false,
    subtotal: priced.totals.subtotal,
    discount_total: priced.totals.discount_total,
    scheme_total: schemeOut.scheme_total,
    taxable_value: priced.totals.taxable_value,
    cgst: priced.totals.cgst,
    sgst: priced.totals.sgst,
    igst: priced.totals.igst,
    cess: priced.totals.cess,
    round_off: priced.totals.round_off,
    grand_total: priced.totals.grand_total,
    notes: `Placed from replenishment draft ${draft.id}`,
    created_by: user.id,
  };

  const { data: order, error } = await supabaseAdmin.from('orders').insert(orderRow).select().single();
  if (error) throw new Error(error.message);

  const itemRows = priced.lines.map((l: any) => ({
    order_id: order.id,
    sku_id: l.sku_id,
    sku_name: l.sku_name,
    sku_code: l.sku_code,
    hsn_code: l.hsn_code,
    qty: l.qty,
    uom: l.uom,
    pack_size: l.pack_size,
    unit_price: l.unit_price,
    mrp: l.mrp,
    discount_pct: l.discount_pct,
    discount_amt: l.discount_amt,
    scheme_id: l.scheme_id,
    scheme_version: l.scheme_version,
    is_free_good: l.is_free_good,
    taxable_value: l.taxable_value,
    gst_rate: l.gst_rate,
    cgst: l.cgst,
    sgst: l.sgst,
    igst: l.igst,
    cess: l.cess,
    total: l.total,
    price_list_version: l.price_list_version,
    line_no: l.line_no,
  }));
  const { error: itemsErr } = await supabaseAdmin.from('order_items').insert(itemRows);
  if (itemsErr) throw new Error(itemsErr.message);

  if (schemeOut.applied.length) {
    await supabaseAdmin.from('scheme_application_log').insert(
      schemeOut.applied.map((a: any) => ({
        org_id: user.org_id,
        order_id: order.id,
        scheme_id: a.scheme_id,
        scheme_version: a.scheme_version,
        engine_version: SCHEME_ENGINE_VERSION,
        inputs: a.inputs,
        outputs: a.outputs,
      })),
    );
  }

  const { data: full } = await supabaseAdmin.from('orders')
    .select('*, order_items(*)').eq('id', order.id).single();
  return full || order;
}
