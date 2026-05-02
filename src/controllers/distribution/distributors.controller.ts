import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { getDemoDistributors, getDemoLedger } from '../../utils/demoDistribution';

const distributorSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(32),
  legal_name: z.string().optional(),
  gstin: z.string().regex(/^[0-9A-Z]{15}$/).optional(),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
  state_code: z.string().regex(/^\d{2}$/).optional(),
  place_of_supply: z.string().optional(),
  address: z.record(z.any()).optional(),
  contact_name: z.string().optional(),
  contact_mobile: z.string().optional(),
  email: z.string().email().optional(),
  credit_limit: z.number().nonnegative().optional(),
  payment_terms_days: z.number().int().nonnegative().optional(),
  customer_class: z.enum(['super_stockist', 'distributor', 'wholesaler']).optional(),
  assigned_brands: z.array(z.string().uuid()).optional(),
  region: z.string().optional(),
  city_id: z.string().uuid().optional(),
  is_active: z.boolean().optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoDistributors());
  const q = req.query.q as string | undefined;
  const isActive = req.query.is_active as string | undefined;
  let qb = supabaseAdmin.from('distributors').select('*').eq('org_id', user.org_id).order('name');
  if (q) qb = qb.ilike('name', `%${q}%`);
  if (isActive === 'true') qb = qb.eq('is_active', true);
  if (isActive === 'false') qb = qb.eq('is_active', false);
  const { data, error } = await qb;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoDistributors()[0]);
  const { data, error } = await supabaseAdmin.from('distributors').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Distributor not found');
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-new-dist', ...req.body });
  const parsed = distributorSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { data, error } = await supabaseAdmin.from('distributors').insert({
    ...parsed.data,
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'distributor.create', 'distributors', data.id, null, data);
  created(res, data, 'Distributor created');
});

export const update = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, ...req.body });
  const parsed = distributorSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { data: before } = await supabaseAdmin.from('distributors').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Distributor not found');
  const { data, error } = await supabaseAdmin.from('distributors')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id)
    .select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'distributor.update', 'distributors', data.id, before, data);
  ok(res, data, 'Distributor updated');
});

export const remove = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id });
  const { data: before } = await supabaseAdmin.from('distributors').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Distributor not found');
  const { error } = await supabaseAdmin.from('distributors')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id);
  if (error) return badRequest(res, error.message);
  await audit(req, 'distributor.deactivate', 'distributors', req.params.id, before, { ...before, is_active: false });
  ok(res, { id: req.params.id, is_active: false }, 'Distributor deactivated');
});

// ── Ledger / billing summary ───────────────────────────────────────────────
export const billingSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { open_orders: 8, dispatched: 3, invoiced: 12, paid: 5, ageing: getDemoLedger().ageing });
  const distributorId = req.params.id;
  // M1 stub: counts from orders only (invoices/payments arrive in M2).
  const { data: orders } = await supabaseAdmin
    .from('orders').select('status')
    .eq('org_id', user.org_id).eq('distributor_id', distributorId);
  const counts = (orders || []).reduce((acc: Record<string, number>, o: any) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});
  ok(res, {
    open_orders: (counts.placed || 0) + (counts.approved || 0),
    invoiced: (counts.invoiced || 0) + (counts.partially_invoiced || 0),
    cancelled: counts.cancelled || 0,
    ageing: { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 },
  });
});
