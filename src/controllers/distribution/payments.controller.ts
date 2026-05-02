import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, forbidden, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { isOurUploadUrl } from '../../utils/upload-signer';
import { getDemoPayments } from '../../utils/demoDistribution';

const paymentSchema = z.object({
  outlet_id: z.string().uuid(),
  distributor_id: z.string().uuid().optional(),
  mode: z.enum(['cash', 'upi', 'cheque', 'credit_adjustment']),
  amount: z.number().positive().max(100000000),
  reference: z.string().optional(),
  cheque_bank: z.string().optional(),
  cheque_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cheque_image_url: z.string().url().optional(),
  upi_qr_id: z.string().optional(),
  applied_to_invoices: z.array(z.object({
    invoice_id: z.string().uuid(),
    amount: z.number().positive(),
  })).optional(),
  gps: z.object({ lat: z.number(), lng: z.number() }).optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoPayments());
  let q = supabaseAdmin.from('payments').select('*').eq('org_id', user.org_id).order('received_at', { ascending: false }).limit(100);
  if (req.query.outlet_id)      q = q.eq('outlet_id', req.query.outlet_id as string);
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.mode)           q = q.eq('mode', req.query.mode as string);
  if (req.query.status)         q = q.eq('status', req.query.status as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return created(res, getDemoPayments()[0], 'Payment recorded (Demo)');

  // Cheque integrity: image URL must come from signed-upload flow.
  if (parsed.data.mode === 'cheque') {
    if (!parsed.data.cheque_image_url) return badRequest(res, 'cheque_image_url is required for cheque payments');
    if (!isOurUploadUrl(parsed.data.cheque_image_url, user.org_id, 'cheque')) {
      return badRequest(res, 'cheque_image_url must be a signed-upload URL we issued');
    }
  }

  // Resolve distributor_id from outlet if not provided.
  let distributorId = parsed.data.distributor_id;
  if (!distributorId) {
    const { data: ext } = await supabaseAdmin.from('outlet_distribution_ext')
      .select('assigned_distributor_id').eq('outlet_id', parsed.data.outlet_id).maybeSingle();
    distributorId = ext?.assigned_distributor_id || undefined;
  }
  if (!distributorId) return badRequest(res, 'No distributor for this outlet');

  // Salesman daily collection cap.
  if (user.role === 'field_executive') {
    const { data: ext } = await supabaseAdmin.from('salesman_ext').select('daily_collection_cap').eq('user_id', user.id).maybeSingle();
    if (ext && Number(ext.daily_collection_cap) > 0) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const { data: today } = await supabaseAdmin.from('payments')
        .select('amount').eq('salesman_id', user.id).eq('org_id', user.org_id)
        .gte('received_at', todayStart.toISOString()).neq('status', 'cancelled');
      const used = (today || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
      if (used + parsed.data.amount > Number(ext.daily_collection_cap)) {
        return forbidden(res, `Daily collection cap (₹${ext.daily_collection_cap}) exceeded`);
      }
    }
  }

  const { data: payNo } = await supabaseAdmin.rpc('gen_payment_no', { p_org: user.org_id });
  const idemKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

  const { data: payment, error } = await supabaseAdmin.from('payments').insert({
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    payment_no: payNo || `PAY-${Date.now()}`,
    outlet_id: parsed.data.outlet_id,
    distributor_id: distributorId,
    salesman_id: user.id,
    mode: parsed.data.mode,
    amount: parsed.data.amount,
    reference: parsed.data.reference ?? null,
    cheque_bank: parsed.data.cheque_bank ?? null,
    cheque_date: parsed.data.cheque_date ?? null,
    cheque_image_url: parsed.data.cheque_image_url ?? null,
    upi_qr_id: parsed.data.upi_qr_id ?? null,
    applied_to_invoices: parsed.data.applied_to_invoices ?? [],
    gps_lat: parsed.data.gps?.lat ?? null,
    gps_lng: parsed.data.gps?.lng ?? null,
    status: parsed.data.mode === 'cheque' ? 'pending' : 'cleared',
    idempotency_key: idemKey ?? null,
    created_by: user.id,
  }).select().single();
  if (error) {
    if (error.code === '23505') return conflict(res, 'Duplicate payment (idempotency or payment_no)');
    return badRequest(res, error.message);
  }

  // Ledger CR (only when cleared; cheques wait until clearance).
  if (payment.status === 'cleared') {
    await supabaseAdmin.rpc('post_ledger_entry', {
      p_org: user.org_id,
      p_client: user.client_id ?? null,
      p_outlet: parsed.data.outlet_id,
      p_distributor: distributorId,
      p_entry_type: 'payment',
      p_ref_table: 'payments',
      p_ref_id: payment.id,
      p_dr: 0,
      p_cr: parsed.data.amount,
      p_notes: `Payment ${payment.payment_no} (${parsed.data.mode})`,
      p_posted_by: user.id,
      p_posted_role: user.role,
    });
  }

  await audit(req, 'payment.create', 'payments', payment.id, null, payment);
  created(res, payment, 'Payment recorded');
});

const clearChequeSchema = z.object({ status: z.enum(['cleared', 'bounced']), bounce_reason: z.string().optional() });

export const updateStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = clearChequeSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return ok(res, { id: req.params.id, status: parsed.data.status });

  const { data: before } = await supabaseAdmin.from('payments').select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Payment not found');
  if (before.status !== 'pending') return conflict(res, `Payment is ${before.status}`);

  const updates: any = { status: parsed.data.status, updated_at: new Date().toISOString() };
  if (parsed.data.status === 'bounced') { updates.bounced_at = new Date().toISOString(); updates.bounce_reason = parsed.data.bounce_reason || null; }
  const { data: after, error } = await supabaseAdmin.from('payments').update(updates).eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);

  // Ledger only on clearance (CR) — bounces just update status.
  if (parsed.data.status === 'cleared') {
    await supabaseAdmin.rpc('post_ledger_entry', {
      p_org: user.org_id,
      p_client: user.client_id ?? null,
      p_outlet: before.outlet_id,
      p_distributor: before.distributor_id,
      p_entry_type: 'payment',
      p_ref_table: 'payments',
      p_ref_id: before.id,
      p_dr: 0,
      p_cr: before.amount,
      p_notes: `Cheque cleared ${before.payment_no}`,
      p_posted_by: user.id,
      p_posted_role: user.role,
    });
  }

  await audit(req, `payment.${parsed.data.status}`, 'payments', after.id, before, after);
  ok(res, after);
});
