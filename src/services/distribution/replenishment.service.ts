// ═══════════════════════════════════════════════════════════
// src/services/distribution/replenishment.service.ts
//
// Shared replenishment engine for the distribution AI layer. The velocity
// computation + per-distributor projected demand live here so BOTH the HTTP
// controller (GET /distribution/ai/replenishment, POST …/approve) and the
// auto-mode cron draft the SAME authoritative numbers — no divergence.
//
// A draft order is a reviewable, price-free REPLENISHMENT PLAN for one
// distributor; it never enters the outlet-centric orders/pricing/GST/scheme
// flow, so the live `orders` ledger the velocity engine reads stays clean.
// ═══════════════════════════════════════════════════════════
import { supabaseAdmin } from '../../lib/supabase';
import { knownProjectKeys, runWithProject } from '../../lib/projects';
import { logger } from '../../lib/logger';

const num = (v: unknown) => Number(v || 0);
const DAY = 86_400_000;

export type ReplItem = { sku_id: string; name: string; last30: number; prior30: number; trendPct: number; suggested_qty: number };
export type ReplSuggestion = { distributor_id: string; distributor_name: string; items: ReplItem[]; total_units: number };

// ── Velocity engine (shared by replenishment + ask) ─────────────────────────
export async function computeVelocity(org_id: string) {
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

export async function nameMaps(org_id: string, distIds: string[], skuIds: string[]) {
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

// Shared by the replenishment GET and the approve/cron paths so a draft persists
// the SAME authoritative numbers the suggestion shows — no client-supplied qty.
export async function buildReplenishment(org_id: string): Promise<ReplSuggestion[]> {
  const agg = await computeVelocity(org_id);
  const distIds = new Set<string>(); const skuIds = new Set<string>();
  for (const k of agg.keys()) { const [d, s] = k.split('|'); distIds.add(d); skuIds.add(s); }
  const { dist, sku } = await nameMaps(org_id, Array.from(distIds), Array.from(skuIds));

  // Group projected next-30d demand per distributor, keep the meaningful movers.
  const byDist = new Map<string, ReplItem[]>();
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

  return Array.from(byDist.entries()).map(([d, items]) => ({
    distributor_id: d,
    distributor_name: dist.get(d) || 'Distributor',
    items: items.sort((a, b) => b.last30 - a.last30).slice(0, 6),
    total_units: items.reduce((s, i) => s + i.suggested_qty, 0),
  })).sort((a, b) => b.total_units - a.total_units).slice(0, 10);
}

// Idempotent draft persistence: refreshes the existing OPEN draft for this
// distributor+source instead of piling up duplicates. Returns the row plus the
// prior row (if any) so callers can audit the before/after.
export async function upsertDraftOrder(
  org_id: string,
  s: ReplSuggestion,
  opts: { created_by?: string | null; rationale?: string | null } = {},
): Promise<{ row: any; existing: any }> {
  const payload: any = {
    org_id,
    distributor_id: s.distributor_id,
    distributor_name: s.distributor_name,
    source: 'replenishment_agent',
    status: 'open',
    total_units: s.total_units,
    items: s.items,
    rationale: (opts.rationale ?? null) || null,
    created_by: opts.created_by ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabaseAdmin.from('distribution_draft_orders')
    .select('id').eq('org_id', org_id).eq('distributor_id', s.distributor_id)
    .eq('source', 'replenishment_agent').eq('status', 'open').maybeSingle();

  if (existing?.id) {
    const { data, error } = await supabaseAdmin.from('distribution_draft_orders')
      .update(payload).eq('id', existing.id).eq('org_id', org_id).select().single();
    if (error) throw new Error(error.message);
    return { row: data, existing };
  }
  const { data, error } = await supabaseAdmin.from('distribution_draft_orders')
    .insert(payload).select().single();
  if (error) throw new Error(error.message);
  return { row: data, existing: null };
}

// ── Auto-mode agent (cron) ──────────────────────────────────────────────────
// For every org whose replenishment agent autonomy is 'auto', draft the next
// distributor order from real sell-out velocity. Idempotent (refreshes the open
// draft per distributor). A no-op for any org still on 'suggest'/'approve', so
// production behaviour is unchanged until an admin explicitly opts in. Runs
// against the AMBIENT project — wrap in runWithProject for a specific tenant.
export async function runAutoReplenishment(opts: { org_id?: string } = {}): Promise<{ orgs: number; drafts: number }> {
  let q = supabaseAdmin.from('distribution_agents')
    .select('org_id').eq('agent_key', 'replenishment').eq('autonomy', 'auto');
  if (opts.org_id) q = q.eq('org_id', opts.org_id);
  const { data, error } = await q.limit(1000);
  if (error) { logger.warn(`[auto-replenishment] agents query failed: ${error.message}`); return { orgs: 0, drafts: 0 }; }

  const orgs = Array.from(new Set(((data as any[]) || []).map((r) => r.org_id).filter(Boolean)));
  let drafts = 0;
  for (const org_id of orgs) {
    try {
      const suggestions = await buildReplenishment(org_id);
      for (const s of suggestions) {
        const n = s.items.length;
        await upsertDraftOrder(org_id, s, {
          rationale: `Auto-drafted by the replenishment agent from 30-day sell-out velocity — ${s.total_units} units across ${n} SKU${n === 1 ? '' : 's'}.`,
        });
        drafts += 1;
      }
    } catch (e: any) {
      logger.warn(`[auto-replenishment] org ${org_id} failed: ${e?.message || e}`);
    }
  }
  return { orgs: orgs.length, drafts };
}

// Fan the auto-mode run across every known project (Tata, Kinematic, and any
// runtime client projects). Best-effort per project — one tenant's failure
// (e.g. a project without the distribution tables) never fails the batch.
export async function runAutoReplenishmentAllProjects(): Promise<{ projects: number; orgs: number; drafts: number }> {
  let projects = 0, orgs = 0, drafts = 0;
  for (const key of knownProjectKeys()) {
    try {
      const r = await runWithProject(key, () => runAutoReplenishment());
      projects += 1; orgs += r.orgs; drafts += r.drafts;
    } catch (e: any) {
      logger.warn(`[auto-replenishment] project ${key} failed: ${e?.message || e}`);
    }
  }
  return { projects, orgs, drafts };
}
