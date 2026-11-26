/**
 * Order → inventory coupling.
 *
 * When a distribution order is PUNCHED (created with status 'placed'), the
 * stock it consumes is deducted from the client's CENTRAL WAREHOUSE — a single
 * `distributors` row flagged `is_central_warehouse` that holds the client's own
 * on-hand inventory (e.g. Vanrakshak's "A&S Warehouse"). Cancelling a punched
 * order restores it.
 *
 * This is gated entirely on the client HAVING a central warehouse: if none is
 * configured, every function here is a no-op, so the Tata tenant and every
 * other client's order flow is unchanged. The deduction reuses the existing
 * `applyStockDelta` primitive, so each change lands in
 * `distribution_distributor_stock` AND the `distribution_stock_movements`
 * audit ledger (reason 'sale' on punch, 'return' on cancel).
 *
 * Best-effort: a stock hiccup never blocks placing or cancelling an order.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { applyStockDelta } from '../../controllers/distribution/stock.controller';
import { logger } from '../../lib/logger';

interface OrderLike { id: string; org_id: string; client_id: string | null }
interface ItemLike { sku_id: string | null; qty: number | null }

// The client's central-warehouse distributor id, or null when none is set
// (⇒ inventory tracking is OFF for this client, leaving its orders untouched).
async function centralWarehouseId(orgId: string, clientId: string | null): Promise<string | null> {
  let q = supabaseAdmin.from('distributors').select('id')
    .eq('org_id', orgId).eq('is_central_warehouse', true).eq('is_active', true);
  if (clientId) q = q.eq('client_id', clientId);
  const { data } = await q.limit(1).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Deduct each line's qty from the central warehouse for a just-punched order.
 * Called right after the order_items are written, in both order-creation paths.
 */
export async function decrementForOrder(order: OrderLike, items: ItemLike[], userId?: string | null): Promise<void> {
  try {
    const wh = await centralWarehouseId(order.org_id, order.client_id);
    if (!wh) return; // no central warehouse → feature off for this client
    for (const it of items) {
      const qty = Number(it.qty) || 0;
      if (!it.sku_id || qty <= 0) continue;
      await applyStockDelta({
        orgId: order.org_id, clientId: order.client_id, distributorId: wh, skuId: it.sku_id,
        delta: -Math.abs(qty), reason: 'sale', refType: 'order', refId: order.id,
        createdBy: userId ?? null, note: 'Order punched',
      });
    }
  } catch (e) {
    logger.warn(`[orderStock] decrement failed for order ${order.id}: ${(e as Error).message}`);
  }
}

/**
 * Restore stock for a cancelled order — but only if it was actually decremented
 * (a 'sale' movement exists for it) and hasn't already been restored. Idempotent,
 * so a double-cancel or a retry never double-credits.
 */
export async function restoreForOrder(orderId: string, userId?: string | null): Promise<void> {
  try {
    const { data: order } = await supabaseAdmin.from('orders')
      .select('id, org_id, client_id').eq('id', orderId).maybeSingle();
    if (!order) return;
    const o = order as OrderLike;
    const wh = await centralWarehouseId(o.org_id, o.client_id);
    if (!wh) return;

    const { data: priorSale } = await supabaseAdmin.from('distribution_stock_movements')
      .select('id').eq('ref_type', 'order').eq('ref_id', orderId).eq('reason', 'sale').limit(1);
    if (!priorSale || priorSale.length === 0) return; // never decremented → nothing to restore
    const { data: already } = await supabaseAdmin.from('distribution_stock_movements')
      .select('id').eq('ref_type', 'order_cancel').eq('ref_id', orderId).limit(1);
    if (already && already.length > 0) return; // already restored

    const { data: items } = await supabaseAdmin.from('order_items')
      .select('sku_id, qty').eq('order_id', orderId);
    for (const it of (items ?? []) as ItemLike[]) {
      const qty = Number(it.qty) || 0;
      if (!it.sku_id || qty <= 0) continue;
      await applyStockDelta({
        orgId: o.org_id, clientId: o.client_id, distributorId: wh, skuId: it.sku_id,
        delta: Math.abs(qty), reason: 'return', refType: 'order_cancel', refId: orderId,
        createdBy: userId ?? null, note: 'Order cancelled',
      });
    }
  } catch (e) {
    logger.warn(`[orderStock] restore failed for order ${orderId}: ${(e as Error).message}`);
  }
}
