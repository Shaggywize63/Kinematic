import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, isDemo } from '../../utils';
import { audit } from '../../utils/audit';

const schema = z.object({
  outlet_id: z.string().uuid(),
  sku_id: z.string().uuid(),
  qty: z.number().int().positive(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(['manual', 'estimated', 'qr']).default('manual'),
  evidence_url: z.string().url().optional(),
  notes: z.string().optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('secondary_sales').select('*').eq('org_id', user.org_id).order('period_start', { ascending: false }).limit(500);
  if (req.query.outlet_id) q = q.eq('outlet_id', req.query.outlet_id as string);
  if (req.query.sku_id)    q = q.eq('sku_id', req.query.sku_id as string);
  if (req.query.from)      q = q.gte('period_start', req.query.from as string);
  if (req.query.to)        q = q.lte('period_end', req.query.to as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-secondary-sale', ...req.body });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (parsed.data.period_end < parsed.data.period_start) return badRequest(res, 'period_end must be on or after period_start');

  const { data, error } = await supabaseAdmin.from('secondary_sales').insert({
    ...parsed.data,
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    captured_by: user.id,
  }).select().single();
  if (error) {
    if (error.code === '23505') return badRequest(res, 'Duplicate capture for this outlet+SKU+period+source');
    return badRequest(res, error.message);
  }
  await audit(req, 'secondary_sale.create', 'secondary_sales', data.id, null, data);
  created(res, data);
});
