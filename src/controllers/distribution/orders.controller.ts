import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, forbidden, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { priceCart, haversineMeters, PricerError, CartLineInput } from '../../services/order-pricer';
import { applySchemes, SCHEME_ENGINE_VERSION } from '../../services/scheme-engine';
import { summariseTotals } from '../../services/tax';
import { getDemoOrder, getDemoOrderList } from '../../utils/demoDistribution';

const lineSchema = z.object({
  sku_id: z.string().uuid(),
  qty: z.number().int().positive(),
  uom: z.string().optional(),
});

const orderInputSchema = z.object({
  outlet_id: z.string().uuid(),
  distributor_id: z.string().uuid().optional(),
  visit_id: z.string().uuid().optional(),
  items: z.array(lineSchema).min(1).max(200),
  gps: z.object({ lat: z.number(), lng: z.number() }).optional(),
  notes: z.string().max(500).optional(),
  client_total: z.number().optional(),
});

// ── List + detail (admin/dashboard) ─────────────────────────────────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoOrderList());
  const status = req.query.status as string | undefined;
  const distributorId = req.query.distributor_id as string | undefined;
  const salesmanId = req.query.salesman_id as string | undefined;
  const outletId = req.query.outlet_id as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  let q = supabaseAdmin.from('orders')
    .select('*, order_items(*)')
    .eq('org_id', user.org_id)
    .order('placed_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit as string) || 50, 200));

  if (status) q = q.eq('status', status);
  if (distributorId) q = q.eq('distributor_id', distributorId);
  if (salesmanId) q = q.eq('salesman_id', salesmanId);
  if (outletId) q = q.eq('outlet_id', outletId);
  if (from) q = q.gte('placed_at', from);
  if (to) q = q.lte('placed_at', to);

  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoOrder());
  const { data, error } = await supabaseAdmin.from('orders')
    // Embed the seller (distributor) so the mobile "Print Bill" receipt can show
    // the company name + GSTIN on the header, not just the outlet.
    .select('*, order_items(*), distributor:distributor_id(name, gstin, address, state_code, place_of_supply)')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Order not found');
  ok(res, data);
});

// ── Approve ─────────────────────────────────────────────────────────────────
export const approve = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, status: 'approved' });
  const { data: before } = await supabaseAdmin.from('orders').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Order not found');
  if (before.status !== 'placed') return conflict(res, `Cannot approve from status=${before.status}`);
  // The read above already verified org membership, but a write without
  // .eq('org_id', ...) would race / be IDOR-vulnerable if a concurrent
  // request changed org assignment between the two queries. Re-scope.
  const { data, error } = await supabaseAdmin.from('orders')
    .update({ status: 'approved', approved_by: user.id, approved_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'order.approve', 'orders', data.id, before, data);
  ok(res, data, 'Order approved');
});

// ── Cancel ──────────────────────────────────────────────────────────────────
export const cancel = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, status: 'cancelled' });
  const reason = (req.body?.reason || '').toString().slice(0, 500);
  const { data: before } = await supabaseAdmin.from('orders').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Order not found');
  if (['invoiced', 'partially_invoiced', 'cancelled'].includes(before.status)) {
    return conflict(res, `Cannot cancel from status=${before.status}`);
  }
  // Salesman can cancel only their own placed orders.
  if (user.role === 'field_executive' && before.salesman_id !== user.id) {
    return forbidden(res, 'Cannot cancel another FE\'s order');
  }
  const { data, error } = await supabaseAdmin.from('orders')
    .update({ status: 'cancelled', cancelled_by: user.id, cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq('id', req.params.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'order.cancel', 'orders', data.id, before, data);
  ok(res, data, 'Order cancelled');
});

// ── Preview / Create (used by both salesman + dashboard) ────────────────────
// Exported so the distribution AI "Place in Orders" path can reuse the exact
// same outlet → distributor → customer_class/place_of_supply resolution the
// salesman order-create uses (no divergent pricing context).
export async function buildPriceContext(user: any, outletId: string, distributorId?: string) {
  const { data: outlet } = await supabaseAdmin.from('stores')
    .select('id, name, lat, lng, city_id')
    .eq('id', outletId).eq('org_id', user.org_id).maybeSingle();
  if (!outlet) throw new PricerError('OUTLET_NOT_FOUND', 'Outlet not found');

  const { data: ext } = await supabaseAdmin.from('outlet_distribution_ext')
    .select('*').eq('outlet_id', outletId).maybeSingle();

  const distId = distributorId || ext?.assigned_distributor_id;
  if (!distId) throw new PricerError('NO_DISTRIBUTOR', 'No distributor assigned to outlet');

  const { data: dist } = await supabaseAdmin.from('distributors')
    .select('id, state_code, place_of_supply, region, customer_class, is_active')
    .eq('id', distId).eq('org_id', user.org_id).maybeSingle();
  if (!dist) throw new PricerError('NO_DISTRIBUTOR', 'Distributor not found');
  if (dist.is_active === false) throw new PricerError('DIST_INACTIVE', 'Distributor is inactive');

  const customer_class = ext?.customer_class || dist.customer_class || 'GT';
  const place_of_supply = ext?.state_code || dist.place_of_supply || dist.state_code || null;

  return { outlet, ext, distributor: dist, customer_class, place_of_supply };
}

/**
 * Order-time credit surfacing. The hard block lives at invoice-issue (the ledger
 * DR post raises CREDIT_LIMIT_EXCEEDED); this is a *soft* signal computed from
 * the outlet's advisory `credit_limit`/`current_balance` (same fields
 * cart-suggest returns) so the cart can warn the rep BEFORE placing. Never
 * blocks placement. `status`: na (no limit set) | ok | warning (>=90% of limit)
 * | exceeded (projected over limit).
 */
export function computeCredit(ext: any, orderValue: number) {
  const rawLimit = ext?.credit_limit;
  const creditLimit = rawLimit != null && Number(rawLimit) > 0 ? Number(rawLimit) : null;
  const currentBalance = Number(ext?.current_balance || 0);
  const projected = Math.round((currentBalance + orderValue) * 100) / 100;
  if (creditLimit == null) {
    return {
      credit_limit: null, current_balance: currentBalance, order_value: orderValue,
      projected_balance: projected, available: null, utilization_pct: null,
      status: 'na' as const,
    };
  }
  const available = Math.round((creditLimit - currentBalance) * 100) / 100;
  let status: 'ok' | 'warning' | 'exceeded';
  if (projected > creditLimit) status = 'exceeded';
  else if (projected >= creditLimit * 0.9) status = 'warning';
  else status = 'ok';
  return {
    credit_limit: creditLimit, current_balance: currentBalance, order_value: orderValue,
    projected_balance: projected, available, utilization_pct: Math.round((projected / creditLimit) * 100),
    status,
  };
}

export const preview = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = orderInputSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) {
    const order = getDemoOrder();
    return ok(res, { lines: order.items, totals: { subtotal: order.subtotal, taxable_value: order.taxable_value, cgst: order.cgst, sgst: order.sgst, igst: order.igst, cess: order.cess, grand_total: order.grand_total, discount_total: order.discount_total, round_off: 0 }, applied_schemes: [], price_list_version: 1, intra_state: true, credit: computeCredit({ credit_limit: 50000, current_balance: 12000 }, order.grand_total) });
  }

  try {
    const ctx = await buildPriceContext(user, parsed.data.outlet_id, parsed.data.distributor_id);
    const items = parsed.data.items as CartLineInput[];
    const result = await priceCart(items, {
      org_id: user.org_id,
      client_id: user.client_id,
      customer_class: ctx.customer_class,
      region: ctx.distributor.region,
      distributor_state_code: ctx.distributor.state_code,
      outlet_state_code: ctx.ext?.state_code || null,
      place_of_supply: ctx.place_of_supply,
    });
    // Apply schemes (M3) then re-aggregate totals.
    const schemeOut = await applySchemes(result.lines, {
      org_id: user.org_id,
      customer_class: ctx.customer_class,
      date: new Date().toISOString().slice(0, 10),
      outlet_id: parsed.data.outlet_id,
      intra_state: result.intra_state,
      brand_ids: [],
    });
    const totals = summariseTotals(schemeOut.lines, { roundOff: true });
    const credit = computeCredit(ctx.ext, totals.grand_total);
    ok(res, { ...result, lines: schemeOut.lines, applied_schemes: schemeOut.applied, totals, scheme_total: schemeOut.scheme_total, credit });
  } catch (e: any) {
    if (e instanceof PricerError) return conflict(res, `${e.code}: ${e.message}`);
    throw e;
  }
});

// ── Browsable priced catalogue (order entry) ────────────────────────────────
// Resolves the outlet's active price list (same resolution as the pricer) and
// returns EVERY orderable SKU on it with price / MOQ / uom / mrp, so the cart
// (mobile browse-all, dashboard order entry) isn't limited to the reorder
// suggestions. Reads outlet_id from the route param (salesman) or ?outlet_id=
// (dashboard). Also returns the outlet credit context (order_value 0).
export const catalogue = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const outletId = (req.params.id || (req.query.outlet_id as string) || '').trim();
  if (!outletId) return badRequest(res, 'outlet_id required');
  if (isDemo(user)) return ok(res, { items: [], price_list_id: null, price_list_version: null, credit: computeCredit({ credit_limit: 50000, current_balance: 12000 }, 0) });

  try {
    const ctx = await buildPriceContext(user, outletId);
    const region = ctx.distributor.region || 'ALL';
    const { data: priceList } = await supabaseAdmin.from('price_lists').select('id, version')
      .eq('org_id', user.org_id)
      .eq('customer_class', ctx.customer_class)
      .or(`region.eq.${region},region.eq.ALL`)
      .eq('is_active', true)
      .order('region', { ascending: false })
      .order('version', { ascending: false })
      .limit(1).maybeSingle();

    const credit = computeCredit(ctx.ext, 0);
    if (!priceList) {
      return ok(res, { items: [], price_list_id: null, price_list_version: null, customer_class: ctx.customer_class, credit });
    }

    const { data: priceItems } = await supabaseAdmin.from('price_list_items')
      .select('sku_id, base_price, min_qty, max_qty').eq('price_list_id', priceList.id);
    const skuIds = (priceItems || []).map((p: any) => p.sku_id);
    const [{ data: prodExt }, { data: skuRows }] = await Promise.all([
      supabaseAdmin.from('product_distribution_ext')
        .select('sku_id, hsn_code, gst_rate, uom, pack_size, mrp, is_active').in('sku_id', skuIds),
      supabaseAdmin.from('skus').select('id, name, sku_code, category').in('id', skuIds),
    ]);
    const extMap = new Map((prodExt || []).map((p: any) => [p.sku_id, p]));
    const skuMap = new Map((skuRows || []).map((s: any) => [s.id, s]));

    const items = (priceItems || [])
      .filter((pi: any) => { const e: any = extMap.get(pi.sku_id); return !e || e.is_active !== false; })
      .map((pi: any) => {
        const e: any = extMap.get(pi.sku_id);
        const s: any = skuMap.get(pi.sku_id);
        return {
          sku_id: pi.sku_id,
          sku_name: s?.name || null,
          sku_code: s?.sku_code || null,
          category: s?.category || null,
          uom: e?.uom || 'PCS',
          pack_size: e?.pack_size || 1,
          mrp: Number(e?.mrp || 0),
          base_price: Number(pi.base_price),
          min_qty: pi.min_qty ?? null,
          max_qty: pi.max_qty ?? null,
          gst_rate: Number(e?.gst_rate || 0),
        };
      })
      .sort((a, b) =>
        (a.category || '').localeCompare(b.category || '') ||
        (a.sku_name || '').localeCompare(b.sku_name || ''));

    ok(res, { items, price_list_id: priceList.id, price_list_version: priceList.version, customer_class: ctx.customer_class, credit });
  } catch (e: any) {
    if (e instanceof PricerError) return conflict(res, `${e.code}: ${e.message}`);
    throw e;
  }
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = orderInputSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) {
    const order = getDemoOrder();
    return created(res, order, 'Order placed (Demo)');
  }

  let ctx; let priced; let schemeOut;
  try {
    ctx = await buildPriceContext(user, parsed.data.outlet_id, parsed.data.distributor_id);
    const items = parsed.data.items as CartLineInput[];
    priced = await priceCart(items, {
      org_id: user.org_id,
      client_id: user.client_id,
      customer_class: ctx.customer_class,
      region: ctx.distributor.region,
      distributor_state_code: ctx.distributor.state_code,
      outlet_state_code: ctx.ext?.state_code || null,
      place_of_supply: ctx.place_of_supply,
    });
    schemeOut = await applySchemes(priced.lines, {
      org_id: user.org_id,
      customer_class: ctx.customer_class,
      date: new Date().toISOString().slice(0, 10),
      outlet_id: parsed.data.outlet_id,
      intra_state: priced.intra_state,
      brand_ids: [],
    });
    // Replace pricer lines + recompute totals after scheme application.
    priced.lines = schemeOut.lines;
    priced.totals = summariseTotals(schemeOut.lines, { roundOff: true });
  } catch (e: any) {
    if (e instanceof PricerError) return conflict(res, `${e.code}: ${e.message}`);
    throw e;
  }

  // Anti-tamper: client total must match server within ₹0.01.
  if (typeof parsed.data.client_total === 'number') {
    if (Math.abs(parsed.data.client_total - priced.totals.grand_total) > 0.01) {
      return conflict(res, `PRICE_MISMATCH: server=${priced.totals.grand_total} client=${parsed.data.client_total}`);
    }
  }

  // Geofence check.
  let geofence_passed: boolean | null = null;
  let geofence_distance_m: number | null = null;
  if (parsed.data.gps && (ctx.outlet as any).lat && (ctx.outlet as any).lng) {
    const ext: any = ctx.ext;
    const radius = ext?.geofence_radius_m || 100;
    geofence_distance_m = haversineMeters(
      parsed.data.gps.lat, parsed.data.gps.lng,
      Number((ctx.outlet as any).lat), Number((ctx.outlet as any).lng),
    );
    geofence_passed = geofence_distance_m <= radius;
  }

  // Salesman caps.
  if (user.role === 'field_executive') {
    const { data: ext } = await supabaseAdmin.from('salesman_ext').select('*').eq('user_id', user.id).maybeSingle();
    if (ext) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      if (ext.single_order_cap_value > 0 && priced.totals.grand_total > Number(ext.single_order_cap_value)) {
        return forbidden(res, `Single order exceeds your cap of ₹${ext.single_order_cap_value}`);
      }
      if (ext.daily_order_cap_value > 0) {
        const { data: today } = await supabaseAdmin.from('orders')
          .select('grand_total').eq('salesman_id', user.id).eq('org_id', user.org_id)
          .gte('placed_at', todayStart.toISOString()).neq('status', 'cancelled');
        const used = (today || []).reduce((s: number, o: any) => s + Number(o.grand_total || 0), 0);
        if (used + priced.totals.grand_total > Number(ext.daily_order_cap_value)) {
          return forbidden(res, `Daily order cap (₹${ext.daily_order_cap_value}) exceeded`);
        }
      }
    }
  }

  // Generate order_no (date-stamped per org).
  const { data: orderNoRow } = await supabaseAdmin.rpc('gen_order_no', { p_org: user.org_id });
  const orderNo = orderNoRow || `ORD-${Date.now()}`;

  const idemKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

  const orderRow: any = {
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    order_no: orderNo,
    outlet_id: parsed.data.outlet_id,
    distributor_id: ctx.distributor.id,
    salesman_id: user.id,
    route_visit_id: parsed.data.visit_id ?? null,
    status: 'placed',
    placed_at: new Date().toISOString(),
    gps_lat: parsed.data.gps?.lat ?? null,
    gps_lng: parsed.data.gps?.lng ?? null,
    geofence_passed,
    geofence_distance_m,
    device_meta: { user_agent: req.headers['user-agent'] || null },
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
    notes: parsed.data.notes ?? null,
    idempotency_key: idemKey ?? null,
    created_by: user.id,
  };

  const { data: order, error } = await supabaseAdmin.from('orders').insert(orderRow).select().single();
  if (error) {
    if (error.code === '23505') return conflict(res, 'Duplicate order (idempotency or order_no)');
    return badRequest(res, error.message);
  }

  const itemRows = priced.lines.map((l) => ({
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
  if (itemsErr) return badRequest(res, itemsErr.message);

  // Persist scheme application proof (one row per applied scheme).
  if (schemeOut.applied.length) {
    await supabaseAdmin.from('scheme_application_log').insert(
      schemeOut.applied.map((a) => ({
        org_id: user.org_id,
        order_id: order.id,
        scheme_id: a.scheme_id,
        scheme_version: a.scheme_version,
        engine_version: SCHEME_ENGINE_VERSION,
        inputs: a.inputs,
        outputs: a.outputs,
      }))
    );
  }

  await audit(req, 'order.create', 'orders', order.id, null, { ...order, items_count: itemRows.length });

  const { data: full } = await supabaseAdmin.from('orders')
    .select('*, order_items(*)').eq('id', order.id).single();
  created(res, full, 'Order placed');
});
