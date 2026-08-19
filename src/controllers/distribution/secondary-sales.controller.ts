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
  distributor_id: z.string().uuid().optional(),
});

// Derive the distributor that services an outlet from its most recent order.
// Lets period-captured secondary sales roll up by distributor even though the
// outlet→distributor link isn't stored on the outlet itself. Returns null when
// the outlet has no order history.
async function distributorForOutlet(orgId: string, outletId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('orders')
    .select('distributor_id')
    .eq('org_id', orgId).eq('outlet_id', outletId).not('distributor_id', 'is', null)
    .order('placed_at', { ascending: false }).limit(1).maybeSingle();
  return (data as any)?.distributor_id ?? null;
}

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('secondary_sales')
    .select('*, distributors:distributor_id(name)')
    .eq('org_id', user.org_id).order('period_start', { ascending: false }).limit(500);
  if (req.query.outlet_id)      q = q.eq('outlet_id', req.query.outlet_id as string);
  if (req.query.sku_id)         q = q.eq('sku_id', req.query.sku_id as string);
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.from)           q = q.gte('period_start', req.query.from as string);
  if (req.query.to)             q = q.lte('period_end', req.query.to as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  const rows = (data || []).map((r: any) => ({ ...r, distributor_name: r.distributors?.name ?? null }));
  ok(res, rows);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-secondary-sale', ...req.body });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (parsed.data.period_end < parsed.data.period_start) return badRequest(res, 'period_end must be on or after period_start');

  // Attribute to a distributor: honour an explicit one, else derive from the
  // outlet's most recent servicing order.
  const distributorId = parsed.data.distributor_id
    ?? await distributorForOutlet(user.org_id, parsed.data.outlet_id);

  const { data, error } = await supabaseAdmin.from('secondary_sales').insert({
    ...parsed.data,
    distributor_id: distributorId,
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
