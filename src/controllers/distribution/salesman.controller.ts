import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, notFound, isDemo, isUUID, dbToday, sanitisePostgrestSearch } from '../../utils';
import { haversineMeters } from '../../services/order-pricer';
import {
  getDemoCartSuggest, getDemoRouteToday, getDemoOrderList, getDemoSalesmanOutlets, getDemoOutletOutstanding,
} from '../../utils/demoDistribution';
import { getClientScope } from '../../lib/tenancy';
import {
  loadOutletInvoiceBalances, loadLedgerBalance, openInvoices, resolveOutstandingBalance, round2,
} from '../../services/distribution/collections.service';

// ── GET /api/v1/salesman/route/today ────────────────────────────────────────
export const routeToday = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoRouteToday());
  const today = new Date().toISOString().slice(0, 10);

  // Today's route plan + assigned outlets + outstanding balance + last order.
  // route_plans stores the day in `plan_date` (not `date`); filtering the
  // wrong column made PostgREST error and the endpoint silently returned an
  // empty route ("Route plan is empty") for every rep.
  const { data: rp } = await supabaseAdmin.from('route_plans')
    .select('*, route_plan_outlets(*, stores!store_id(id, name, address, lat, lng))')
    .eq('user_id', user.id).eq('plan_date', today).maybeSingle();

  const outlets = (rp?.route_plan_outlets || []).map((rpo: any) => {
    const s = rpo.stores || {};
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      route_visit_id: rpo.id,
      status: rpo.status || 'pending',
      sequence: rpo.visit_order || 0,   // column is visit_order, not sequence
    };
  });

  // Hydrate balances + last orders.
  if (outlets.length) {
    const ids = outlets.map((o: any) => o.id);
    const [{ data: exts }, { data: lastOrders }] = await Promise.all([
      supabaseAdmin.from('outlet_distribution_ext')
        .select('outlet_id, current_balance, credit_limit, geofence_radius_m').in('outlet_id', ids),
      supabaseAdmin.from('orders')
        .select('outlet_id, placed_at, grand_total')
        .in('outlet_id', ids).eq('org_id', user.org_id)
        .order('placed_at', { ascending: false }).limit(50),
    ]);
    const extMap = new Map((exts || []).map((e: any) => [e.outlet_id, e]));
    const lastMap = new Map<string, any>();
    for (const o of (lastOrders || [])) {
      if (!lastMap.has(o.outlet_id)) lastMap.set(o.outlet_id, o);
    }
    for (const o of outlets as any[]) {
      const e = extMap.get(o.id) as any;
      o.current_balance = e?.current_balance || 0;
      o.credit_limit = e?.credit_limit || 0;
      o.geofence_radius_m = e?.geofence_radius_m || 100;
      const last = lastMap.get(o.id);
      o.last_order_at = last?.placed_at || null;
      o.last_order_value = last?.grand_total || 0;
    }
  }

  ok(res, { date: today, outlets });
});

// ── POST /api/v1/salesman/visits/:visitId/checkin ───────────────────────────
export const visitCheckin = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return badRequest(res, 'lat and lng required');
  if (isDemo(user)) return ok(res, { geofence_passed: true, distance_m: 12 });

  const { data: rpo } = await supabaseAdmin.from('route_plan_outlets')
    .select('id, store_id, stores!store_id(lat, lng)').eq('id', req.params.visitId).maybeSingle();
  if (!rpo) return badRequest(res, 'Visit not found');
  const store: any = rpo.stores;
  if (!store?.lat || !store?.lng) return ok(res, { geofence_passed: null, distance_m: null });

  const { data: ext } = await supabaseAdmin.from('outlet_distribution_ext')
    .select('geofence_radius_m').eq('outlet_id', rpo.store_id).maybeSingle();
  const radius = ext?.geofence_radius_m || 100;
  const distance_m = haversineMeters(lat, lng, Number(store.lat), Number(store.lng));
  const geofence_passed = distance_m <= radius;
  ok(res, { geofence_passed, distance_m, radius_m: radius });
});

// ── GET /api/v1/salesman/outlets/:id/cart-suggest ───────────────────────────
export const cartSuggest = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoCartSuggest());
  const outletId = req.params.id;

  const [{ data: outlet }, { data: ext }, { data: lastOrders }] = await Promise.all([
    supabaseAdmin.from('stores').select('id, name, lat, lng').eq('id', outletId).maybeSingle(),
    supabaseAdmin.from('outlet_distribution_ext')
      .select('current_balance, credit_limit, customer_class').eq('outlet_id', outletId).maybeSingle(),
    supabaseAdmin.from('orders')
      // Full order shape + order_items(*) so the mobile DistOrder/PricedLine
      // decoder (which needs every line field) can parse last_orders; a narrow
      // embed here silently failed the same way the salesman order list did.
      .select('*, order_items(*)')
      .eq('outlet_id', outletId).eq('org_id', user.org_id)
      .order('placed_at', { ascending: false }).limit(3),
  ]);

  // Recommendations: union of last-order SKUs sorted by frequency.
  const counts = new Map<string, { sku_id: string; sku_name: string | null; mrp: number; qty: number }>();
  for (const o of (lastOrders || [])) {
    for (const it of (o.order_items || [])) {
      const prev = counts.get(it.sku_id) || { sku_id: it.sku_id, sku_name: it.sku_name, mrp: it.mrp, qty: 0 };
      prev.qty += it.qty;
      counts.set(it.sku_id, prev);
    }
  }
  const recommendations = Array.from(counts.values())
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8)
    .map((r) => ({ sku_id: r.sku_id, sku_name: r.sku_name, mrp: r.mrp, suggested_qty: Math.max(1, Math.round(r.qty / Math.max(1, (lastOrders || []).length))), reason: 'Reorder' }));

  ok(res, {
    outlet: { id: outlet?.id, name: outlet?.name, current_balance: ext?.current_balance || 0, credit_limit: ext?.credit_limit || 0 },
    last_orders: lastOrders || [],
    recommendations,
  });
});

// ── GET /api/v1/salesman/orders ─────────────────────────────────────────────
export const myOrders = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoOrderList());
  const status = req.query.status as string | undefined;
  let q = supabaseAdmin.from('orders')
    // Return the FULL order_items shape. The mobile DistOrder/PricedLine decoder
    // requires the complete line (uom, unit_price, mrp, taxable_value, gst_rate,
    // cgst/sgst/igst/cess, …); a narrow embed omitted those keys and made the
    // strict Swift decoder throw on the nested array, so the whole list silently
    // decoded to empty ("No orders yet.") even though the rows exist. The admin
    // list + order-detail endpoints already select order_items(*), so this just
    // brings the salesman list to parity.
    .select('*, order_items(*)')
    .eq('org_id', user.org_id).eq('salesman_id', user.id)
    .order('placed_at', { ascending: false }).limit(50);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

// ── GET /api/v1/salesman/outlets?search=&limit=50 ───────────────────────────
// The rep's outlet picker for collections: every active outlet in the caller's
// org + client (strict client scope: JWT client_id, else the X-Client-Id picker),
// searchable by name / outlet code, with the assigned distributor and the
// outlet's ledger balance. Outlets on the rep's route plan for TODAY (IST) come
// first (in visit order), then the rest by name. limit: default 50, max 100.
//
// Tables/columns: stores(id,name,store_code,address,phone,city_id,is_active,
// org_id,client_id) + cities(name) via city_id; outlet_distribution_ext
// (outlet_id,assigned_distributor_id,current_balance — the ledger mirror kept
// by post_ledger_entry); distributors(id,name); route_plans(user_id,
// plan_date) -> route_plan_outlets(store_id,visit_order).
export const myOutlets = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoSalesmanOutlets());

  const scope = getClientScope(req);
  const search = sanitisePostgrestSearch(req.query.search);
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));

  const STORE_COLS = 'id, name, store_code, address, phone, city_id, cities!city_id(name)';
  const scoped = (q: any) => {
    let r = q.eq('org_id', user.org_id).eq('is_active', true);
    if (scope.id) r = r.eq('client_id', scope.id);
    if (search) r = r.or(`name.ilike.%${search}%,store_code.ilike.%${search}%`);
    return r;
  };

  // Today's planned outlets for this rep, in visit order (several plans/day are allowed).
  const { data: plans, error: planErr } = await supabaseAdmin.from('route_plans')
    .select('id, route_plan_outlets(store_id, visit_order)')
    // Keyed on the rep (JWT user id) + IST date, exactly like routeToday; the stores query
    // below is what enforces org/client isolation, so a plan can never widen the result set.
    .eq('user_id', user.id).eq('plan_date', dbToday());
  if (planErr) return badRequest(res, planErr.message);
  const plannedOrder: string[] = [];
  const seen = new Set<string>();
  const planned = ((plans as any[]) || [])
    .flatMap((p) => (p.route_plan_outlets as any[]) || [])
    .filter((o) => o?.store_id)
    .sort((a, b) => (a.visit_order ?? 0) - (b.visit_order ?? 0));
  for (const o of planned) {
    if (!seen.has(o.store_id)) { seen.add(o.store_id); plannedOrder.push(o.store_id); }
  }

  let stores: any[] = [];
  if (plannedOrder.length) {
    const ids = plannedOrder.slice(0, 300);
    const { data, error } = await scoped(supabaseAdmin.from('stores').select(STORE_COLS).in('id', ids));
    if (error) return badRequest(res, error.message);
    const rank = new Map(ids.map((id, i) => [id, i]));
    stores = ((data as any[]) || []).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)).slice(0, limit);
  }
  if (stores.length < limit) {
    let q = scoped(supabaseAdmin.from('stores').select(STORE_COLS)).order('name', { ascending: true });
    if (plannedOrder.length) q = q.not('id', 'in', `(${plannedOrder.slice(0, 300).join(',')})`);
    const { data, error } = await q.limit(limit - stores.length);
    if (error) return badRequest(res, error.message);
    const have = new Set(stores.map((x) => x.id));
    stores = stores.concat(((data as any[]) || []).filter((x) => !have.has(x.id)));
  }

  const ids = stores.map((s) => s.id);
  const extMap = new Map<string, any>();
  const distMap = new Map<string, string>();
  if (ids.length) {
    const { data: exts } = await supabaseAdmin.from('outlet_distribution_ext')
      .select('outlet_id, assigned_distributor_id, current_balance').in('outlet_id', ids);
    for (const e of (exts as any[]) || []) extMap.set(e.outlet_id, e);
    const distIds = [...new Set(((exts as any[]) || []).map((e) => e.assigned_distributor_id).filter(Boolean))];
    if (distIds.length) {
      const { data: dists } = await supabaseAdmin.from('distributors')
        .select('id, name').eq('org_id', user.org_id).in('id', distIds as string[]);
      for (const d of (dists as any[]) || []) distMap.set(d.id, d.name);
    }
  }

  ok(res, stores.map((s) => {
    const e = extMap.get(s.id);
    const distId: string | null = e?.assigned_distributor_id ?? null;
    return {
      id: s.id,
      name: s.name,
      code: s.store_code ?? null,
      address: s.address ?? null,
      city: (Array.isArray(s.cities) ? s.cities[0]?.name : s.cities?.name) ?? null,
      phone: s.phone ?? null,
      distributor_id: distId,
      distributor_name: distId ? distMap.get(distId) ?? null : null,
      outstanding_balance: round2(Number(e?.current_balance) || 0),
    };
  }));
});

// ── GET /api/v1/salesman/outlets/:outletId/outstanding ──────────────────────
// What does this outlet owe, and against which bills. `paid` per invoice is
// DERIVED from payments.applied_to_invoices (cleared + pending payments only —
// bounced/cancelled never count); invoices are never mutated. `balance` is the
// outlet's latest ledger running balance when it has ledger rows, else the sum
// of the open invoice balances. Only invoices with balance > 0 are listed,
// oldest first. credit_limit is null when no limit is configured (0 / no row).
//
// Tables/columns: stores(id,name,org_id,client_id); invoices(id,invoice_no,
// outlet_id,distributor_id,grand_total,issued_at,status,org_id);
// payments(outlet_id,status,applied_to_invoices,org_id);
// ledger_entries(outlet_id,org_id,running_balance,posted_at);
// outlet_distribution_ext(credit_limit); distributors(payment_terms_days).
export const outletOutstanding = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const outletId = String(req.params.outletId || '').trim();
  if (isDemo(user)) return ok(res, getDemoOutletOutstanding(outletId));
  if (!isUUID(outletId)) return badRequest(res, 'Invalid outlet id');

  const scope = getClientScope(req);
  let oq = supabaseAdmin.from('stores').select('id, name').eq('id', outletId).eq('org_id', user.org_id);
  if (scope.id) oq = oq.eq('client_id', scope.id);
  const { data: outlet } = await oq.maybeSingle();
  if (!outlet) return notFound(res, 'Outlet not found');

  let balances;
  try {
    balances = await loadOutletInvoiceBalances(user.org_id, outletId);
  } catch (e: any) {
    return badRequest(res, e.message);
  }
  const open = openInvoices(balances);
  const [ledgerBalance, { data: ext }] = await Promise.all([
    loadLedgerBalance(user.org_id, outletId),
    supabaseAdmin.from('outlet_distribution_ext').select('credit_limit').eq('outlet_id', outletId).maybeSingle(),
  ]);
  const limit = ext?.credit_limit != null && Number(ext.credit_limit) > 0 ? Number(ext.credit_limit) : null;

  ok(res, {
    outlet_id: outlet.id,
    outlet_name: outlet.name,
    balance: resolveOutstandingBalance(ledgerBalance, open),
    credit_limit: limit,
    open_invoices: open.map((b) => ({
      invoice_id: b.invoice_id,
      invoice_no: b.invoice_no,
      invoice_date: b.invoice_date,
      due_date: b.due_date,
      total: b.total,
      paid: b.paid,
      balance: b.balance,
    })),
  });
});
