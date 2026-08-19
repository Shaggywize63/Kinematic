import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, isDemo } from '../../utils';
import { audit } from '../../utils/audit';

/**
 * Distributor on-hand stock (module `distribution_stock`).
 *
 * The running balance per distributor×sku lives in `distribution_distributor_stock`
 * (qty / reserved). Every change is written through `applyStockDelta`, which also
 * appends an immutable row to `distribution_stock_movements` (the audit ledger).
 * Van load-in / load-out (van.controller) reuses `applyStockDelta` so the van
 * draws from — and returns to — the same distributor balance.
 */

const REASONS = ['receipt', 'sale', 'return', 'damage', 'adjustment', 'van_load', 'van_return'] as const;
export type StockReason = (typeof REASONS)[number];

/**
 * Apply a signed delta to a distributor's on-hand stock for one SKU and append a
 * movement row. Returns the new balance. Best-effort caller-scoped (org/client).
 */
export async function applyStockDelta(opts: {
  orgId: string; clientId: string | null; distributorId: string; skuId: string;
  delta: number; reason: StockReason; refType?: string | null; refId?: string | null;
  note?: string | null; createdBy?: string | null;
}): Promise<number> {
  const { orgId, clientId, distributorId, skuId, delta } = opts;
  const { data: row } = await supabaseAdmin.from('distribution_distributor_stock')
    .select('id, qty').eq('org_id', orgId).eq('distributor_id', distributorId).eq('sku_id', skuId).maybeSingle();

  const prev = row?.qty ?? 0;
  const next = prev + delta;
  if (row) {
    await supabaseAdmin.from('distribution_distributor_stock')
      .update({ qty: next, updated_at: new Date().toISOString() }).eq('id', row.id);
  } else {
    await supabaseAdmin.from('distribution_distributor_stock')
      .insert({ org_id: orgId, client_id: clientId, distributor_id: distributorId, sku_id: skuId, qty: next, reserved: 0 });
  }
  await supabaseAdmin.from('distribution_stock_movements').insert({
    org_id: orgId, client_id: clientId, distributor_id: distributorId, sku_id: skuId,
    delta, reason: opts.reason, ref_type: opts.refType ?? null, ref_id: opts.refId ?? null,
    balance_after: next, note: opts.note ?? null, created_by: opts.createdBy ?? null,
  });
  return next;
}

// ── GET /distribution/stock?distributor_id= — on-hand per SKU ─────────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const distributorId = (req.query.distributor_id as string) || '';
  if (!distributorId) return badRequest(res, 'distributor_id is required');

  const { data, error } = await supabaseAdmin.from('distribution_distributor_stock')
    .select('id, distributor_id, sku_id, qty, reserved, updated_at, skus:sku_id(name, sku_code, category)')
    .eq('org_id', user.org_id).eq('distributor_id', distributorId)
    .order('qty', { ascending: true });
  if (error) return badRequest(res, error.message);
  const lowOnly = req.query.low === '1';
  const rows = (data || []).map((r: any) => ({
    ...r, available: (r.qty ?? 0) - (r.reserved ?? 0),
    sku_name: r.skus?.name ?? null, sku_code: r.skus?.sku_code ?? null, category: r.skus?.category ?? null,
  }));
  ok(res, lowOnly ? rows.filter((r) => r.available <= 0) : rows);
});

// ── GET /distribution/stock/movements?distributor_id= — the audit ledger ──────
export const movements = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('distribution_stock_movements')
    .select('*, skus:sku_id(name, sku_code)')
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit as string) || 100, 500));
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.sku_id) q = q.eq('sku_id', req.query.sku_id as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

// ── POST /distribution/stock/adjust — manual receipt / adjustment ─────────────
const adjustSchema = z.object({
  distributor_id: z.string().uuid(),
  sku_id: z.string().uuid(),
  delta: z.number().int(),
  reason: z.enum(REASONS).optional(),
  note: z.string().max(500).optional(),
});
export const adjust = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const b = parsed.data;
  if (b.delta === 0) return badRequest(res, 'delta must be non-zero');
  const balance = await applyStockDelta({
    orgId: user.org_id, clientId: user.client_id ?? null, distributorId: b.distributor_id, skuId: b.sku_id,
    delta: b.delta, reason: b.reason ?? (b.delta > 0 ? 'receipt' : 'adjustment'),
    refType: 'manual', note: b.note ?? null, createdBy: user.id,
  });
  await audit(req, 'distributor_stock.adjust', 'distribution_distributor_stock', b.distributor_id, null, { ...b, balance });
  created(res, { distributor_id: b.distributor_id, sku_id: b.sku_id, balance }, 'Stock adjusted');
});
