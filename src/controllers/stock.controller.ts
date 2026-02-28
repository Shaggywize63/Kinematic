import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const allocateSchema = z.object({
  user_id: z.string().uuid(),
  zone_id: z.string().uuid().optional(),
  activity_id: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
  items: z.array(z.object({
    product_name: z.string().min(1),
    sku: z.string().optional(),
    category: z.string().optional(),
    quantity_allocated: z.number().int().positive(),
    unit: z.string().default('units'),
  })).min(1),
});

const reviewItemSchema = z.object({
  status: z.enum(['accepted', 'rejected', 'partially_accepted']),
  quantity_accepted: z.number().int().optional(),
  rejection_reason: z.string().optional(),
});

// GET /api/v1/stock/my  — exec's allocation for today or given date
export const getMyAllocation = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('stock_allocations')
    .select('*, stock_items(*), activities(name), zones(name)')
    .eq('user_id', user.id)
    .eq('date', date)
    .single();

  if (error && error.code !== 'PGRST116') return badRequest(res, error.message);
  return ok(res, data || null);
});

// POST /api/v1/stock/allocate  (admin+)
export const allocate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = allocateSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { items, ...allocData } = body.data;

  const { data: alloc, error } = await supabaseAdmin
    .from('stock_allocations')
    .insert({ ...allocData, org_id: user.org_id, created_by: user.id })
    .select()
    .single();

  if (error) return badRequest(res, error.message);

  const { error: itemsErr } = await supabaseAdmin
    .from('stock_items')
    .insert(items.map((i) => ({ ...i, allocation_id: alloc.id })));

  if (itemsErr) return badRequest(res, itemsErr.message);

  const { data: full } = await supabaseAdmin
    .from('stock_allocations')
    .select('*, stock_items(*)')
    .eq('id', alloc.id)
    .single();

  return created(res, full, 'Stock allocated');
});

// PATCH /api/v1/stock/items/:id  — exec accepts/rejects individual item
export const reviewItem = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const body = reviewItemSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  // Verify item belongs to user's allocation
  const { data: item } = await supabaseAdmin
    .from('stock_items')
    .select('id, allocation_id, quantity_allocated, stock_allocations(user_id)')
    .eq('id', id)
    .single();

  if (!item) return notFound(res, 'Stock item not found');
  
  const alloc = item.stock_allocations as { user_id: string } | null;
  if (alloc?.user_id !== user.id && !['admin','city_manager','super_admin'].includes(user.role)) {
    return badRequest(res, 'Not authorised to review this item');
  }

  const updateData: Record<string, unknown> = {
    status: body.data.status,
    ...(body.data.rejection_reason && { rejection_reason: body.data.rejection_reason }),
    ...(body.data.quantity_accepted !== undefined && { quantity_accepted: body.data.quantity_accepted }),
  };

  const { data, error } = await supabaseAdmin
    .from('stock_items')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) return badRequest(res, error.message);

  // Update parent allocation status
  const { data: siblings } = await supabaseAdmin
    .from('stock_items')
    .select('status')
    .eq('allocation_id', item.allocation_id);

  const statuses = (siblings || []).map((s: { status: string }) => s.status);
  let allocStatus = 'pending';
  if (statuses.every((s) => s === 'accepted')) allocStatus = 'accepted';
  else if (statuses.every((s) => s === 'rejected')) allocStatus = 'rejected';
  else if (statuses.some((s) => s !== 'pending')) allocStatus = 'partially_accepted';

  await supabaseAdmin
    .from('stock_allocations')
    .update({ status: allocStatus, reviewed_at: new Date().toISOString() })
    .eq('id', item.allocation_id);

  return ok(res, data, 'Item updated');
});

// GET /api/v1/stock/team  (supervisor+)
export const getTeamAllocations = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('stock_allocations')
    .select('*, stock_items(*), users(name, employee_id), zones(name)')
    .eq('org_id', user.org_id)
    .eq('date', date)
    .order('created_at', { ascending: false });

  if (error) return badRequest(res, error.message);
  return ok(res, data);
});
