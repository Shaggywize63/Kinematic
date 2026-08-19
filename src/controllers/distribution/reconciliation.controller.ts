import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, isDemo } from '../../utils';

/**
 * Primary ↔ Secondary reconciliation (module `distribution_reconciliation`).
 *
 * Read-only analytics. For a period + optional distributor, compares:
 *   • PRIMARY sell-in  — company → distributor: `invoices` (issued_at) × invoice_items
 *   • SECONDARY sell-out — distributor → retailer: `orders` (placed_at) × order_items
 *   • ON-HAND — current distributor stock (Wave A, distribution_distributor_stock)
 * per distributor × SKU, and flags channel health:
 *   variance = primary − secondary  (net expected on-hand change)
 *   sell_through = secondary / primary
 *     < 0.6 → overstock (channel-stuffing risk)   > 1.3 → drawdown   else healthy
 * This is the number Bizom/FieldAssist estimate from an EOD report — we compute
 * it from the actual sell-in and sell-out ledgers.
 */

const num = (v: unknown) => Number(v || 0);
const DAY = 86_400_000;

function classify(primary: number, secondary: number): string {
  if (primary <= 0) return secondary > 0 ? 'no_primary' : 'idle';
  const r = secondary / primary;
  if (r < 0.6) return 'overstock';
  if (r > 1.3) return 'drawdown';
  return 'healthy';
}

// ── GET /distribution/reconciliation?from=&to=&distributor_id= ────────────────
export const reconcile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { rows: [], by_distributor: [], summary: { primary: 0, secondary: 0, variance: 0, sell_through: 0 }, from: '', to: '' });

  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  const from = (req.query.from as string) || new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
  const toEnd = `${to}T23:59:59`;
  const distFilter = (req.query.distributor_id as string) || '';

  // ── PRIMARY: invoices → invoice_items ──────────────────────────────────────
  let invQ = supabaseAdmin.from('invoices')
    .select('id, distributor_id')
    .eq('org_id', user.org_id).not('distributor_id', 'is', null)
    .neq('status', 'cancelled').gte('issued_at', from).lte('issued_at', toEnd).limit(5000);
  if (distFilter) invQ = invQ.eq('distributor_id', distFilter);
  const { data: invoices } = await invQ;
  const invDist = new Map<string, string>();
  for (const iv of (invoices as any[]) || []) invDist.set(iv.id, iv.distributor_id);

  const primary = new Map<string, number>(); // dist|sku -> qty
  const invIds = Array.from(invDist.keys());
  if (invIds.length) {
    const { data: items } = await supabaseAdmin.from('invoice_items').select('invoice_id, sku_id, qty').in('invoice_id', invIds).limit(20000);
    for (const it of (items as any[]) || []) {
      const d = invDist.get(it.invoice_id);
      if (!d || !it.sku_id) continue;
      const k = `${d}|${it.sku_id}`;
      primary.set(k, (primary.get(k) || 0) + num(it.qty));
    }
  }

  // ── SECONDARY: orders → order_items ────────────────────────────────────────
  let ordQ = supabaseAdmin.from('orders')
    .select('id, distributor_id')
    .eq('org_id', user.org_id).not('distributor_id', 'is', null)
    .neq('status', 'cancelled').gte('placed_at', from).lte('placed_at', toEnd).limit(5000);
  if (distFilter) ordQ = ordQ.eq('distributor_id', distFilter);
  const { data: orders } = await ordQ;
  const ordDist = new Map<string, string>();
  for (const o of (orders as any[]) || []) ordDist.set(o.id, o.distributor_id);

  const secondary = new Map<string, number>();
  const ordIds = Array.from(ordDist.keys());
  if (ordIds.length) {
    const { data: items } = await supabaseAdmin.from('order_items').select('order_id, sku_id, qty').in('order_id', ordIds).limit(20000);
    for (const it of (items as any[]) || []) {
      const d = ordDist.get(it.order_id);
      if (!d || !it.sku_id) continue;
      const k = `${d}|${it.sku_id}`;
      secondary.set(k, (secondary.get(k) || 0) + num(it.qty));
    }
  }

  // ── ON-HAND: current distributor stock ─────────────────────────────────────
  const onHand = new Map<string, number>();
  let stkQ = supabaseAdmin.from('distribution_distributor_stock')
    .select('distributor_id, sku_id, qty, reserved').eq('org_id', user.org_id).limit(20000);
  if (distFilter) stkQ = stkQ.eq('distributor_id', distFilter);
  const { data: stock } = await stkQ;
  for (const r of (stock as any[]) || []) onHand.set(`${r.distributor_id}|${r.sku_id}`, Math.max(0, num(r.qty) - num(r.reserved)));

  // ── Build rows over the union of keys ──────────────────────────────────────
  const keys = new Set<string>([...primary.keys(), ...secondary.keys()]);
  const distIds = new Set<string>(); const skuIds = new Set<string>();
  for (const k of keys) { const [d, s] = k.split('|'); distIds.add(d); skuIds.add(s); }

  const distName = new Map<string, string>(); const skuName = new Map<string, string>(); const skuCode = new Map<string, string>();
  if (distIds.size) {
    const { data } = await supabaseAdmin.from('distributors').select('id, name').eq('org_id', user.org_id).in('id', Array.from(distIds));
    for (const d of (data as any[]) || []) distName.set(d.id, d.name || 'Distributor');
  }
  if (skuIds.size) {
    const { data } = await supabaseAdmin.from('skus').select('id, name, sku_code').in('id', Array.from(skuIds));
    for (const s of (data as any[]) || []) { skuName.set(s.id, s.name || 'SKU'); skuCode.set(s.id, s.sku_code || ''); }
  }

  const rows = Array.from(keys).map((k) => {
    const [d, s] = k.split('|');
    const p = primary.get(k) || 0;
    const sec = secondary.get(k) || 0;
    return {
      distributor_id: d, distributor_name: distName.get(d) || 'Distributor',
      sku_id: s, sku_name: skuName.get(s) || 'SKU', sku_code: skuCode.get(s) || null,
      primary_qty: p, secondary_qty: sec, on_hand: onHand.get(k) || 0,
      variance: p - sec, sell_through: p > 0 ? Math.round((sec / p) * 100) / 100 : null,
      flag: classify(p, sec),
    };
  }).sort((a, b) => (b.primary_qty + b.secondary_qty) - (a.primary_qty + a.secondary_qty));

  // Per-distributor rollup.
  const distAgg = new Map<string, { distributor_id: string; distributor_name: string; primary: number; secondary: number; on_hand: number; skus: number }>();
  for (const r of rows) {
    const a = distAgg.get(r.distributor_id) || { distributor_id: r.distributor_id, distributor_name: r.distributor_name, primary: 0, secondary: 0, on_hand: 0, skus: 0 };
    a.primary += r.primary_qty; a.secondary += r.secondary_qty; a.on_hand += r.on_hand; a.skus += 1;
    distAgg.set(r.distributor_id, a);
  }
  const by_distributor = Array.from(distAgg.values()).map((a) => ({
    ...a, variance: a.primary - a.secondary, sell_through: a.primary > 0 ? Math.round((a.secondary / a.primary) * 100) / 100 : null,
    flag: classify(a.primary, a.secondary),
  })).sort((x, y) => (y.primary + y.secondary) - (x.primary + x.secondary));

  const totP = rows.reduce((s, r) => s + r.primary_qty, 0);
  const totS = rows.reduce((s, r) => s + r.secondary_qty, 0);
  ok(res, {
    from, to, rows, by_distributor,
    summary: { primary: totP, secondary: totS, variance: totP - totS, sell_through: totP > 0 ? Math.round((totS / totP) * 100) / 100 : null, sku_lines: rows.length },
  });
});
