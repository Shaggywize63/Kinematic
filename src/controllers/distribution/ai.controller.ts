// ═══════════════════════════════════════════════════════════
// src/controllers/distribution/ai.controller.ts
//
// Phase 2 of the distribution redesign — the AI layer.
//   • Agents config       GET/POST /distribution/ai/agents
//   • Replenishment agent GET      /distribution/ai/replenishment
//   • Conversational tower POST     /distribution/ai/ask
//
// "Real AI, start narrow": the quantitative work (sell-out velocity, projected
// demand, coverage, dormancy) is computed from real rows; the LLM (aiComplete,
// reusing the KINI/Anthropic path) writes the rationale and answers questions
// over that computed snapshot. Org-scoped; mirrors reports.controller.ts.
// ═══════════════════════════════════════════════════════════
import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { complete as aiComplete } from '../../services/crm/ai/aiClient';
import {
  computeVelocity, nameMaps, buildReplenishment, upsertDraftOrder,
} from '../../services/distribution/replenishment.service';
import { listOutletsForDistributor, placeDraftOrder } from '../../services/distribution/orderPlacement.service';
import { PricerError } from '../../services/order-pricer';

const num = (v: unknown) => Number(v || 0);
const DAY = 86_400_000;
const MODEL = process.env.DIST_AI_MODEL || 'claude-sonnet-5';

const AGENTS = [
  { key: 'replenishment', name: 'Replenishment agent', icon: '🤖',
    desc: 'Watches sell-out vs cover and drafts the next distributor order — matching supply to demand.' },
  { key: 'perfect_store', name: 'Perfect-store agent', icon: '📸',
    desc: 'Photo → detects out-of-shelf, share-of-shelf and planogram gaps, then proposes the corrective order + task.' },
  { key: 'coverage', name: 'Coverage agent', icon: '🧭',
    desc: 'Continuously redraws beats from outlet potential, churn risk and white-space — self-optimising territory.' },
];
const AUTONOMY = ['suggest', 'approve', 'auto'];

// ── Agents config ──────────────────────────────────────────────────────────
export const getAgents = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { agents: AGENTS.map((a) => ({ ...a, autonomy: 'suggest' })) });
  const { data } = await supabaseAdmin.from('distribution_agents').select('agent_key, autonomy').eq('org_id', org_id);
  const map = new Map(((data as any[]) || []).map((r) => [r.agent_key, r.autonomy]));
  return ok(res, { agents: AGENTS.map((a) => ({ ...a, autonomy: (map.get(a.key) as string) || 'suggest' })) });
});

export const saveAgent = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const key = String(req.body?.agent_key || '');
  const autonomy = String(req.body?.autonomy || '');
  if (!AGENTS.some((a) => a.key === key)) return badRequest(res, 'Unknown agent.');
  if (!AUTONOMY.includes(autonomy)) return badRequest(res, 'Autonomy must be suggest, approve or auto.');
  if (isDemo(req.user)) return ok(res, { agent_key: key, autonomy });
  const { error } = await supabaseAdmin
    .from('distribution_agents')
    .upsert({ org_id, agent_key: key, autonomy, updated_at: new Date().toISOString() }, { onConflict: 'org_id,agent_key' });
  if (error) return badRequest(res, error.message);
  return ok(res, { agent_key: key, autonomy });
});

// ── Replenishment agent ─────────────────────────────────────────────────────
// Velocity engine + buildReplenishment live in replenishment.service so the
// GET, the approve endpoint and the auto-mode cron all draft identical numbers.
export const replenishment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, demoReplenishment());

  const suggestions = await buildReplenishment(org_id);

  let rationale = '';
  if (suggestions.length && String(req.query.ai ?? '1') !== '0') {
    try {
      rationale = await aiComplete({
        org_id, model: MODEL,
        system: 'You are KINI, a replenishment agent for a distribution business. Given per-distributor projected ' +
          'next-30-day demand (from real sell-out velocity), write ONE crisp sentence for the sales head: what to reorder ' +
          'first and why. Plain business English, no markdown, no preamble, reference concrete numbers.',
        messages: [{ role: 'user', content: JSON.stringify(suggestions.slice(0, 5)) }],
        max_tokens: 160,
      });
    } catch { rationale = ''; }
  }

  return ok(res, { suggestions, rationale: (rationale || '').trim(), generated_at: new Date().toISOString() });
});

// ── Approve a replenishment suggestion → persist a draft order ───────────────
// A draft order is a reviewable REPLENISHMENT PLAN for one distributor
// (SKU + projected qty), deliberately price-free. It is NOT a placed order:
// it never enters the outlet-centric orders/pricing/GST/scheme flow, so the
// live `orders` ledger the velocity engine reads stays clean. The sales head
// reviews/dismisses it, and places the real order in the Orders screen.
export const approveReplenishment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const distributorId = String(req.body?.distributor_id || '').trim();
  if (!distributorId) return badRequest(res, 'distributor_id is required.');
  if (isDemo(req.user)) return created(res, demoDraft(distributorId), 'Draft order created (Demo)');

  // Recompute server-side (anti-tamper, mirrors orders.create): the client only
  // names a distributor; the server authors the authoritative line quantities.
  const suggestions = await buildReplenishment(org_id);
  const s = suggestions.find((x) => x.distributor_id === distributorId);
  if (!s) return badRequest(res, 'No current replenishment suggestion for that distributor.');

  let rationale = '';
  try {
    rationale = await aiComplete({
      org_id, model: MODEL,
      system: 'You are KINI, a replenishment agent. In ONE plain-English sentence, justify this draft reorder for the ' +
        'distributor from the projected next-30-day quantities. No markdown, no preamble, reference concrete numbers.',
      messages: [{ role: 'user', content: JSON.stringify(s) }],
      max_tokens: 120,
    });
  } catch { rationale = ''; }

  let result;
  try {
    result = await upsertDraftOrder(org_id, s, {
      created_by: req.user!.id ?? null,
      rationale: (rationale || '').trim() || null,
    });
  } catch (e: any) {
    return badRequest(res, e?.message || 'Could not create draft order.');
  }
  const { row, existing } = result;
  await audit(req, 'distribution.draft_order.create', 'distribution_draft_orders', row.id, existing || null, row);
  return created(res, row, 'Draft order created');
});

// ── Draft orders (list + dismiss) ────────────────────────────────────────────
export const listDraftOrders = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { drafts: [demoDraft('d1')] });
  const status = String(req.query.status || 'open');
  const { data, error } = await supabaseAdmin.from('distribution_draft_orders')
    .select('*').eq('org_id', org_id).eq('status', status)
    .order('created_at', { ascending: false }).limit(50);
  if (error) return badRequest(res, error.message);
  return ok(res, { drafts: data || [] });
});

export const dismissDraftOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { id: req.params.id, status: 'dismissed' });
  const { data: before } = await supabaseAdmin.from('distribution_draft_orders')
    .select('*').eq('id', req.params.id).eq('org_id', org_id).maybeSingle();
  if (!before) return notFound(res, 'Draft order not found');
  const { data, error } = await supabaseAdmin.from('distribution_draft_orders')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'distribution.draft_order.dismiss', 'distribution_draft_orders', data.id, before, data);
  return ok(res, data, 'Draft order dismissed');
});

// ── Place a draft in Orders ──────────────────────────────────────────────────
// Candidate outlets (served by the draft's distributor) for the placement picker.
export const listDraftOutlets = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { outlets: [{ id: 'o1', name: 'Sharma Kirana' }, { id: 'o2', name: 'New Mart' }] });
  const { data: draft } = await supabaseAdmin.from('distribution_draft_orders')
    .select('distributor_id, status').eq('id', req.params.id).eq('org_id', org_id).maybeSingle();
  if (!draft) return notFound(res, 'Draft order not found');
  if (!draft.distributor_id) return ok(res, { outlets: [] });
  const outlets = await listOutletsForDistributor(org_id, draft.distributor_id);
  return ok(res, { outlets });
});

// Turn the draft into a REAL order for one chosen outlet, priced through the
// full GST/scheme engine (status 'placed'); the draft flips to 'converted' and
// links the new order. The draft's SKUs + suggested quantities seed the order —
// review/cancel it in Orders afterward.
export const placeDraftOrderHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const outletId = String(req.body?.outlet_id || '').trim();
  if (!outletId) return badRequest(res, 'outlet_id is required.');
  if (isDemo(req.user)) return created(res, { order: { id: 'demo-order', order_no: 'ORD-DEMO', grand_total: 0 }, draft_id: req.params.id }, 'Order placed (Demo)');

  const { data: draft } = await supabaseAdmin.from('distribution_draft_orders')
    .select('*').eq('id', req.params.id).eq('org_id', org_id).maybeSingle();
  if (!draft) return notFound(res, 'Draft order not found');
  if (draft.status !== 'open') return conflict(res, `Draft is already ${draft.status}`);
  if (!draft.distributor_id) return badRequest(res, 'Draft has no distributor to resolve pricing.');

  // Only allow outlets actually served by this distributor.
  const outlets = await listOutletsForDistributor(org_id, draft.distributor_id);
  if (!outlets.some((o) => o.id === outletId)) return badRequest(res, 'Outlet is not served by this distributor.');

  let order: any;
  try {
    order = await placeDraftOrder({ id: req.user!.id, org_id, client_id: req.user!.client_id }, draft, outletId);
  } catch (e: any) {
    if (e instanceof PricerError) return conflict(res, `${e.code}: ${e.message}`);
    return badRequest(res, e?.message || 'Could not place the order.');
  }

  const { data: updated } = await supabaseAdmin.from('distribution_draft_orders')
    .update({ status: 'converted', converted_order_id: order.id, updated_at: new Date().toISOString() })
    .eq('id', draft.id).eq('org_id', org_id).select().single();
  await audit(req, 'distribution.draft_order.place', 'orders', order.id,
    { draft_id: draft.id }, { order_id: order.id, order_no: order.order_no, grand_total: order.grand_total });
  return created(res, { order, draft: updated || null }, 'Order placed');
});

// ── Conversational control tower ─────────────────────────────────────────────
export const ask = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const question = String(req.body?.question || '').trim().slice(0, 500);
  if (!question) return badRequest(res, 'Ask a question about your distribution.');
  if (isDemo(req.user)) return ok(res, { answer: 'Connect live data to ask KINI about your network.', actions: [] });

  const now = Date.now();
  const since30 = new Date(now - 30 * DAY).toISOString();
  const dormantCut = new Date(now - 21 * DAY).toISOString();

  // Compact live snapshot for the LLM to reason over.
  const [distC, outletC, consumerC] = await Promise.all([
    supabaseAdmin.from('distributors').select('id', { count: 'exact', head: true }).eq('org_id', org_id),
    supabaseAdmin.from('stores').select('id', { count: 'exact', head: true }).eq('org_id', org_id),
    supabaseAdmin.from('distribution_consumer_registrations').select('id', { count: 'exact', head: true }).eq('org_id', org_id).then((r) => r, () => ({ count: 0 })),
  ]);
  const { data: ord } = await supabaseAdmin
    .from('orders').select('outlet_id, distributor_id, grand_total, placed_at')
    .eq('org_id', org_id).neq('status', 'cancelled').gte('placed_at', new Date(now - 60 * DAY).toISOString()).limit(5000);
  const orders = (ord as any[]) || [];
  const outlets = num((outletC as any).count);
  const lastByOutlet = new Map<string, string>();
  for (const o of orders) { if (!o.outlet_id) continue; const p = lastByOutlet.get(o.outlet_id); if (!p || o.placed_at > p) lastByOutlet.set(o.outlet_id, o.placed_at); }
  const covered = new Set(orders.filter((o) => o.placed_at >= since30 && o.outlet_id).map((o) => o.outlet_id)).size;
  const dormant = Array.from(lastByOutlet.values()).filter((l) => l < dormantCut).length;

  // Top movers from the velocity engine.
  const agg = await computeVelocity(org_id);
  const skuIds = new Set<string>(); for (const k of agg.keys()) skuIds.add(k.split('|')[1]);
  const { sku } = await nameMaps(org_id, [], Array.from(skuIds));
  const movers = new Map<string, { q30: number; qPrior: number }>();
  for (const [k, v] of agg.entries()) { const s = k.split('|')[1]; const m = movers.get(s) || { q30: 0, qPrior: 0 }; m.q30 += v.q30; m.qPrior += v.qPrior; movers.set(s, m); }
  const topMovers = Array.from(movers.entries())
    .map(([s, v]) => ({ sku: sku.get(s) || 'SKU', last30: v.q30, trendPct: v.qPrior > 0 ? Math.round((v.q30 / v.qPrior - 1) * 100) : 100 }))
    .sort((a, b) => b.last30 - a.last30).slice(0, 8);

  const snapshot = {
    distributors: num((distC as any).count),
    outlets, covered, coverage_pct: outlets ? Math.round((covered / outlets) * 100) : 0,
    dormant_outlets: dormant,
    consumers: num((consumerC as any).count),
    gmv_30d: Math.round(orders.filter((o) => o.placed_at >= since30).reduce((s, o) => s + num(o.grand_total), 0)),
    top_movers: topMovers,
  };

  let answer = '';
  try {
    answer = await aiComplete({
      org_id, model: MODEL,
      system: 'You are KINI, a conversational control tower for a distribution business (brand → distributor → retailer → ' +
        'consumer). Answer the user\'s question using ONLY the JSON snapshot of their live network provided. Be concise ' +
        '(2-4 sentences), reference concrete numbers, and end with the single most useful next action. Plain business ' +
        'English, no markdown. If the snapshot lacks the data, say what to capture to answer it.',
      messages: [{ role: 'user', content: JSON.stringify({ question, snapshot }) }],
      max_tokens: 350,
    });
  } catch (e: any) { return badRequest(res, 'KINI is unavailable right now — try again.'); }

  return ok(res, { answer: (answer || '').trim(), snapshot, generated_at: new Date().toISOString() });
});

// ── Coverage agent ──────────────────────────────────────────────────────────
export const coverage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, demoCoverage());

  const now = Date.now();
  const since30 = new Date(now - 30 * DAY).toISOString();
  const since90 = new Date(now - 90 * DAY).toISOString();
  const dormantCut = new Date(now - 21 * DAY).toISOString();

  const { data: storesRaw } = await supabaseAdmin
    .from('stores').select('id, name, store_type').eq('org_id', org_id).eq('is_active', true).limit(5000);
  const stores = (storesRaw as any[]) || [];
  const { data: ordersRaw } = await supabaseAdmin
    .from('orders').select('outlet_id, placed_at').eq('org_id', org_id).neq('status', 'cancelled').gte('placed_at', since90).limit(5000);
  const lastByOutlet = new Map<string, string>();
  for (const o of (ordersRaw as any[]) || []) { if (!o.outlet_id) continue; const p = lastByOutlet.get(o.outlet_id); if (!p || o.placed_at > p) lastByOutlet.set(o.outlet_id, o.placed_at); }

  const dormant: Array<{ outlet_id: string; name: string; last_order: string; days: number }> = [];
  const never: Array<{ outlet_id: string; name: string }> = [];
  let covered30 = 0;
  for (const s of stores) {
    const last = lastByOutlet.get(s.id);
    if (!last) { never.push({ outlet_id: s.id, name: s.name || 'Outlet' }); continue; }
    if (last >= since30) covered30++;
    if (last < dormantCut) dormant.push({ outlet_id: s.id, name: s.name || 'Outlet', last_order: last, days: Math.floor((now - Date.parse(last)) / DAY) });
  }
  dormant.sort((a, b) => a.days - b.days).reverse();
  const total = stores.length;
  const coverage_pct = total ? Math.round((covered30 / total) * 100) : 0;

  let rationale = '';
  if (String(req.query.ai ?? '1') !== '0' && (dormant.length || never.length)) {
    try {
      rationale = await aiComplete({
        org_id, model: MODEL,
        system: 'You are KINI, a coverage agent for a distribution business. Given outlet coverage stats plus dormant and ' +
          'never-ordered outlets, write ONE crisp sentence telling the sales head where to focus beats to recover revenue. ' +
          'Plain business English, no markdown, reference concrete numbers.',
        messages: [{ role: 'user', content: JSON.stringify({ total, covered30, coverage_pct, dormant: dormant.slice(0, 10), never_count: never.length }) }],
        max_tokens: 140,
      });
    } catch { rationale = ''; }
  }

  return ok(res, {
    total_outlets: total, covered_30d: covered30, coverage_pct,
    dormant: dormant.slice(0, 25), dormant_count: dormant.length,
    never_ordered: never.slice(0, 25), never_count: never.length,
    rationale: (rationale || '').trim(), generated_at: new Date().toISOString(),
  });
});

// ── Anomaly agent (pricing leakage) ─────────────────────────────────────────
export const anomalies = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, demoAnomalies());

  const since60 = new Date(Date.now() - 60 * DAY).toISOString();
  const { data: ordersRaw } = await supabaseAdmin
    .from('orders').select('id, distributor_id, placed_at').eq('org_id', org_id).neq('status', 'cancelled').gte('placed_at', since60).limit(5000);
  const orders = (ordersRaw as any[]) || [];
  const distById = new Map<string, string>();
  for (const o of orders) if (o.distributor_id) distById.set(o.id, o.distributor_id);
  const ids = orders.map((o) => o.id);
  if (!ids.length) return ok(res, { anomalies: [], count: 0, total_impact: 0, rationale: '', generated_at: new Date().toISOString() });

  const { data: itemsRaw } = await supabaseAdmin.from('order_items').select('order_id, sku_id, unit_price, qty').in('order_id', ids).limit(20000);
  const items = (itemsRaw as any[]) || [];
  const skuIds = Array.from(new Set(items.map((i) => i.sku_id).filter(Boolean)));

  // Expected price per SKU: the modal base_price from price lists (fallback MRP).
  const baseBySku = new Map<string, number>();
  if (skuIds.length) {
    const { data: pli } = await supabaseAdmin.from('price_list_items').select('sku_id, base_price').in('sku_id', skuIds);
    for (const r of (pli as any[]) || []) { const b = num(r.base_price); if (b > 0 && !baseBySku.has(r.sku_id)) baseBySku.set(r.sku_id, b); }
    const missing = skuIds.filter((s) => !baseBySku.has(s));
    if (missing.length) {
      const { data: pde } = await supabaseAdmin.from('product_distribution_ext').select('sku_id, mrp').in('sku_id', missing);
      for (const r of (pde as any[]) || []) { const m = num(r.mrp); if (m > 0) baseBySku.set(r.sku_id, m); }
    }
  }
  const distIds = Array.from(new Set(Array.from(distById.values())));
  const { dist, sku } = await nameMaps(org_id, distIds, skuIds);

  const flagged: Array<{ sku: string; distributor: string; unit_price: number; expected: number; dev_pct: number; qty: number; impact: number }> = [];
  for (const it of items) {
    const base = baseBySku.get(it.sku_id);
    if (!base || !it.unit_price) continue;
    const dev = (num(it.unit_price) - base) / base;
    if (Math.abs(dev) >= 0.15) {
      const impact = Math.round((base - num(it.unit_price)) * num(it.qty)); // +ve = under-charged (leakage)
      flagged.push({
        sku: sku.get(it.sku_id) || 'SKU',
        distributor: dist.get(distById.get(it.order_id) || '') || '—',
        unit_price: num(it.unit_price), expected: base,
        dev_pct: Math.round(dev * 100), qty: num(it.qty), impact,
      });
    }
  }
  flagged.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const total_impact = flagged.reduce((s, f) => s + Math.max(0, f.impact), 0);

  let rationale = '';
  if (String(req.query.ai ?? '1') !== '0' && flagged.length) {
    try {
      rationale = await aiComplete({
        org_id, model: MODEL,
        system: 'You are KINI, a revenue-assurance agent for a distribution business. Given order lines priced off the ' +
          'expected price list, write ONE crisp sentence flagging the biggest pricing leakage and what to check. Plain ' +
          'business English, no markdown, reference concrete numbers (₹ where relevant).',
        messages: [{ role: 'user', content: JSON.stringify({ count: flagged.length, total_impact, top: flagged.slice(0, 6) }) }],
        max_tokens: 140,
      });
    } catch { rationale = ''; }
  }

  return ok(res, { anomalies: flagged.slice(0, 20), count: flagged.length, total_impact, rationale: (rationale || '').trim(), generated_at: new Date().toISOString() });
});

function demoCoverage() {
  return {
    total_outlets: 28, covered_30d: 17, coverage_pct: 61,
    dormant: [{ outlet_id: 'o1', name: 'Sharma Kirana', last_order: new Date(Date.now() - 24 * DAY).toISOString(), days: 24 }],
    dormant_count: 5, never_ordered: [{ outlet_id: 'o9', name: 'New Mart' }], never_count: 3,
    rationale: 'Coverage is 61% — 5 outlets on Beat 12 have gone dormant (24+ days) and 3 mapped outlets have never ordered; prioritise them this week to recover ~₹38k/mo.',
    generated_at: new Date().toISOString(),
  };
}

function demoAnomalies() {
  return {
    anomalies: [{ sku: 'Nova Atta 5kg', distributor: 'Metro Distributors', unit_price: 210, expected: 250, dev_pct: -16, qty: 40, impact: 1600 }],
    count: 3, total_impact: 4200,
    rationale: 'Nova Atta 5kg is being billed 16% under list to Metro (₹1,600 leakage on this order) — check for an unauthorised discount or a stale price list.',
    generated_at: new Date().toISOString(),
  };
}

function demoDraft(distributor_id: string) {
  return {
    id: 'demo-draft-0001', org_id: 'demo', distributor_id, distributor_name: 'Metro Distributors',
    source: 'replenishment_agent', status: 'open', total_units: 590,
    items: [
      { sku_id: 's1', name: 'Nova Atta 5kg', last30: 340, prior30: 279, trendPct: 22, suggested_qty: 414 },
      { sku_id: 's2', name: 'Nova Poha 1kg', last30: 190, prior30: 205, trendPct: -7, suggested_qty: 176 },
    ],
    rationale: 'Metro is trending +22% on Nova Atta — 414 units covers the next cycle; Poha eased 7%, trimmed to 176.',
    created_at: new Date().toISOString(),
  };
}

function demoReplenishment() {
  return {
    suggestions: [
      { distributor_id: 'd1', distributor_name: 'Metro Distributors', total_units: 620, items: [
        { sku_id: 's1', name: 'Nova Atta 5kg', last30: 340, prior30: 279, trendPct: 22, suggested_qty: 414 },
        { sku_id: 's2', name: 'Nova Poha 1kg', last30: 190, prior30: 205, trendPct: -7, suggested_qty: 176 },
      ] },
    ],
    rationale: 'Reorder Nova Atta 5kg for Metro first — demand is up 22% and it is the biggest mover; ~414 units covers the next cycle.',
    generated_at: new Date().toISOString(),
  };
}
