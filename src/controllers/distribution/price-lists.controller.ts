import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { getDemoPriceLists } from '../../utils/demoDistribution';

const priceListSchema = z.object({
  name: z.string().min(1),
  customer_class: z.enum(['MT', 'GT', 'HoReCa', 'Pharma', 'Wholesale']).default('GT'),
  region: z.string().default('ALL'),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const itemSchema = z.object({
  sku_id: z.string().uuid(),
  base_price: z.number().nonnegative(),
  min_qty: z.number().int().positive().default(1),
  max_qty: z.number().int().positive().optional(),
});

const bulkItemsSchema = z.object({
  items: z.array(itemSchema).min(1).max(2000),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoPriceLists());
  const { data, error } = await supabaseAdmin.from('price_lists')
    .select('*').eq('org_id', user.org_id).order('valid_from', { ascending: false });
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { ...getDemoPriceLists()[0], items: [] });
  const { data: pl, error: e1 } = await supabaseAdmin.from('price_lists').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (e1) return badRequest(res, e1.message);
  if (!pl) return notFound(res, 'Price list not found');
  const { data: items } = await supabaseAdmin.from('price_list_items').select('*')
    .eq('price_list_id', req.params.id).order('created_at');
  ok(res, { ...pl, items: items || [] });
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-pl-new', ...req.body, version: 1 });
  const parsed = priceListSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  // Auto-bump version for an existing (customer_class, region) tuple.
  const { data: prev } = await supabaseAdmin.from('price_lists')
    .select('version')
    .eq('org_id', user.org_id)
    .eq('customer_class', parsed.data.customer_class)
    .eq('region', parsed.data.region)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  const nextVersion = (prev?.version ?? 0) + 1;

  const { data, error } = await supabaseAdmin.from('price_lists').insert({
    ...parsed.data,
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    version: nextVersion,
    is_active: false, // activate via /activate
    created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'price_list.create', 'price_lists', data.id, null, data);
  created(res, data, 'Price list created');
});

export const bulkAddItems = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { accepted: req.body?.items?.length || 0, rejected: [] });
  const { data: pl } = await supabaseAdmin.from('price_lists').select('id, is_active')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!pl) return notFound(res, 'Price list not found');
  if (pl.is_active) return conflict(res, 'Cannot edit an active price list. Create a new version.');
  const parsed = bulkItemsSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  const rows = parsed.data.items.map((i) => ({ ...i, price_list_id: req.params.id }));
  const { data, error } = await supabaseAdmin.from('price_list_items')
    .upsert(rows, { onConflict: 'price_list_id,sku_id' }).select();
  if (error) return badRequest(res, error.message);
  await audit(req, 'price_list.bulk_items', 'price_lists', req.params.id, null, { count: rows.length });
  created(res, { accepted: data?.length || 0, rejected: [] }, 'Items added');
});

export const activate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, is_active: true });
  const { data: pl } = await supabaseAdmin.from('price_lists').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!pl) return notFound(res, 'Price list not found');

  // Deactivate any other active list for the same (customer_class, region).
  await supabaseAdmin.from('price_lists')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('org_id', user.org_id)
    .eq('customer_class', pl.customer_class)
    .eq('region', pl.region)
    .eq('is_active', true);

  const { data, error } = await supabaseAdmin.from('price_lists')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'price_list.activate', 'price_lists', data.id, pl, data);
  ok(res, data, 'Price list activated');
});
