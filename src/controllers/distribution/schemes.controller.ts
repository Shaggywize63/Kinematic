import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { applySchemes } from '../../services/scheme-engine';
import { priceCart } from '../../services/order-pricer';
import { getDemoSchemes } from '../../utils/demoDistribution';

const schemeSchema = z.object({
  code: z.string().min(1).max(48),
  name: z.string().min(1),
  type: z.enum(['QPS', 'SLAB_DISCOUNT', 'BXGY', 'VALUE_DISCOUNT']),
  targeting: z.record(z.any()).default({}),
  rules: z.record(z.any()).default({}),
  priority: z.number().int().min(0).max(1000).default(100),
  stackable: z.boolean().default(false),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoSchemes());
  const { data, error } = await supabaseAdmin.from('schemes')
    .select('*').eq('org_id', user.org_id).order('priority', { ascending: true });
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoSchemes()[0]);
  const { data, error } = await supabaseAdmin.from('schemes').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Scheme not found');
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-scheme-new', ...req.body, version: 1 });
  const parsed = schemeSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  // Auto-bump version per code (editing means a NEW row, not an update).
  const { data: prev } = await supabaseAdmin.from('schemes')
    .select('version').eq('org_id', user.org_id).eq('code', parsed.data.code)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  const nextVersion = (prev?.version ?? 0) + 1;

  const { data, error } = await supabaseAdmin.from('schemes').insert({
    ...parsed.data,
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    version: nextVersion,
    is_active: true,
    created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);

  // Older versions of the same code stay in the table but are deactivated.
  await supabaseAdmin.from('schemes')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('org_id', user.org_id).eq('code', parsed.data.code)
    .lt('version', nextVersion);

  await audit(req, 'scheme.create', 'schemes', data.id, null, data);
  created(res, data, 'Scheme created (active)');
});

export const deactivate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, is_active: false });
  const { data: before } = await supabaseAdmin.from('schemes').select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Scheme not found');
  const { data, error } = await supabaseAdmin.from('schemes').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'scheme.deactivate', 'schemes', data.id, before, data);
  ok(res, data);
});

// POST /api/v1/distribution/schemes/preview — dry-run a cart to see schemes applied.
const previewSchema = z.object({
  outlet_id: z.string().uuid(),
  customer_class: z.string().optional(),
  items: z.array(z.object({ sku_id: z.string().uuid(), qty: z.number().int().positive() })).min(1),
});
export const preview = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return ok(res, { lines: [], applied_schemes: getDemoSchemes(), totals: { grand_total: 0 } });

  // Resolve customer_class from outlet if omitted.
  let cc = parsed.data.customer_class;
  if (!cc) {
    const { data: ext } = await supabaseAdmin.from('outlet_distribution_ext').select('customer_class').eq('outlet_id', parsed.data.outlet_id).maybeSingle();
    cc = ext?.customer_class || 'GT';
  }
  const priced = await priceCart(parsed.data.items, {
    org_id: user.org_id, customer_class: cc!, distributor_state_code: null, place_of_supply: null,
  });
  const schemeOut = await applySchemes(priced.lines, {
    org_id: user.org_id, customer_class: cc!, date: new Date().toISOString().slice(0, 10),
    outlet_id: parsed.data.outlet_id, intra_state: priced.intra_state, brand_ids: [],
  });
  ok(res, { lines: schemeOut.lines, applied_schemes: schemeOut.applied, scheme_total: schemeOut.scheme_total });
});
