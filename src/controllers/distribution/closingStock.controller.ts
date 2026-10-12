/**
 * Daily closing stock — distributor-level physical counts, variance against system on-hand, and admin approval that
 * posts a stock adjustment. Opt-in by data: a distributor with no counts behaves exactly as before.
 *
 * Routes (mounted under /api/v1/distribution/closing-stock, requireModule('distribution_stock')):
 *   GET  /?distributor_id=&date=        worksheet: every SKU with live on-hand + any saved count + variance
 *   POST /                              save counts for a distributor+day (admin/above)
 *   POST /:id/approve                   approve a variance → post the adjustment, mark adjusted (admin/above)
 *   GET  /report?distributor_id=&from=&to=   opening / received / issued / closing / physical / variance per SKU
 */
import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict } from '../../utils';
import { audit } from '../../utils/audit';
import { applyStockDelta } from './stock.controller';
import { fetchRelated } from '../../lib/relations';
import {
  buildWorksheet, cleanCount, variance, canApprove, summarise,
  type SavedCount, type StockOnHand,
} from '../../services/distribution/closingStock.service';

const istDayRangeUtc = (from: string, to: string) => {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const startUtc = new Date(Date.UTC(fy, fm - 1, fd, 0, 0, 0) - 5.5 * 3600 * 1000);
  const endUtc = new Date(Date.UTC(ty, tm - 1, td + 1, 0, 0, 0) - 5.5 * 3600 * 1000); // inclusive of `to`
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIst = () => {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
};

// ── GET / — the day's worksheet ──────────────────────────────────────────────
export const worksheet = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const distributorId = (req.query.distributor_id as string) || '';
  if (!distributorId) return badRequest(res, 'distributor_id is required');
  const date = ISO_DATE.test(String(req.query.date || '')) ? (req.query.date as string) : todayIst();

  const [{ data: stock }, { data: counts }] = await Promise.all([
    supabaseAdmin.from('distribution_distributor_stock')
      .select('sku_id, qty').eq('org_id', user.org_id).eq('distributor_id', distributorId),
    supabaseAdmin.from('distribution_closing_stock')
      .select('id, sku_id, physical_qty, system_qty, variance, status, note')
      .eq('org_id', user.org_id).eq('distributor_id', distributorId).eq('stock_date', date),
  ]);

  const onHand: StockOnHand[] = (stock || []).map((r: any) => ({ sku_id: r.sku_id, qty: Number(r.qty) || 0 }));
  const saved: SavedCount[] = (counts || []).map((r: any) => ({
    sku_id: r.sku_id, physical_qty: Number(r.physical_qty), system_qty: Number(r.system_qty),
    variance: Number(r.variance), status: r.status, id: r.id, note: r.note,
  }));
  const rows = buildWorksheet(onHand, saved);

  const skuById = await fetchRelated('skus', rows.map((r) => r.sku_id), 'name, sku_code, unit');
  const withNames = rows.map((r) => {
    const s = skuById.get(r.sku_id) as { name?: string; sku_code?: string; unit?: string } | undefined;
    return { ...r, sku_name: s?.name ?? null, sku_code: s?.sku_code ?? null, unit: s?.unit ?? null };
  });
  withNames.sort((a, b) => (a.sku_name || '').localeCompare(b.sku_name || ''));

  ok(res, { distributor_id: distributorId, date, rows: withNames, summary: summarise(rows) });
});

// ── POST / — save counts ─────────────────────────────────────────────────────
const saveSchema = z.object({
  distributor_id: z.string().uuid(),
  stock_date: z.string().regex(ISO_DATE).optional(),
  counts: z.array(z.object({
    sku_id: z.string().uuid(),
    physical_qty: z.union([z.number(), z.string()]),
    note: z.string().max(300).optional().nullable(),
  })).min(1).max(1000),
});

export const save = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { distributor_id, counts } = parsed.data;
  const stock_date = parsed.data.stock_date || todayIst();

  // Live on-hand snapshot for each counted SKU.
  const skuIds = Array.from(new Set(counts.map((c) => c.sku_id)));
  const { data: stock } = await supabaseAdmin.from('distribution_distributor_stock')
    .select('sku_id, qty').eq('org_id', user.org_id).eq('distributor_id', distributor_id).in('sku_id', skuIds);
  const sysBySku = new Map<string, number>();
  (stock || []).forEach((r: any) => sysBySku.set(r.sku_id, Number(r.qty) || 0));

  // Rows already adjusted for this day/sku must not be silently overwritten (the adjustment already moved stock).
  const { data: existing } = await supabaseAdmin.from('distribution_closing_stock')
    .select('sku_id, status').eq('org_id', user.org_id).eq('distributor_id', distributor_id).eq('stock_date', stock_date).in('sku_id', skuIds);
  const lockedSku = new Set((existing || []).filter((r: any) => r.status === 'adjusted').map((r: any) => r.sku_id));

  const nowIso = new Date().toISOString();
  const rows = counts
    .map((c) => {
      const physical = cleanCount(c.physical_qty);
      if (physical === null || lockedSku.has(c.sku_id)) return null;
      const systemQty = sysBySku.get(c.sku_id) ?? 0;
      return {
        org_id: user.org_id, client_id: user.client_id ?? null, distributor_id, sku_id: c.sku_id,
        stock_date, system_qty: systemQty, physical_qty: physical,
        variance: (variance(physical, systemQty) ?? 0), status: 'recorded', note: c.note ?? null,
        counted_by: user.id, updated_at: nowIso,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return badRequest(res, 'No valid counts to save');

  const { data, error } = await supabaseAdmin.from('distribution_closing_stock')
    .upsert(rows, { onConflict: 'org_id,distributor_id,sku_id,stock_date' }).select();
  if (error) return badRequest(res, error.message);
  await audit(req, 'closing_stock.save', 'distribution_closing_stock', distributor_id, null, { stock_date, count: rows.length });
  created(res, { saved: data?.length ?? 0, skipped_adjusted: lockedSku.size, rows: data ?? [] }, 'Closing stock saved');
});

// ── POST /:id/approve — post the adjustment ──────────────────────────────────
export const approve = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data: row } = await supabaseAdmin.from('distribution_closing_stock')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!row) return notFound(res, 'Closing-stock entry not found');
  if (row.status === 'adjusted') return conflict(res, 'This count has already been adjusted');
  if (!canApprove({ status: row.status, variance: Number(row.variance) })) {
    return conflict(res, 'Nothing to adjust (variance is zero or not in a recorded state)');
  }

  const delta = Number(row.variance); // physical - system: apply so the balance matches the count
  await applyStockDelta({
    orgId: user.org_id, clientId: user.client_id ?? null, distributorId: row.distributor_id, skuId: row.sku_id,
    delta, reason: 'adjustment', refType: 'closing_stock', refId: row.id,
    note: `Closing-stock adjustment ${row.stock_date} (physical ${row.physical_qty} vs system ${row.system_qty})`,
    createdBy: user.id,
  });

  // The movement applyStockDelta just wrote, keyed by our ref, so the entry can link to its adjustment.
  const { data: mv } = await supabaseAdmin.from('distribution_stock_movements')
    .select('id').eq('org_id', user.org_id).eq('ref_type', 'closing_stock').eq('ref_id', row.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  const { data: updated, error } = await supabaseAdmin.from('distribution_closing_stock')
    .update({ status: 'adjusted', approved_by: user.id, approved_at: new Date().toISOString(), adjustment_movement_id: mv?.id ?? null, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'closing_stock.approve', 'distribution_closing_stock', row.id, { status: row.status }, { status: 'adjusted', delta });
  ok(res, updated, 'Stock adjusted to match the physical count');
});

// ── GET /report — opening / received / issued / closing / physical per SKU ────
export const report = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const distributorId = (req.query.distributor_id as string) || '';
  if (!distributorId) return badRequest(res, 'distributor_id is required');
  const to = ISO_DATE.test(String(req.query.to || '')) ? (req.query.to as string) : todayIst();
  const from = ISO_DATE.test(String(req.query.from || '')) ? (req.query.from as string) : to;
  const { startUtc, endUtc } = istDayRangeUtc(from, to);

  // All movements up to the end of the range, ascending, so we can read opening (last balance before the range).
  const { data: moves } = await supabaseAdmin.from('distribution_stock_movements')
    .select('sku_id, delta, reason, balance_after, created_at')
    .eq('org_id', user.org_id).eq('distributor_id', distributorId)
    .lt('created_at', endUtc).order('created_at', { ascending: true });

  type Agg = { opening: number; received: number; issued: number; lastBalanceBefore: number; lastSeen: number };
  const agg: Record<string, Agg> = {};
  for (const m of (moves || []) as any[]) {
    const a = (agg[m.sku_id] ||= { opening: 0, received: 0, issued: 0, lastBalanceBefore: 0, lastSeen: 0 });
    const d = Number(m.delta) || 0;
    const t = new Date(m.created_at).getTime();
    if (m.created_at < startUtc) {
      a.lastBalanceBefore = Number(m.balance_after) ?? a.lastBalanceBefore;
    } else {
      if (d > 0) a.received += d; else a.issued += Math.abs(d);
      a.lastSeen = t;
    }
  }

  const { data: counts } = await supabaseAdmin.from('distribution_closing_stock')
    .select('sku_id, physical_qty, stock_date, status').eq('org_id', user.org_id).eq('distributor_id', distributorId)
    .gte('stock_date', from).lte('stock_date', to).order('stock_date', { ascending: true });
  const physBySku = new Map<string, { physical: number; date: string; status: string }>();
  for (const c of (counts || []) as any[]) physBySku.set(c.sku_id, { physical: Number(c.physical_qty), date: c.stock_date, status: c.status });

  const skuIds = Array.from(new Set([...Object.keys(agg), ...physBySku.keys()]));
  const skuById = await fetchRelated('skus', skuIds, 'name, sku_code, unit');

  const rows = skuIds.map((skuId) => {
    const a = agg[skuId] || { opening: 0, received: 0, issued: 0, lastBalanceBefore: 0, lastSeen: 0 };
    const opening = a.lastBalanceBefore;
    const closingSystem = opening + a.received - a.issued;
    const phys = physBySku.get(skuId);
    const s = skuById.get(skuId) as { name?: string; sku_code?: string; unit?: string } | undefined;
    return {
      sku_id: skuId, sku_name: s?.name ?? null, sku_code: s?.sku_code ?? null, unit: s?.unit ?? null,
      opening_qty: opening, received_qty: a.received, issued_qty: a.issued,
      closing_system_qty: closingSystem,
      physical_qty: phys ? phys.physical : null,
      physical_date: phys ? phys.date : null,
      variance: phys ? phys.physical - closingSystem : null,
      status: phys ? phys.status : 'uncounted',
    };
  }).sort((x, y) => (x.sku_name || '').localeCompare(y.sku_name || ''));

  ok(res, { distributor_id: distributorId, from, to, rows });
});
