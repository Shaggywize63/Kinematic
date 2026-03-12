import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

export const getWarehouseSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  const { data, error } = await supabaseAdmin
    .from('warehouse_inventory')
    .select('id, total, allocated, consumed, category')
    .eq('org_id', user.org_id);

  if (error) return badRequest(res, error.message);

  const rows = data || [];
  const total_skus = rows.length;
  const low_stock = rows.filter((r: any) => (r.allocated - r.consumed) < 50 && r.category === 'product').length;
  const fully_allocated = rows.filter((r: any) => r.total > 0 && r.allocated >= r.total).length;

  return ok(res, {
    total_skus,
    low_stock,
    fully_allocated,
  });
});

export const getWarehouseInventory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  const { data, error } = await supabaseAdmin
    .from('warehouse_inventory')
    .select('id, name, sku, total, allocated, consumed, category')
    .eq('org_id', user.org_id)
    .order('name', { ascending: true });

  if (error) return badRequest(res, error.message);

  return ok(res, data || []);
});
