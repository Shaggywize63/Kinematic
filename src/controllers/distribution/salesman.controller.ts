import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, isDemo } from '../../utils';
import { haversineMeters } from '../../services/order-pricer';
import { getDemoCartSuggest, getDemoRouteToday, getDemoOrderList } from '../../utils/demoDistribution';

// ── GET /api/v1/salesman/route/today ────────────────────────────────────────
export const routeToday = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoRouteToday());
  const today = new Date().toISOString().slice(0, 10);

  // Today's route plan + assigned outlets + outstanding balance + last order.
  const { data: rp } = await supabaseAdmin.from('route_plans')
    .select('*, route_plan_outlets(*, stores!store_id(id, name, address, latitude, longitude, state))')
    .eq('user_id', user.id).eq('date', today).maybeSingle();

  const outlets = (rp?.route_plan_outlets || []).map((rpo: any) => {
    const s = rpo.stores || {};
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      lat: s.latitude,
      lng: s.longitude,
      route_visit_id: rpo.id,
      status: rpo.status || 'pending',
      sequence: rpo.sequence || 0,
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
    .select('id, store_id, stores!store_id(latitude, longitude)').eq('id', req.params.visitId).maybeSingle();
  if (!rpo) return badRequest(res, 'Visit not found');
  const store: any = rpo.stores;
  if (!store?.latitude || !store?.longitude) return ok(res, { geofence_passed: null, distance_m: null });

  const { data: ext } = await supabaseAdmin.from('outlet_distribution_ext')
    .select('geofence_radius_m').eq('outlet_id', rpo.store_id).maybeSingle();
  const radius = ext?.geofence_radius_m || 100;
  const distance_m = haversineMeters(lat, lng, Number(store.latitude), Number(store.longitude));
  const geofence_passed = distance_m <= radius;
  ok(res, { geofence_passed, distance_m, radius_m: radius });
});

// ── GET /api/v1/salesman/outlets/:id/cart-suggest ───────────────────────────
export const cartSuggest = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoCartSuggest());
  const outletId = req.params.id;

  const [{ data: outlet }, { data: ext }, { data: lastOrders }] = await Promise.all([
    supabaseAdmin.from('stores').select('id, name, latitude, longitude').eq('id', outletId).maybeSingle(),
    supabaseAdmin.from('outlet_distribution_ext')
      .select('current_balance, credit_limit, customer_class').eq('outlet_id', outletId).maybeSingle(),
    supabaseAdmin.from('orders')
      .select('id, order_no, placed_at, grand_total, order_items(sku_id, qty, sku_name, mrp)')
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
    .select('*, order_items(id, sku_id, sku_name, qty, total)')
    .eq('org_id', user.org_id).eq('salesman_id', user.id)
    .order('placed_at', { ascending: false }).limit(50);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});
