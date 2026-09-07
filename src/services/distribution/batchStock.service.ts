import { supabaseAdmin } from '../../lib/supabase';
import { applyStockDelta } from '../../controllers/distribution/stock.controller';

/**
 * Batch/lot stock engine for the distributor ledger (modules
 * `distribution_receiving` + `distribution_batches`).
 *
 * A batch is a dated, costed layer of on-hand stock
 * (`distribution_stock_batches`). Receipts create layers; consumption draws
 * them down FEFO (soonest expiry first, FIFO fallback for no-expiry layers) or
 * FIFO (earliest received). Every change also flows through `applyStockDelta`,
 * so the flat running balance in `distribution_distributor_stock.qty` stays in
 * sync as the total of the open layers, and the movement ledger records which
 * batch each delta touched (`distribution_stock_movements.batch_id`).
 *
 * Batch tracking is OPT-IN per SKU (`skus.track_batches`) — callers decide when
 * to route through this engine; non-batched SKUs keep the existing flat flow.
 */

export type RotationStrategy = 'fefo' | 'fifo';

export interface BatchRow {
  id: string; org_id: string; client_id: string | null; distributor_id: string; sku_id: string;
  batch_no: string | null; mfg_date: string | null; expiry_date: string | null;
  received_at: string; qty_received: number; qty_remaining: number; unit_cost: number | null;
  reference: string | null; created_by: string | null; created_at: string; updated_at: string;
}

/** Receive a batch/lot into a distributor: create a dated, costed layer and
 *  increment the flat on-hand balance (+ a `grn` movement). */
export async function receiveBatch(opts: {
  orgId: string; clientId: string | null; distributorId: string; skuId: string; qty: number;
  batchNo?: string | null; expiryDate?: string | null; mfgDate?: string | null;
  unitCost?: number | null; reference?: string | null; createdBy?: string | null;
}): Promise<{ batch: BatchRow; balance: number }> {
  if (!(opts.qty > 0)) throw new Error('qty must be a positive number');
  const { data: batch, error } = await supabaseAdmin.from('distribution_stock_batches').insert({
    org_id: opts.orgId, client_id: opts.clientId, distributor_id: opts.distributorId, sku_id: opts.skuId,
    batch_no: opts.batchNo ?? null, mfg_date: opts.mfgDate ?? null, expiry_date: opts.expiryDate ?? null,
    qty_received: opts.qty, qty_remaining: opts.qty, unit_cost: opts.unitCost ?? null,
    reference: opts.reference ?? null, created_by: opts.createdBy ?? null,
  }).select().single();
  if (error || !batch) throw new Error(error?.message || 'Failed to create batch');
  const b = batch as BatchRow;
  const balance = await applyStockDelta({
    orgId: opts.orgId, clientId: opts.clientId, distributorId: opts.distributorId, skuId: opts.skuId,
    delta: opts.qty, reason: 'grn', refType: 'grn', refId: b.id,
    note: opts.reference ?? null, createdBy: opts.createdBy ?? null, batchId: b.id,
  });
  return { batch: b, balance };
}

export interface ConsumedLayer {
  batch_id: string; batch_no: string | null; qty: number; unit_cost: number | null; expiry_date: string | null;
}

/** Draw `qty` down from a distributor's open batches using the rotation
 *  strategy (default FEFO), decrementing each layer + the flat balance (one
 *  movement per layer) and returning the layers consumed plus a weighted cost
 *  total (valuation). Throws if there isn't enough batch stock.
 *
 *  NOTE: not wrapped in a single DB transaction (supabase-js). Each layer is
 *  decremented together with its balance movement, so a mid-loop failure leaves
 *  batch + flat balance consistent up to that point; hardening to an atomic
 *  RPC is a follow-up. */
export async function consumeStock(opts: {
  orgId: string; clientId: string | null; distributorId: string; skuId: string; qty: number;
  strategy?: RotationStrategy; reason?: 'sale' | 'consume' | 'damage' | 'van_load';
  refType?: string | null; refId?: string | null; note?: string | null; createdBy?: string | null;
}): Promise<{ consumed: ConsumedLayer[]; totalCost: number; balance: number }> {
  if (!(opts.qty > 0)) throw new Error('qty must be a positive number');
  const strategy: RotationStrategy = opts.strategy ?? 'fefo';

  // Open layers in draw-down order. FEFO: soonest expiry first (no-expiry layers
  // last), then earliest received. FIFO: earliest received only.
  let q = supabaseAdmin.from('distribution_stock_batches').select('*')
    .eq('org_id', opts.orgId).eq('distributor_id', opts.distributorId).eq('sku_id', opts.skuId)
    .gt('qty_remaining', 0);
  q = strategy === 'fefo'
    ? q.order('expiry_date', { ascending: true, nullsFirst: false }).order('received_at', { ascending: true })
    : q.order('received_at', { ascending: true });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const layers = (data || []) as BatchRow[];

  const available = layers.reduce((s, b) => s + Number(b.qty_remaining || 0), 0);
  if (available < opts.qty) throw new Error(`Insufficient batch stock: need ${opts.qty}, have ${available}`);

  let remaining = opts.qty;
  let totalCost = 0;
  let balance = available; // fallback if no layers touched (guarded above)
  const consumed: ConsumedLayer[] = [];

  for (const b of layers) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.qty_remaining));
    if (take <= 0) continue;
    await supabaseAdmin.from('distribution_stock_batches')
      .update({ qty_remaining: Number(b.qty_remaining) - take, updated_at: new Date().toISOString() })
      .eq('id', b.id);
    balance = await applyStockDelta({
      orgId: opts.orgId, clientId: opts.clientId, distributorId: opts.distributorId, skuId: opts.skuId,
      delta: -take, reason: opts.reason ?? 'consume', refType: opts.refType ?? null, refId: opts.refId ?? null,
      note: opts.note ?? null, createdBy: opts.createdBy ?? null, batchId: b.id,
    });
    totalCost += take * Number(b.unit_cost ?? 0);
    consumed.push({ batch_id: b.id, batch_no: b.batch_no, qty: take, unit_cost: b.unit_cost, expiry_date: b.expiry_date });
    remaining -= take;
  }
  return { consumed, totalCost, balance };
}

export type BatchStatus = 'active' | 'near_expiry' | 'expired';

/** List batches for a distributor (optionally one SKU), annotating each with a
 *  derived expiry `status` and `days_to_expiry`. Default near-expiry window is
 *  30 days, overridable per SKU via `skus.expiry_alert_days`. */
export async function listBatches(opts: {
  orgId: string; distributorId?: string | null; skuId?: string | null;
  status?: BatchStatus | 'all'; nearDays?: number; includeEmpty?: boolean;
}): Promise<Array<BatchRow & { status: BatchStatus; days_to_expiry?: number; sku_name: string | null; sku_code: string | null }>> {
  let q = supabaseAdmin.from('distribution_stock_batches')
    .select('*, skus:sku_id(name, sku_code, category, expiry_alert_days)')
    .eq('org_id', opts.orgId)
    .order('expiry_date', { ascending: true, nullsFirst: false })
    .order('received_at', { ascending: true });
  if (opts.distributorId) q = q.eq('distributor_id', opts.distributorId);
  if (opts.skuId) q = q.eq('sku_id', opts.skuId);
  if (!opts.includeEmpty) q = q.gt('qty_remaining', 0);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const near = opts.nearDays ?? 30;
  const rows = (data || []).map((raw: unknown) => {
    const b = raw as BatchRow & { skus?: { name?: string; sku_code?: string; expiry_alert_days?: number | null } };
    let status: BatchStatus = 'active';
    let days_to_expiry: number | undefined;
    if (b.expiry_date) {
      const exp = new Date(b.expiry_date); exp.setHours(0, 0, 0, 0);
      days_to_expiry = Math.round((exp.getTime() - today.getTime()) / 86400000);
      const threshold = b.skus?.expiry_alert_days ?? near;
      if (days_to_expiry < 0) status = 'expired';
      else if (days_to_expiry <= threshold) status = 'near_expiry';
    }
    return { ...b, status, days_to_expiry, sku_name: b.skus?.name ?? null, sku_code: b.skus?.sku_code ?? null };
  });
  if (opts.status && opts.status !== 'all') return rows.filter((r) => r.status === opts.status);
  return rows;
}

/** Near-expiry + expired split for a distributor (or the whole org). */
export async function expiryReport(opts: { orgId: string; distributorId?: string | null; withinDays?: number }) {
  const all = await listBatches({
    orgId: opts.orgId, distributorId: opts.distributorId ?? null, status: 'all', nearDays: opts.withinDays ?? 30,
  });
  return {
    near_expiry: all.filter((r) => r.status === 'near_expiry'),
    expired: all.filter((r) => r.status === 'expired'),
  };
}
