// ═══════════════════════════════════════════════════════════
// src/controllers/distribution/reports.controller.ts
//
// PMC DELTA distribution reports:
//   1. Default Godown report        GET /distribution/reports/godown
//   2. Quarterly Shop×SKU targets   GET /distribution/reports/targets
//   3. Daily Salesman Challan (DSR) GET /distribution/reports/dsr
//
// All are org-scoped (multi-tenant) and derive their numbers from real rows
// (inventory_movements / invoices / stock_items / payments) so the demo data
// and the reports always agree.
// ═══════════════════════════════════════════════════════════
import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, notFound, isDemo } from '../../utils';

const num = (v: any) => Number(v || 0);

// Q3-2026 → { start: '2026-07-01', end: '2026-10-01' } (end exclusive)
function quarterRange(q: string): { start: string; end: string; label: string } {
  const m = /^Q([1-4])-(\d{4})$/.exec((q || '').trim());
  const now = new Date();
  const qq = m ? Number(m[1]) : Math.floor(now.getUTCMonth() / 3) + 1;
  const yr = m ? Number(m[2]) : now.getUTCFullYear();
  const startMonth = (qq - 1) * 3;
  const start = new Date(Date.UTC(yr, startMonth, 1));
  const end = new Date(Date.UTC(yr, startMonth + 3, 1));
  return { start: start.toISOString(), end: end.toISOString(), label: `Q${qq}-${yr}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Default Godown report — movement ledger rolled up per SKU.
//    Product Add Date / Received Qty / Issued Date / Issued Qty / Current Balance
// ─────────────────────────────────────────────────────────────────────────────
export const godownReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { warehouse: null, rows: [], summary: {} });

  const warehouseId = req.query.warehouse_id as string | undefined;

  let wq = supabaseAdmin
    .from('inventory_movements')
    .select('sku_id, movement_type, quantity, moved_at')
    .eq('org_id', org_id);
  if (warehouseId) wq = wq.eq('warehouse_id', warehouseId);
  const { data: moves, error } = await wq;
  if (error) return badRequest(res, error.message);

  const skuIds = Array.from(new Set((moves || []).map((m) => m.sku_id).filter(Boolean)));
  const { data: skus } = skuIds.length
    ? await supabaseAdmin
        .from('skus')
        .select('id, sku_code, name, category, unit')
        .in('id', skuIds)
    : { data: [] as any[] };
  const skuMap: Record<string, any> = {};
  (skus || []).forEach((s) => { skuMap[s.id] = s; });

  type Agg = {
    received: number; issued: number; adjustment: number;
    addDate: string | null; lastIssued: string | null; lastUpdated: string | null;
  };
  const agg: Record<string, Agg> = {};
  (moves || []).forEach((m) => {
    const a = (agg[m.sku_id] ||= { received: 0, issued: 0, adjustment: 0, addDate: null, lastIssued: null, lastUpdated: null });
    const q = num(m.quantity);
    if (m.movement_type === 'in') {
      a.received += q;
      if (!a.addDate || m.moved_at < a.addDate) a.addDate = m.moved_at;
    } else if (m.movement_type === 'out') {
      a.issued += Math.abs(q);
      if (!a.lastIssued || m.moved_at > a.lastIssued) a.lastIssued = m.moved_at;
    } else {
      a.adjustment += q; // signed
    }
    if (!a.lastUpdated || m.moved_at > a.lastUpdated) a.lastUpdated = m.moved_at;
  });

  const rows = Object.entries(agg).map(([skuId, a]) => {
    const s = skuMap[skuId] || {};
    return {
      sku_id: skuId,
      product_code: s.sku_code || null,
      product_name: s.name || null,
      category: s.category || null,
      unit: s.unit || null,
      product_add_date: a.addDate,
      received_qty: a.received,
      issued_date: a.lastIssued,
      issued_qty: a.issued,
      adjustment_qty: a.adjustment,
      current_balance: a.received - a.issued + a.adjustment,
      last_updated: a.lastUpdated,
    };
  }).sort((x, y) => (x.product_code || '').localeCompare(y.product_code || ''));

  const summary = {
    total_received: rows.reduce((n, r) => n + r.received_qty, 0),
    total_issued: rows.reduce((n, r) => n + r.issued_qty, 0),
    current_available: rows.reduce((n, r) => n + r.current_balance, 0),
    sku_count: rows.length,
  };

  ok(res, { rows, summary });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Quarterly Shop×SKU Target report. Target qty is stored; sold qty is derived
//    from the invoices in the quarter (Salesman / Beat / Shop / Product / …).
// ─────────────────────────────────────────────────────────────────────────────
export const targetReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { quarter: null, rows: [], summary: {} });

  const { start, end, label } = quarterRange(req.query.quarter as string);

  const { data: targets, error } = await supabaseAdmin
    .from('sales_targets')
    .select('*')
    .eq('org_id', org_id)
    .eq('quarter', label);
  if (error) return badRequest(res, error.message);
  if (!targets || !targets.length) return ok(res, { quarter: label, rows: [], summary: { total: 0, pending: 0, achieved: 0, exceeded: 0 } });

  // Actual sold qty per (outlet, sku) from invoices in the quarter.
  const { data: invs } = await supabaseAdmin
    .from('invoices')
    .select('outlet_id, issued_at, invoice_items(sku_id, qty)')
    .eq('org_id', org_id)
    .gte('issued_at', start)
    .lt('issued_at', end)
    .neq('status', 'cancelled');
  const sold: Record<string, number> = {};
  (invs || []).forEach((inv: any) => {
    (inv.invoice_items || []).forEach((it: any) => {
      const key = `${inv.outlet_id}|${it.sku_id}`;
      sold[key] = (sold[key] || 0) + num(it.qty);
    });
  });

  // Lookup maps for names / beat.
  const storeIds = Array.from(new Set(targets.map((t) => t.store_id)));
  const skuIds = Array.from(new Set(targets.map((t) => t.sku_id)));
  const manIds = Array.from(new Set(targets.map((t) => t.salesman_id).filter(Boolean)));
  const [{ data: stores }, { data: skus }, { data: users }] = await Promise.all([
    supabaseAdmin.from('stores').select('id, name, store_code, zone_id').in('id', storeIds),
    supabaseAdmin.from('skus').select('id, name, sku_code').in('id', skuIds),
    manIds.length ? supabaseAdmin.from('users').select('id, name').in('id', manIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const zoneIds = Array.from(new Set((stores || []).map((s: any) => s.zone_id).filter(Boolean)));
  const { data: zones } = zoneIds.length
    ? await supabaseAdmin.from('zones').select('id, name').in('id', zoneIds)
    : { data: [] as any[] };
  const storeMap: Record<string, any> = {}; (stores || []).forEach((s: any) => (storeMap[s.id] = s));
  const skuMap: Record<string, any> = {}; (skus || []).forEach((s: any) => (skuMap[s.id] = s));
  const userMap: Record<string, any> = {}; (users || []).forEach((u: any) => (userMap[u.id] = u));
  const zoneMap: Record<string, any> = {}; (zones || []).forEach((z: any) => (zoneMap[z.id] = z));

  const rows = targets.map((t) => {
    const soldQty = sold[`${t.store_id}|${t.sku_id}`] || 0;
    const target = num(t.target_qty);
    const balance = target - soldQty;
    const achievement = target > 0 ? Math.round((soldQty / target) * 10000) / 100 : 0;
    const status = soldQty > target ? 'Exceeded' : soldQty === target ? 'Achieved' : 'Pending';
    const store = storeMap[t.store_id] || {};
    return {
      salesman: t.salesman_id ? (userMap[t.salesman_id]?.name || '—') : '—',
      beat: store.zone_id ? (zoneMap[store.zone_id]?.name || '—') : '—',
      shop_name: store.name || '—',
      shop_code: store.store_code || null,
      quarter: t.quarter,
      product: skuMap[t.sku_id]?.name || '—',
      product_code: skuMap[t.sku_id]?.sku_code || null,
      target_qty: target,
      sold_qty: soldQty,
      balance_qty: balance,
      achievement_pct: achievement,
      status,
    };
  }).sort((a, b) => a.salesman.localeCompare(b.salesman) || a.shop_name.localeCompare(b.shop_name));

  const summary = {
    total: rows.length,
    pending: rows.filter((r) => r.status === 'Pending').length,
    achieved: rows.filter((r) => r.status === 'Achieved').length,
    exceeded: rows.filter((r) => r.status === 'Exceeded').length,
  };

  ok(res, { quarter: label, rows, summary });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Daily Salesman Challan / Beat Sales Report (EOD).
//    List mode:  GET /distribution/reports/dsr           → available challans
//    Detail mode: GET /distribution/reports/dsr?salesman_id=&date=
// ─────────────────────────────────────────────────────────────────────────────
export const dsrReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { challans: [] });

  const salesmanId = req.query.salesman_id as string | undefined;
  const date = req.query.date as string | undefined;

  // ── List mode ──────────────────────────────────────────────────────────────
  if (!salesmanId || !date) {
    const { data: challans, error } = await supabaseAdmin
      .from('dsr_challans')
      .select('id, salesman_id, report_date, challan_no, route_label, beat_area, shops_visited')
      .eq('org_id', org_id)
      .order('report_date', { ascending: false });
    if (error) return badRequest(res, error.message);
    const ids = Array.from(new Set((challans || []).map((c) => c.salesman_id)));
    const { data: users } = ids.length
      ? await supabaseAdmin.from('users').select('id, name').in('id', ids)
      : { data: [] as any[] };
    const nameMap: Record<string, string> = {}; (users || []).forEach((u: any) => (nameMap[u.id] = u.name));
    return ok(res, {
      challans: (challans || []).map((c) => ({ ...c, salesman_name: nameMap[c.salesman_id] || '—' })),
    });
  }

  // ── Detail mode ──────────────────────────────────────────────────────────────
  const { data: challan } = await supabaseAdmin
    .from('dsr_challans')
    .select('*')
    .eq('org_id', org_id)
    .eq('salesman_id', salesmanId)
    .eq('report_date', date)
    .maybeSingle();
  if (!challan) return notFound(res, 'No challan for this salesman/date');

  const { data: salesman } = await supabaseAdmin.from('users').select('id, name, employee_id').eq('id', salesmanId).maybeSingle();

  const dayStart = new Date(`${date}T00:00:00.000Z`).toISOString();
  const dayEnd = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 86400000).toISOString();

  // Van load-out (product-wise issued / sold / returned / closing).
  const { data: alloc } = await supabaseAdmin
    .from('stock_allocations')
    .select('id')
    .eq('org_id', org_id).eq('user_id', salesmanId).eq('date', date)
    .maybeSingle();
  const { data: items } = alloc
    ? await supabaseAdmin.from('stock_items').select('*').eq('allocation_id', alloc.id)
    : { data: [] as any[] };
  const productRows = (items || []).map((it: any) => {
    const issued = num(it.quantity_allocated);
    const soldQ = num(it.quantity_consumed);
    const returned = Math.max(0, issued - soldQ);
    return {
      product_name: it.product_name, sku: it.sku, unit: it.unit, category: it.category,
      qty_issued: issued, qty_sold: soldQ, qty_returned: returned, closing_stock: issued - soldQ - returned,
    };
  });
  const stockSummary = {
    total_issued: productRows.reduce((n, r) => n + r.qty_issued, 0),
    total_sold: productRows.reduce((n, r) => n + r.qty_sold, 0),
    total_returned: productRows.reduce((n, r) => n + r.qty_returned, 0),
    closing_balance: productRows.reduce((n, r) => n + r.closing_stock, 0),
  };

  // Invoices this salesman issued on the day (via order.salesman_id).
  const { data: allInvs } = await supabaseAdmin
    .from('invoices')
    .select('id, invoice_no, outlet_id, subtotal, discount_total, taxable_value, cgst, sgst, igst, cess, round_off, grand_total, order_id, invoice_items(sku_id, sku_name, qty, taxable_value, gst_rate, cgst, sgst, total), orders:order_id(salesman_id)')
    .eq('org_id', org_id).gte('issued_at', dayStart).lt('issued_at', dayEnd).neq('status', 'cancelled');
  const invs = (allInvs || []).filter((i: any) => i.orders?.salesman_id === salesmanId);

  // Category map for invoice line items.
  const lineSkuIds = Array.from(new Set(invs.flatMap((i: any) => (i.invoice_items || []).map((l: any) => l.sku_id)).filter(Boolean)));
  const { data: lineSkus } = lineSkuIds.length
    ? await supabaseAdmin.from('skus').select('id, category').in('id', lineSkuIds)
    : { data: [] as any[] };
  const catMap: Record<string, string> = {}; (lineSkus || []).forEach((s: any) => (catMap[s.id] = s.category || 'Others'));

  const grossSales = invs.reduce((n: number, i: any) => n + num(i.taxable_value) + num(i.discount_total), 0);
  const totalDiscount = invs.reduce((n: number, i: any) => n + num(i.discount_total), 0);
  const netSales = invs.reduce((n: number, i: any) => n + num(i.taxable_value), 0);
  const roundOff = invs.reduce((n: number, i: any) => n + num(i.round_off), 0);
  const totalGst = invs.reduce((n: number, i: any) => n + num(i.cgst) + num(i.sgst) + num(i.igst) + num(i.cess), 0);
  const finalNet = invs.reduce((n: number, i: any) => n + num(i.grand_total), 0);

  // Category-wise + discount-wise + GST-wise breakdowns.
  const byCat: Record<string, { sales: number; discount: number }> = {};
  const byGst: Record<string, { taxable: number; cgst: number; sgst: number }> = {};
  invs.forEach((i: any) => (i.invoice_items || []).forEach((l: any) => {
    const cat = catMap[l.sku_id] || 'Others';
    (byCat[cat] ||= { sales: 0, discount: 0 }).sales += num(l.total);
    const rate = String(num(l.gst_rate));
    const g = (byGst[rate] ||= { taxable: 0, cgst: 0, sgst: 0 });
    g.taxable += num(l.taxable_value); g.cgst += num(l.cgst); g.sgst += num(l.sgst);
  }));
  const categorySales = Object.entries(byCat).map(([category, v]) => ({
    category, sales_value: Math.round(v.sales * 100) / 100,
    pct: netSales > 0 ? Math.round((v.sales / invs.reduce((n: number, i: any) => n + num(i.subtotal || i.taxable_value), 0)) * 10000) / 100 : 0,
  })).sort((a, b) => b.sales_value - a.sales_value);
  const gstSummary = Object.entries(byGst).map(([rate, v]) => ({
    gst_rate: Number(rate), taxable_value: Math.round(v.taxable * 100) / 100,
    cgst: Math.round(v.cgst * 100) / 100, sgst: Math.round(v.sgst * 100) / 100,
  })).sort((a, b) => a.gst_rate - b.gst_rate);

  // Collection by payment mode.
  const { data: pays } = await supabaseAdmin
    .from('payments')
    .select('mode, amount')
    .eq('org_id', org_id).eq('salesman_id', salesmanId)
    .gte('received_at', dayStart).lt('received_at', dayEnd)
    .neq('status', 'bounced');
  const byMode: Record<string, number> = {};
  (pays || []).forEach((p: any) => { byMode[p.mode] = (byMode[p.mode] || 0) + num(p.amount); });
  const collection = ['cash', 'upi', 'cheque', 'credit', 'part_payment'].map((mode) => ({ mode, amount: Math.round((byMode[mode] || 0) * 100) / 100 }));
  const totalCollection = Object.values(byMode).reduce((n, v) => n + v, 0);

  // Top-5 shops by sale.
  const byShop: Record<string, { bills: number; value: number }> = {};
  invs.forEach((i: any) => { const s = (byShop[i.outlet_id] ||= { bills: 0, value: 0 }); s.bills += 1; s.value += num(i.grand_total); });
  const shopIds = Object.keys(byShop);
  const { data: shopRows } = shopIds.length
    ? await supabaseAdmin.from('stores').select('id, name').in('id', shopIds)
    : { data: [] as any[] };
  const shopName: Record<string, string> = {}; (shopRows || []).forEach((s: any) => (shopName[s.id] = s.name));
  const topShops = Object.entries(byShop)
    .map(([id, v]) => ({ shop_name: shopName[id] || '—', bills: v.bills, sales_value: Math.round(v.value * 100) / 100 }))
    .sort((a, b) => b.sales_value - a.sales_value).slice(0, 5);

  const totalExpenses = num(challan.loading_expense) + num(challan.transport_expense) + num(challan.misc_expense);

  ok(res, {
    header: {
      challan_no: challan.challan_no,
      salesman_name: salesman?.name || '—',
      route_label: challan.route_label,
      beat_area: challan.beat_area,
      vehicle_no: challan.vehicle_no,
      driver_name: challan.driver_name,
      helper_name: challan.helper_name,
      start_time: challan.start_time,
      end_time: challan.end_time,
      report_date: challan.report_date,
    },
    performance: {
      shops_visited: challan.shops_visited,
      productive_calls: challan.productive_calls,
      nonproductive_calls: challan.nonproductive_calls,
      total_bills: invs.length,
      total_qty_sold: stockSummary.total_sold,
      total_sales_value: Math.round(finalNet * 100) / 100,
      total_discount: Math.round(totalDiscount * 100) / 100,
      average_bill_value: invs.length ? Math.round((finalNet / invs.length) * 100) / 100 : 0,
    },
    stock_summary: stockSummary,
    product_rows: productRows,
    sales_summary: {
      gross_sales: Math.round(grossSales * 100) / 100,
      total_discount: Math.round(totalDiscount * 100) / 100,
      net_sales: Math.round(netSales * 100) / 100,
      total_gst: Math.round(totalGst * 100) / 100,
      round_off: Math.round(roundOff * 100) / 100,
      final_net_sales: Math.round(finalNet * 100) / 100,
    },
    category_sales: categorySales,
    gst_summary: gstSummary,
    collection,
    total_collection: Math.round(totalCollection * 100) / 100,
    top_shops: topShops,
    expenses: {
      loading: num(challan.loading_expense),
      transport: num(challan.transport_expense),
      misc: num(challan.misc_expense),
      total: totalExpenses,
    },
    remarks: challan.remarks,
  });
});
