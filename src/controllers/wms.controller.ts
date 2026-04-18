// ═══════════════════════════════════════════════════════════
// src/controllers/wms.controller.ts
// ═══════════════════════════════════════════════════════════
import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, isDemo } from '../utils';
import { getMockWarehouses, getMockWMSSummary, getMockWMSInventory } from '../utils/demoData';

const MOVEMENT_SELECT = `
  *,
  sku:sku_id(id, sku_code, name, unit),
  performer:performed_by(id, name, employee_id),
  asset:asset_id(id, name, asset_code)
`;

/* ── WAREHOUSES ─────────────────────────────────────────── */

export const listWarehouses = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, getMockWarehouses());
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .select('*, manager:manager_id(id, name)')
    .eq('org_id', org_id)
    .order('created_at', { ascending: false });
  if (error) { badRequest(res, error.message); return; }
  ok(res, data || []);
});

export const getWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, getMockWarehouses()[0]);
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .select('*, manager:manager_id(id, name)')
    .eq('id', id).eq('org_id', org_id).single();
  if (error || !data) { notFound(res, 'Warehouse not found'); return; }
  ok(res, data);
});

export const createWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return created(res, { id: 'demo-wh' }, 'Warehouse created (Demo)');
  const body = req.body;
  if (!body.warehouse_code) { badRequest(res, 'warehouse_code is required'); return; }
  if (!body.name)           { badRequest(res, 'name is required'); return; }
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .insert({ ...body, org_id })
    .select('*, manager:manager_id(id, name)')
    .single();
  if (error) { badRequest(res, error.message); return; }
  created(res, data);
});

export const updateWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { id: req.params.id }, 'Warehouse updated (Demo)');
  const { id } = req.params;
  const { org_id: _, ...rest } = req.body;
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .update({ ...rest, updated_at: new Date().toISOString() })
    .eq('id', id).eq('org_id', org_id)
    .select('*, manager:manager_id(id, name)')
    .single();
  if (error) { badRequest(res, error.message); return; }
  if (!data) { notFound(res, 'Warehouse not found'); return; }
  ok(res, data);
});

export const deleteWarehouse = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { deleted: true }, 'Warehouse deleted (Demo)');
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from('warehouses').delete().eq('id', id).eq('org_id', org_id);
  if (error) { badRequest(res, error.message); return; }
  ok(res, { deleted: true });
});

/* ── INVENTORY MOVEMENTS ────────────────────────────────── */

export const listMovements = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, []);
  const { warehouseId } = req.params;
  const limit  = Math.min(Number(req.query.limit)  || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const type   = req.query.type as string | undefined;

  let q = supabaseAdmin
    .from('inventory_movements')
    .select(MOVEMENT_SELECT)
    .eq('org_id', org_id)
    .eq('warehouse_id', warehouseId)
    .order('moved_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) q = q.eq('movement_type', type);

  const { data, error } = await q;
  if (error) { badRequest(res, error.message); return; }
  ok(res, data || []);
});

export const createMovement = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: user_id } = req.user!;
  if (isDemo(req.user)) return created(res, { id: 'demo-mv' }, 'Movement created (Demo)');
  const { warehouseId } = req.params;
  const body = req.body;

  if (!body.movement_type) { badRequest(res, 'movement_type is required'); return; }
  if (!body.quantity)       { badRequest(res, 'quantity is required'); return; }

  const validTypes = ['inbound', 'outbound', 'transfer', 'adjustment', 'damage'];
  if (!validTypes.includes(body.movement_type)) {
    badRequest(res, `movement_type must be one of: ${validTypes.join(', ')}`);
    return;
  }

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
    .select(MOVEMENT_SELECT)
    .single();
  if (error) { badRequest(res, error.message); return; }
  created(res, data);
});

/** PATCH /api/v1/warehouses/:warehouseId/movements/:movementId */
export const updateMovement = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { warehouseId, movementId } = req.params;

  const validTypes = ['inbound', 'outbound', 'transfer', 'adjustment', 'damage'];
  const { org_id: _, warehouse_id: __, ...rest } = req.body;

  if (rest.movement_type && !validTypes.includes(rest.movement_type)) {
    badRequest(res, `movement_type must be one of: ${validTypes.join(', ')}`);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('inventory_movements')
    .update(rest)
    .eq('id', movementId)
    .eq('warehouse_id', warehouseId)
    .eq('org_id', org_id)
    .select(MOVEMENT_SELECT)
    .single();

  if (error) { badRequest(res, error.message); return; }
  if (!data) { notFound(res, 'Movement not found'); return; }
  ok(res, data);
});

/** DELETE /api/v1/warehouses/:warehouseId/movements/:movementId */
export const deleteMovement = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { warehouseId, movementId } = req.params;

  const { error } = await supabaseAdmin
    .from('inventory_movements')
    .delete()
    .eq('id', movementId)
    .eq('warehouse_id', warehouseId)
    .eq('org_id', org_id);

  if (error) { badRequest(res, error.message); return; }
  ok(res, { deleted: true });
});

/* ── WMS SUMMARY ────────────────────────────────────────── */

export const getWmsSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, getMockWMSSummary());

  const { data: whs, error: whErr } = await supabaseAdmin
    .from('warehouses')
    .select('id, name, warehouse_code, type, city, is_active')
    .eq('org_id', org_id);
  if (whErr) { badRequest(res, whErr.message); return; }

  const since30 = new Date();
  since30.setDate(since30.getDate() - 30);
  const { data: movements, error: mErr } = await supabaseAdmin
    .from('inventory_movements')
    .select('warehouse_id, movement_type, quantity, moved_at')
    .eq('org_id', org_id)
    .gte('moved_at', since30.toISOString());
  if (mErr) { badRequest(res, mErr.message); return; }

  const mvMap: Record<string, { inbound: number; outbound: number; total_moves: number }> = {};
  (movements || []).forEach((m) => {
    const wid = m.warehouse_id;
    if (!mvMap[wid]) mvMap[wid] = { inbound: 0, outbound: 0, total_moves: 0 };
    mvMap[wid].total_moves++;
    if (m.movement_type === 'inbound')  mvMap[wid].inbound  += m.quantity;
    if (m.movement_type === 'outbound') mvMap[wid].outbound += Math.abs(m.quantity);
  });

  const { count: skuCount } = await supabaseAdmin
    .from('skus').select('*', { count: 'exact', head: true }).eq('org_id', org_id);

  const { count: assetCount } = await supabaseAdmin
    .from('assets').select('*', { count: 'exact', head: true }).eq('org_id', org_id).eq('is_active', true);

  const warehousesWithStats = (whs || []).map((wh) => ({
    ...wh,
    stats: mvMap[wh.id] || { inbound: 0, outbound: 0, total_moves: 0 },
  }));

  ok(res, {
    warehouses:          warehousesWithStats,
    total_warehouses:    (whs || []).length,
    active_warehouses:   (whs || []).filter((w: any) => w.is_active).length,
    total_skus:          skuCount  ?? 0,
    total_assets:        assetCount ?? 0,
    total_movements_30d: (movements || []).length,
  });
});
