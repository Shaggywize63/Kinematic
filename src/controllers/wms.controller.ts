// ═══════════════════════════════════════════════════════════
// src/controllers/wms.controller.ts
// Warehouse Management System — warehouses + inventory movements
// ═══════════════════════════════════════════════════════════
import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { ok, created, badRequest, notFound } from '../utils/response';

/* ─────────────────────────────────────────────────────────────
   WAREHOUSES
───────────────────────────────────────────────────────────── */

/** GET /api/v1/warehouses */
export const listWarehouses = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .select('*, manager:manager_id(id, name)')
    .eq('org_id', org_id)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data || []);
});

/** GET /api/v1/warehouses/:id */
export const getWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .select('*, manager:manager_id(id, name)')
    .eq('id', id).eq('org_id', org_id).single();
  if (error || !data) return notFound(res, 'Warehouse not found');
  return ok(res, data);
});

/** POST /api/v1/warehouses */
export const createWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const body = req.body;
  if (!body.warehouse_code) return badRequest(res, 'warehouse_code is required');
  if (!body.name)           return badRequest(res, 'name is required');
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .insert({ ...body, org_id })
    .select('*, manager:manager_id(id, name)')
    .single();
  if (error) return badRequest(res, error.message);
  return created(res, data);
});

/** PATCH /api/v1/warehouses/:id */
export const updateWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { id } = req.params;
  const { org_id: _, ...rest } = req.body;
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .update({ ...rest, updated_at: new Date().toISOString() })
    .eq('id', id).eq('org_id', org_id)
    .select('*, manager:manager_id(id, name)')
    .single();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Warehouse not found');
  return ok(res, data);
});

/** DELETE /api/v1/warehouses/:id */
export const deleteWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from('warehouses').delete().eq('id', id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { deleted: true });
});

/* ─────────────────────────────────────────────────────────────
   INVENTORY MOVEMENTS
───────────────────────────────────────────────────────────── */

/** GET /api/v1/warehouses/:warehouseId/movements
 *  query: ?type=inbound&limit=50&offset=0
 */
export const listMovements = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { warehouseId } = req.params;
  const limit  = Math.min(Number(req.query.limit)  || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const type   = req.query.type as string | undefined;

  let q = supabaseAdmin
    .from('inventory_movements')
    .select(`
      *,
      sku:sku_id(id, sku_code, name, unit),
      performer:performed_by(id, name, employee_id),
      asset:asset_id(id, name, asset_code)
    `)
    .eq('org_id', org_id)
    .eq('warehouse_id', warehouseId)
    .order('moved_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) q = q.eq('movement_type', type);

  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data || []);
});

/** POST /api/v1/warehouses/:warehouseId/movements */
export const createMovement = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: user_id } = req.user!;
  const { warehouseId } = req.params;
  const body = req.body;

  if (!body.movement_type) return badRequest(res, 'movement_type is required');
  if (!body.quantity)       return badRequest(res, 'quantity is required');

  const validTypes = ['inbound', 'outbound', 'transfer', 'adjustment', 'damage'];
  if (!validTypes.includes(body.movement_type))
    return badRequest(res, `movement_type must be one of: ${validTypes.join(', ')}`);

  const payload = {
    ...body,
    org_id,
    warehouse_id: warehouseId,
    performed_by: body.performed_by || user_id,
    moved_at:     body.moved_at     || new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('inventory_movements')
    .insert(payload)
    .select(`
      *,
      sku:sku_id(id, sku_code, name, unit),
      performer:performed_by(id, name, employee_id),
      asset:asset_id(id, name, asset_code)
    `)
    .single();
  if (error) return badRequest(res, error.message);
  return created(res, data);
});

/* ─────────────────────────────────────────────────────────────
   WMS SUMMARY   GET /api/v1/warehouses/summary
   Returns per-warehouse inventory totals and recent movement counts
───────────────────────────────────────────────────────────── */
export const getWmsSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;

  // warehouses
  const { data: whs, error: whErr } = await supabaseAdmin
    .from('warehouses')
    .select('id, name, warehouse_code, type, city, is_active')
    .eq('org_id', org_id);
  if (whErr) return badRequest(res, whErr.message);

  // all movements for this org (last 30 days)
  const since30 = new Date();
  since30.setDate(since30.getDate() - 30);
  const { data: movements, error: mErr } = await supabaseAdmin
    .from('inventory_movements')
    .select('warehouse_id, movement_type, quantity, moved_at')
    .eq('org_id', org_id)
    .gte('moved_at', since30.toISOString());
  if (mErr) return badRequest(res, mErr.message);

  // aggregate per warehouse
  const mvMap: Record<string, { inbound: number; outbound: number; total_moves: number }> = {};
  (movements || []).forEach((m) => {
    const wid = m.warehouse_id;
    if (!mvMap[wid]) mvMap[wid] = { inbound: 0, outbound: 0, total_moves: 0 };
    mvMap[wid].total_moves++;
    if (m.movement_type === 'inbound')  mvMap[wid].inbound  += m.quantity;
    if (m.movement_type === 'outbound') mvMap[wid].outbound += m.quantity;
  });

  // skus count
  const { count: skuCount } = await supabaseAdmin
    .from('skus').select('*', { count: 'exact', head: true }).eq('org_id', org_id);

  // assets count
  const { count: assetCount } = await supabaseAdmin
    .from('assets').select('*', { count: 'exact', head: true }).eq('org_id', org_id).eq('is_active', true);

  const warehousesWithStats = (whs || []).map((wh) => ({
    ...wh,
    stats: mvMap[wh.id] || { inbound: 0, outbound: 0, total_moves: 0 },
  }));

  return ok(res, {
    warehouses:   warehousesWithStats,
    total_warehouses: (whs || []).length,
    active_warehouses: (whs || []).filter((w) => w.is_active).length,
    total_skus:    skuCount  ?? 0,
    total_assets:  assetCount ?? 0,
    total_movements_30d: (movements || []).length,
  });
});
