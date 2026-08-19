import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { applyStockDelta } from './stock.controller';

/**
 * Van sales load-in / load-out (module `distribution_van`).
 *
 * A rep opens a van load at the start of the day (load-in: loaded_qty per SKU),
 * sells from the van during the beat (the existing /salesman/orders flow), and
 * reconciles at the end (load-out: physical returned + damaged per SKU). Sold is
 * computed physically (loaded − returned − damaged), so the closing count is a
 * hard reconciliation of what actually left the van — the number Bizom/FieldAssist
 * only estimate from an EOD report.
 *
 * If the load names a source distributor, load-in draws from that distributor's
 * on-hand stock and returns/damage flow back, keeping distributor stock truthful.
 */

const itemSchema = z.object({ sku_id: z.string().uuid(), loaded_qty: z.number().int().nonnegative() });
const createSchema = z.object({
  user_id: z.string().uuid().optional(),
  distributor_id: z.string().uuid().nullable().optional(),
  route_plan_id: z.string().uuid().nullable().optional(),
  load_date: z.string().optional(),
  notes: z.string().max(1000).optional(),
  items: z.array(itemSchema).min(1),
});
const reconcileSchema = z.object({
  items: z.array(z.object({
    sku_id: z.string().uuid(),
    returned_qty: z.number().int().nonnegative().optional(),
    damaged_qty: z.number().int().nonnegative().optional(),
  })).min(1),
  notes: z.string().max(1000).optional(),
});

async function loadWithItems(orgId: string, id: string) {
  const { data } = await supabaseAdmin.from('distribution_van_loads')
    .select('*, items:distribution_van_load_items(*, skus:sku_id(name, sku_code))')
    .eq('id', id).eq('org_id', orgId).maybeSingle();
  return data as any;
}

const sum = (arr: any[], f: (x: any) => number) => (arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0);
function totals(items: any[]) {
  return {
    loaded: sum(items, (i) => i.loaded_qty),
    sold: sum(items, (i) => i.sold_qty),
    returned: sum(items, (i) => i.returned_qty),
    damaged: sum(items, (i) => i.damaged_qty),
  };
}

// ── GET /distribution/van-loads (admin) — filter user/status/date ─────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('distribution_van_loads')
    .select('*, items:distribution_van_load_items(loaded_qty, sold_qty, returned_qty, damaged_qty)')
    .eq('org_id', user.org_id)
    .order('load_date', { ascending: false }).order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit as string) || 100, 300));
  if (req.query.user_id) q = q.eq('user_id', req.query.user_id as string);
  if (req.query.status) q = q.eq('status', req.query.status as string);
  if (req.query.load_date) q = q.eq('load_date', req.query.load_date as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  const rows = (data || []).map((r: any) => ({ ...r, totals: totals(r.items || []), items: undefined }));
  ok(res, rows);
});

// ── GET /distribution/van-loads/:id ───────────────────────────────────────────
export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const data = await loadWithItems(user.org_id, req.params.id);
  if (!data) return notFound(res, 'Van load not found');
  ok(res, { ...data, totals: totals(data.items || []) });
});

// ── GET /salesman/van-load/today — the rep's open load for today (or null) ────
export const today = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, null);
  const { data } = await supabaseAdmin.from('distribution_van_loads')
    .select('*, items:distribution_van_load_items(*, skus:sku_id(name, sku_code))')
    .eq('org_id', user.org_id).eq('user_id', user.id).eq('status', 'open')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  ok(res, data ? { ...data, totals: totals((data as any).items || []) } : null);
});

// ── POST /distribution/van-loads  &  POST /salesman/van-load — load-in ────────
export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const b = parsed.data;
  const repId = b.user_id ?? user.id;

  const { data: load, error } = await supabaseAdmin.from('distribution_van_loads').insert({
    org_id: user.org_id, client_id: user.client_id ?? null, user_id: repId,
    distributor_id: b.distributor_id ?? null, route_plan_id: b.route_plan_id ?? null,
    load_date: b.load_date ?? new Date().toISOString().slice(0, 10),
    status: 'open', notes: b.notes ?? null, created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);

  const rows = b.items.filter((i) => i.loaded_qty > 0).map((i) => ({
    van_load_id: load.id, org_id: user.org_id, sku_id: i.sku_id, loaded_qty: i.loaded_qty,
  }));
  if (rows.length) await supabaseAdmin.from('distribution_van_load_items').insert(rows);

  // Van draws from the source distributor's on-hand stock, if one is named.
  if (b.distributor_id) {
    for (const i of rows) {
      await applyStockDelta({
        orgId: user.org_id, clientId: user.client_id ?? null, distributorId: b.distributor_id,
        skuId: i.sku_id, delta: -i.loaded_qty, reason: 'van_load', refType: 'van_load', refId: load.id,
        createdBy: user.id,
      });
    }
  }
  await audit(req, 'van_load.create', 'distribution_van_loads', load.id, null, { items: rows.length });
  const full = await loadWithItems(user.org_id, load.id);
  created(res, { ...full, totals: totals(full.items || []) }, 'Van loaded');
});

// ── POST /distribution/van-loads/:id/reconcile  &  /salesman/... — load-out ───
export const reconcile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = reconcileSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  const load = await loadWithItems(user.org_id, req.params.id);
  if (!load) return notFound(res, 'Van load not found');
  if (load.status === 'closed') return conflict(res, 'Van load is already closed');

  const byId = new Map<string, any>((load.items || []).map((it: any) => [it.sku_id, it]));
  for (const inp of parsed.data.items) {
    const it = byId.get(inp.sku_id);
    if (!it) continue;
    const returned = Math.max(0, inp.returned_qty ?? 0);
    const damaged = Math.max(0, inp.damaged_qty ?? 0);
    const sold = Math.max(0, (it.loaded_qty ?? 0) - returned - damaged);
    await supabaseAdmin.from('distribution_van_load_items')
      .update({ returned_qty: returned, damaged_qty: damaged, sold_qty: sold, updated_at: new Date().toISOString() })
      .eq('id', it.id);
    // Unsold physically returned to the van → back into distributor on-hand.
    if (load.distributor_id && returned > 0) {
      await applyStockDelta({
        orgId: user.org_id, clientId: user.client_id ?? null, distributorId: load.distributor_id,
        skuId: inp.sku_id, delta: returned, reason: 'van_return', refType: 'van_load', refId: load.id, createdBy: user.id,
      });
    }
  }

  await supabaseAdmin.from('distribution_van_loads')
    .update({ status: 'reconciled', notes: parsed.data.notes ?? load.notes, updated_at: new Date().toISOString() })
    .eq('id', load.id);
  await audit(req, 'van_load.reconcile', 'distribution_van_loads', load.id, null, null);
  const full = await loadWithItems(user.org_id, load.id);
  ok(res, { ...full, totals: totals(full.items || []) }, 'Van reconciled');
});

// ── POST /distribution/van-loads/:id/close ────────────────────────────────────
export const close = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin.from('distribution_van_loads')
    .update({ status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id).select().maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Van load not found');
  await audit(req, 'van_load.close', 'distribution_van_loads', data.id, null, null);
  ok(res, data, 'Van load closed');
});
