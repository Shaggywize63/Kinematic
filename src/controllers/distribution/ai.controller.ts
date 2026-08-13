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
import { asyncHandler, ok, badRequest, isDemo } from '../../utils';
import { complete as aiComplete } from '../../services/crm/ai/aiClient';

const num = (v: unknown) => Number(v || 0);
const DAY = 86_400_000;
const MODEL = process.env.DIST_AI_MODEL || 'claude-haiku-4-5';

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

// ── Velocity engine (shared by replenishment + ask) ─────────────────────────
async function computeVelocity(org_id: string) {
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY).toISOString();
  const since60 = new Date(now - 60 * DAY).toISOString();

  const { data: ordersRaw } = await supabaseAdmin
    .from('orders')
    .select('id, distributor_id, placed_at')
    .eq('org_id', org_id).neq('status', 'cancelled').gte('placed_at', since60).limit(5000);
  const orders = (ordersRaw as any[]) || [];
  const placedById = new Map<string, string>();
  const distById = new Map<string, string>();
  for (const o of orders) { placedById.set(o.id, o.placed_at); if (o.distributor_id) distById.set(o.id, o.distributor_id); }

  const ids = Array.from(placedById.keys());
  const agg = new Map<string, { q30: number; qPrior: number }>(); // key = distributor|sku
  if (ids.length) {
    const { data: items } = await supabaseAdmin.from('order_items').select('order_id, sku_id, qty').in('order_id', ids).limit(20000);
    for (const it of (items as any[]) || []) {
      const placed = placedById.get(it.order_id); const dist = distById.get(it.order_id);
      if (!placed || !dist || !it.sku_id) continue;
      const k = `${dist}|${it.sku_id}`;
      const rec = agg.get(k) || { q30: 0, qPrior: 0 };
      if (placed >= since30) rec.q30 += num(it.qty); else rec.qPrior += num(it.qty);
      agg.set(k, rec);
    }
  }
  return agg;
}

async function nameMaps(org_id: string, distIds: string[], skuIds: string[]) {
  const dist = new Map<string, string>(); const sku = new Map<string, string>();
  if (distIds.length) {
    const { data } = await supabaseAdmin.from('distributors').select('id, name').eq('org_id', org_id).in('id', distIds);
    for (const d of (data as any[]) || []) dist.set(d.id, d.name || 'Distributor');
  }
  if (skuIds.length) {
    const { data } = await supabaseAdmin.from('skus').select('id, name, sku_code').in('id', skuIds);
    for (const s of (data as any[]) || []) sku.set(s.id, s.name || s.sku_code || 'SKU');
  }
  return { dist, sku };
}

// ── Replenishment agent ─────────────────────────────────────────────────────
export const replenishment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, demoReplenishment());

  const agg = await computeVelocity(org_id);
  const distIds = new Set<string>(); const skuIds = new Set<string>();
  for (const k of agg.keys()) { const [d, s] = k.split('|'); distIds.add(d); skuIds.add(s); }
  const { dist, sku } = await nameMaps(org_id, Array.from(distIds), Array.from(skuIds));

  // Group projected next-30d demand per distributor, keep the meaningful movers.
  const byDist = new Map<string, Array<{ sku_id: string; name: string; last30: number; prior30: number; trendPct: number; suggested_qty: number }>>();
  for (const [k, v] of agg.entries()) {
    const [d, s] = k.split('|');
    if (v.q30 <= 0) continue;
    const ratio = v.qPrior > 0 ? v.q30 / v.qPrior : 1;
    const trendPct = v.qPrior > 0 ? Math.round((ratio - 1) * 100) : 100;
    const suggested_qty = Math.max(1, Math.round(v.q30 * Math.min(1.5, Math.max(0.8, ratio)))); // projected next-30d, damped
    const arr = byDist.get(d) || [];
    arr.push({ sku_id: s, name: sku.get(s) || 'SKU', last30: v.q30, prior30: v.qPrior, trendPct, suggested_qty });
    byDist.set(d, arr);
  }

  const suggestions = Array.from(byDist.entries()).map(([d, items]) => ({
    distributor_id: d,
    distributor_name: dist.get(d) || 'Distributor',
    items: items.sort((a, b) => b.last30 - a.last30).slice(0, 6),
    total_units: items.reduce((s, i) => s + i.suggested_qty, 0),
  })).sort((a, b) => b.total_units - a.total_units).slice(0, 10);

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
