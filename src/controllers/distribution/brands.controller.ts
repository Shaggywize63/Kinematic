import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { getDemoBrands } from '../../utils/demoDistribution';

const brandSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(32),
  legal_name: z.string().optional(),
  gstin: z.string().regex(/^[0-9A-Z]{15}$/).optional(),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
  state_code: z.string().regex(/^\d{2}$/).optional(),
  billing_address: z.record(z.any()).optional(),
  logo_url: z.string().url().optional(),
  is_active: z.boolean().optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoBrands());
  const q = req.query.q as string | undefined;
  const isActive = req.query.is_active as string | undefined;
  let qb = supabaseAdmin.from('brands').select('*').eq('org_id', user.org_id).order('created_at', { ascending: false });
  if (q) qb = qb.ilike('name', `%${q}%`);
  if (isActive === 'true') qb = qb.eq('is_active', true);
  if (isActive === 'false') qb = qb.eq('is_active', false);
  const { data, error } = await qb;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoBrands()[0]);
  const { data, error } = await supabaseAdmin
    .from('brands').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Brand not found');
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-brand', ...req.body });
  const parsed = brandSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { data, error } = await supabaseAdmin.from('brands').insert({
    ...parsed.data,
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'brand.create', 'brands', data.id, null, data);
  created(res, data, 'Brand created');
});

export const update = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, ...req.body });
  const parsed = brandSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { data: before } = await supabaseAdmin.from('brands').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Brand not found');
  const { data, error } = await supabaseAdmin.from('brands')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id)
    .select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'brand.update', 'brands', data.id, before, data);
  ok(res, data, 'Brand updated');
});

export const remove = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id });
  const { data: before } = await supabaseAdmin.from('brands').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Brand not found');
  // Soft-delete: flip is_active. Hard-delete would orphan SKUs.
  const { error } = await supabaseAdmin.from('brands')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id);
  if (error) return badRequest(res, error.message);
  await audit(req, 'brand.deactivate', 'brands', req.params.id, before, { ...before, is_active: false });
  ok(res, { id: req.params.id, is_active: false }, 'Brand deactivated');
});
