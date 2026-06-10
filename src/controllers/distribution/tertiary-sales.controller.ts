import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, isDemo } from '../../utils';
import { audit } from '../../utils/audit';

/**
 * Tertiary sales — the retailer → consumer hop that brand owners can
 * never see today because dealers transact in cash and write paper bills.
 *
 * Captured via multiple channels (`captured_by`) so the unorganized
 * sector is tracked alongside the organized one:
 *   - consumer_self     — consumer registered the unit themselves
 *                          (WhatsApp / cashback flow)
 *   - retailer_app      — organized dealer using a billing app
 *   - fe_visit          — field exec logged the sale during an audit
 *   - whatsapp_bot      — message-based capture (typed or voice)
 *   - ocr_invoice       — handwritten bill photographed + OCR'd
 *   - mechanic_install  — fitter / mechanic recorded an installation
 *   - integration       — pulled from an external POS
 *
 * `referrer_id` links to people_directory so a mechanic / fitter who
 * routed the sale to the dealer gets attribution + (optionally) an
 * incentive payout.
 */

const tertiarySaleSchema = z.object({
  retailer_id:       z.string().uuid().nullable().optional(),
  distributor_id:    z.string().uuid().nullable().optional(),
  sku_id:            z.string().uuid(),
  serial_id:         z.string().uuid().nullable().optional(),
  consumer_phone:    z.string().min(7).max(20).nullable().optional(),
  consumer_name:     z.string().nullable().optional(),
  consumer_email:    z.string().email().nullable().optional(),
  vehicle_reg:       z.string().nullable().optional(),
  qty:               z.number().int().positive().default(1),
  unit_price:        z.number().nonnegative().nullable().optional(),
  discount:          z.number().nonnegative().optional().default(0),
  total:             z.number().nonnegative().nullable().optional(),
  sold_at:           z.string().datetime().optional(),
  captured_by:       z.enum([
                        'consumer_self', 'retailer_app', 'fe_visit',
                        'whatsapp_bot', 'ocr_invoice', 'mechanic_install',
                        'integration',
                      ]),
  referrer_id:       z.string().uuid().nullable().optional(),
  evidence_url:      z.string().url().nullable().optional(),
  notes:             z.string().nullable().optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin
    .from('distribution_tertiary_sales')
    .select('*')
    .eq('org_id', user.org_id)
    .order('sold_at', { ascending: false })
    .limit(500);
  if (user.client_id) q = q.eq('client_id', user.client_id);
  if (req.query.retailer_id)    q = q.eq('retailer_id', req.query.retailer_id as string);
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.sku_id)         q = q.eq('sku_id', req.query.sku_id as string);
  if (req.query.captured_by)    q = q.eq('captured_by', req.query.captured_by as string);
  if (req.query.from)           q = q.gte('sold_at', req.query.from as string);
  if (req.query.to)             q = q.lte('sold_at', req.query.to as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-tertiary-sale', ...req.body });
  const parsed = tertiarySaleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  const total = parsed.data.total
    ?? (parsed.data.unit_price != null
        ? Math.max(0, parsed.data.unit_price * parsed.data.qty - (parsed.data.discount ?? 0))
        : null);

  const { data, error } = await supabaseAdmin
    .from('distribution_tertiary_sales')
    .insert({
      ...parsed.data,
      total,
      sold_at: parsed.data.sold_at ?? new Date().toISOString(),
      org_id: user.org_id,
      client_id: user.client_id ?? null,
      captured_user_id: user.id,
    })
    .select()
    .single();
  if (error) return badRequest(res, error.message);

  // Best-effort: move the serial (if supplied) to the 'consumer' holder
  // bucket so the trace is current. Failures here don't block the sale.
  if (parsed.data.serial_id) {
    void supabaseAdmin
      .from('distribution_sku_serials')
      .update({
        current_holder_type: 'consumer',
        current_holder_id: null,
        last_moved_at: new Date().toISOString(),
      })
      .eq('id', parsed.data.serial_id)
      .eq('org_id', user.org_id);
  }

  await audit(req, 'tertiary_sale.create', 'distribution_tertiary_sales', data.id, null, data);
  created(res, data);
});
