// ═══════════════════════════════════════════════════════════
// src/controllers/distribution/control-tower.controller.ts
//
// The redesigned distribution overview — a "route-to-market Control Tower".
// One org-scoped endpoint that aggregates the whole brand → distributor →
// retailer → end-customer spine from real rows, computes a few genuinely
// data-driven AI signals (demand surge, dormant outlets, coverage gap, a
// short SKU forecast), and asks the LLM to narrate what a sales head should
// do next. Read-only; mirrors reports.controller.ts conventions.
// ═══════════════════════════════════════════════════════════
import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, isDemo } from '../../utils';
import { complete as aiComplete } from '../../services/crm/ai/aiClient';

const num = (v: unknown) => Number(v || 0);
const DAY = 86_400_000;

/** IST calendar-day start (as a UTC ISO string) for "today" GMV. */
function istTodayStartIso(): string {
  const istOffset = 5.5 * 3600 * 1000;
  const nowIst = new Date(Date.now() + istOffset);
  const istMidnight = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate());
  return new Date(istMidnight - istOffset).toISOString();
}

async function count(table: string, org_id: string, extra?: (q: any) => any): Promise<number> {
  try {
    let q = supabaseAdmin.from(table).select('id', { count: 'exact', head: true }).eq('org_id', org_id);
    if (extra) q = extra(q);
    const { count } = await q;
    return num(count);
  } catch { return 0; }
}

interface Signal {
  type: 'stockout' | 'dormant' | 'coverage' | 'anomaly' | 'opportunity';
  severity: 'critical' | 'warning' | 'ai';
  title: string;
  detail: string;
  action?: string;
}

/**
 * GET /api/v1/distribution/control-tower
 * Returns the route-to-market spine, headline KPIs, data-driven AI signals,
 * a short forecast, and an LLM narrative. `?ai=0` skips the narrative.
 */
export const controlTower = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, demoTower());

  const now = Date.now();
  const since30 = new Date(now - 30 * DAY).toISOString();
  const since60 = new Date(now - 60 * DAY).toISOString();
  const dormantCut = new Date(now - 21 * DAY).toISOString();
  const weekAgo = new Date(now - 7 * DAY).toISOString();

  // ── Spine counts (each defensive; a missing/empty table → 0) ──────────────
  const [
    brands, skus, priceLists, schemes, distributors, outlets, consumers, consumersNew,
  ] = await Promise.all([
    count('brands', org_id),
    count('skus', org_id),
    count('price_lists', org_id),
    count('schemes', org_id),
    count('distributors', org_id),
    count('stores', org_id),
    count('distribution_consumer_registrations', org_id),
    count('distribution_consumer_registrations', org_id, (q) => q.gte('created_at', weekAgo)),
  ]);

  // ── Orders (last 60d window powers GMV, coverage, velocity) ───────────────
  let orders: Array<{ outlet_id: string | null; distributor_id: string | null; grand_total: number | null; placed_at: string; status: string | null }> = [];
  try {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('outlet_id, distributor_id, grand_total, placed_at, status')
      .eq('org_id', org_id)
      .neq('status', 'cancelled')
      .gte('placed_at', since60)
      .order('placed_at', { ascending: false })
      .limit(5000);
    orders = (data as any[]) || [];
  } catch { orders = []; }

  const todayStart = istTodayStartIso();
  const gmvToday = orders.filter((o) => o.placed_at >= todayStart).reduce((s, o) => s + num(o.grand_total), 0);
  const gmv30 = orders.filter((o) => o.placed_at >= since30).reduce((s, o) => s + num(o.grand_total), 0);

  // Coverage = distinct outlets ordered in last 30d ÷ total outlets.
  const outletsOrdered30 = new Set(orders.filter((o) => o.placed_at >= since30 && o.outlet_id).map((o) => o.outlet_id));
  const coveragePct = outlets ? Math.round((outletsOrdered30.size / outlets) * 100) : 0;

  // Dormant = outlets whose most-recent order is older than 21 days.
  const lastOrderByOutlet = new Map<string, string>();
  for (const o of orders) {
    if (!o.outlet_id) continue;
    const prev = lastOrderByOutlet.get(o.outlet_id);
    if (!prev || o.placed_at > prev) lastOrderByOutlet.set(o.outlet_id, o.placed_at);
  }
  const dormantOutlets = Array.from(lastOrderByOutlet.entries()).filter(([, last]) => last < dormantCut).length;

  // ── Outstanding (latest running balance per outlet, from the outlet ledger) ─
  let outstanding = 0;
  try {
    const { data: led } = await supabaseAdmin
      .from('ledger_entries')
      .select('outlet_id, running_balance, created_at')
      .eq('org_id', org_id)
      .order('created_at', { ascending: false })
      .limit(5000);
    const seen = new Set<string>();
    for (const e of (led as any[]) || []) {
      if (!e.outlet_id || seen.has(e.outlet_id)) continue; // first seen = latest (desc order)
      seen.add(e.outlet_id);
      const bal = num(e.running_balance);
      if (bal > 0) outstanding += bal;
    }
  } catch { outstanding = 0; }

  // ── Demand velocity per SKU (order_items joined to orders' placed_at) ──────
  // Real AI signal #1: SKUs whose last-30d velocity is sharply up vs the prior
  // 30d are flagged "demand surge — replenish" (a data-driven forecast signal
  // that needs no per-distributor stock table, which this tenant lacks).
  const forecast: Array<{ sku_id: string; name: string; qty30: number; prior30: number; trendPct: number; projectedNext30: number }> = [];
  const signals: Signal[] = [];
  try {
    const orderIds = orders.map((o: any) => o.id).filter(Boolean);
    // We didn't select id above; re-query ids + items window for velocity.
    const { data: recentOrders } = await supabaseAdmin
      .from('orders')
      .select('id, placed_at')
      .eq('org_id', org_id)
      .neq('status', 'cancelled')
      .gte('placed_at', since60)
      .limit(5000);
    const placedById = new Map<string, string>();
    for (const o of (recentOrders as any[]) || []) placedById.set(o.id, o.placed_at);
    const ids = Array.from(placedById.keys());
    void orderIds;

    if (ids.length) {
      const { data: items } = await supabaseAdmin
        .from('order_items')
        .select('order_id, sku_id, qty')
        .in('order_id', ids)
        .limit(20000);
      const agg = new Map<string, { q30: number; qPrior: number }>();
      for (const it of (items as any[]) || []) {
        const placed = placedById.get(it.order_id);
        if (!placed || !it.sku_id) continue;
        const rec = agg.get(it.sku_id) || { q30: 0, qPrior: 0 };
        if (placed >= since30) rec.q30 += num(it.qty);
        else rec.qPrior += num(it.qty);
        agg.set(it.sku_id, rec);
      }
      const skuIds = Array.from(agg.keys());
      const nameById = new Map<string, string>();
      if (skuIds.length) {
        const { data: skuRows } = await supabaseAdmin.from('skus').select('id, name, sku_code').in('id', skuIds);
        for (const s of (skuRows as any[]) || []) nameById.set(s.id, s.name || s.sku_code || 'SKU');
      }
      const rows = skuIds.map((id) => {
        const { q30, qPrior } = agg.get(id)!;
        const trendPct = qPrior > 0 ? Math.round(((q30 - qPrior) / qPrior) * 100) : (q30 > 0 ? 100 : 0);
        return { sku_id: id, name: nameById.get(id) || 'SKU', qty30: q30, prior30: qPrior, trendPct, projectedNext30: Math.round(q30 * (q30 && qPrior ? q30 / qPrior : 1)) };
      }).sort((a, b) => b.qty30 - a.qty30);
      forecast.push(...rows.slice(0, 6));

      // Surge signal: fastest riser with meaningful volume.
      const surge = rows.filter((r) => r.qty30 >= 5 && r.trendPct >= 25).sort((a, b) => b.trendPct - a.trendPct)[0];
      if (surge) {
        signals.push({
          type: 'stockout', severity: 'critical',
          title: `Demand surge — ${surge.name}`,
          detail: `Off-take up ${surge.trendPct}% vs the prior 30 days (${surge.qty30} units). Replenish distributor stock before it runs dry.`,
          action: 'Draft primary order',
        });
      }
    }
  } catch { /* forecast is best-effort */ }

  if (dormantOutlets > 0) {
    signals.push({
      type: 'dormant', severity: 'warning',
      title: `${dormantOutlets} outlet${dormantOutlets === 1 ? '' : 's'} going dormant`,
      detail: `No order in 21+ days. Add them to today's beats before the relationship cools.`,
      action: 'Add to beat',
    });
  }
  if (outlets && coveragePct < 70) {
    signals.push({
      type: 'coverage', severity: 'ai',
      title: `Coverage is ${coveragePct}%`,
      detail: `${outlets - outletsOrdered30.size} of ${outlets} outlets had no order in the last 30 days. Re-balancing beats can lift reach.`,
      action: 'Optimise beats',
    });
  }

  // ── Spine + KPIs payload ──────────────────────────────────────────────────
  const distAtRisk = signals.some((s) => s.type === 'stockout') ? 1 : 0;
  const spine = {
    brand:       { count: brands, skus, price_lists: priceLists, schemes },
    distributor: { count: distributors, healthy: Math.max(0, distributors - distAtRisk), at_risk: distAtRisk },
    retailer:    { count: outlets, covered: outletsOrdered30.size, coverage_pct: coveragePct, dormant: dormantOutlets },
    consumer:    { count: consumers, new_this_week: consumersNew },
  };
  const kpis = {
    gmv_today: Math.round(gmvToday),
    gmv_30d: Math.round(gmv30),
    orders_30d: orders.filter((o) => o.placed_at >= since30).length,
    outstanding: Math.round(outstanding),
    coverage_pct: coveragePct,
    dormant_outlets: dormantOutlets,
  };

  // ── Real AI: LLM narrates the state + next actions ────────────────────────
  let narrative = '';
  if (String(req.query.ai ?? '1') !== '0') {
    try {
      narrative = await aiComplete({
        org_id,
        model: process.env.DIST_TOWER_MODEL || 'claude-haiku-4-5-20251001',
        system:
          'You are KINI, a supply-chain control tower for a distribution business. ' +
          'Given a JSON snapshot of the route-to-market (brand → distributor → retailer → consumer) ' +
          'plus computed signals, write a crisp 2-3 sentence briefing for a sales head: what is healthy, ' +
          'what needs attention now, and the single highest-value next action. Use plain business English, ' +
          'no markdown, no preamble. Reference concrete numbers from the data.',
        messages: [{ role: 'user', content: JSON.stringify({ spine, kpis, signals, forecast: forecast.slice(0, 4) }) }],
        max_tokens: 220,
      });
    } catch { narrative = ''; }
  }

  return ok(res, {
    spine,
    kpis,
    signals,
    forecast,
    narrative: (narrative || '').trim(),
    generated_at: new Date().toISOString(),
  });
});

function demoTower() {
  return {
    spine: {
      brand: { count: 1, skus: 15, price_lists: 2, schemes: 4 },
      distributor: { count: 3, healthy: 2, at_risk: 1 },
      retailer: { count: 28, covered: 17, coverage_pct: 61, dormant: 5 },
      consumer: { count: 312, new_this_week: 18 },
    },
    kpis: { gmv_today: 428000, gmv_30d: 4200000, orders_30d: 109, outstanding: 190000, coverage_pct: 61, dormant_outlets: 5 },
    signals: [
      { type: 'stockout', severity: 'critical', title: 'Demand surge — Nova Atta 5kg', detail: 'Off-take up 22% vs prior 30 days. Replenish before it runs dry.', action: 'Draft primary order' },
      { type: 'dormant', severity: 'warning', title: '5 outlets going dormant', detail: 'No order in 21+ days on Beat 12.', action: 'Add to beat' },
      { type: 'coverage', severity: 'ai', title: 'Coverage is 61%', detail: '11 of 28 outlets had no order in the last 30 days.', action: 'Optimise beats' },
    ],
    forecast: [
      { sku_id: 'demo1', name: 'Nova Atta 5kg', qty30: 340, prior30: 279, trendPct: 22, projectedNext30: 414 },
      { sku_id: 'demo2', name: 'Nova Poha 1kg', qty30: 190, prior30: 205, trendPct: -7, projectedNext30: 176 },
    ],
    narrative: 'Network is broadly healthy — 3 distributors, 28 outlets, ₹4.2L off-take this month. Attention: Nova Atta demand is up 22% and risks a stockout, and 5 outlets on Beat 12 have gone quiet. Highest-value move: draft the Nova Atta replenishment order now.',
    generated_at: new Date().toISOString(),
  };
}
