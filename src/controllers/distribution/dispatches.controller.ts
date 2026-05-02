import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { generateEwayBill, ewayRequired } from '../../services/eway-bill';

const createSchema = z.object({
  distributor_id: z.string().uuid(),
  vehicle_no: z.string().min(1).max(32),
  driver_name: z.string().optional(),
  driver_mobile: z.string().optional(),
  invoice_ids: z.array(z.string().uuid()).min(1).max(200),
  notes: z.string().optional(),
});

const ewaySchema = z.object({
  eway_bill_no: z.string().optional(),
  generate: z.boolean().optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('dispatches').select('*, dispatch_lines(*)').eq('org_id', user.org_id).order('created_at', { ascending: false }).limit(100);
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.status)         q = q.eq('status', req.query.status as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return created(res, { id: 'demo-dispatch', dispatch_no: 'DSP-DEMO', status: 'prepared' });

  // Verify all invoices belong to org + distributor + are not already dispatched.
  const { data: invoices } = await supabaseAdmin.from('invoices')
    .select('id, distributor_id, grand_total, status, dispatch_id')
    .in('id', parsed.data.invoice_ids).eq('org_id', user.org_id);
  if (!invoices || invoices.length !== parsed.data.invoice_ids.length) return badRequest(res, 'Some invoices not found');
  for (const inv of invoices) {
    if (inv.status !== 'issued') return conflict(res, `Invoice ${inv.id} is not in 'issued' state`);
    if (inv.dispatch_id) return conflict(res, `Invoice ${inv.id} already on a dispatch`);
    if (inv.distributor_id !== parsed.data.distributor_id) return conflict(res, 'Invoices belong to a different distributor');
  }
  const total = invoices.reduce((s, i) => s + Number(i.grand_total), 0);

  const { data: dispatchNo } = await supabaseAdmin.rpc('gen_dispatch_no', { p_org: user.org_id });

  const idemKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

  const { data: dispatch, error } = await supabaseAdmin.from('dispatches').insert({
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    dispatch_no: dispatchNo || `DSP-${Date.now()}`,
    distributor_id: parsed.data.distributor_id,
    vehicle_no: parsed.data.vehicle_no,
    driver_name: parsed.data.driver_name ?? null,
    driver_mobile: parsed.data.driver_mobile ?? null,
    total_value: total,
    status: 'prepared',
    notes: parsed.data.notes ?? null,
    created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);

  await supabaseAdmin.from('dispatch_lines').insert(
    parsed.data.invoice_ids.map((id) => ({ dispatch_id: dispatch.id, invoice_id: id }))
  );
  await supabaseAdmin.from('invoices')
    .update({ dispatch_id: dispatch.id, updated_at: new Date().toISOString() })
    .in('id', parsed.data.invoice_ids);

  await audit(req, 'dispatch.create', 'dispatches', dispatch.id, null, dispatch);
  created(res, dispatch, 'Dispatch created');
});

export const attachEwayBill = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = ewaySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return ok(res, { id: req.params.id, eway_bill_no: '123456789012' });

  const { data: dispatch } = await supabaseAdmin.from('dispatches')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!dispatch) return notFound(res, 'Dispatch not found');

  let eway_bill_no = parsed.data.eway_bill_no;
  let valid_until: string | null = null;
  if (parsed.data.generate || !eway_bill_no) {
    const out = await generateEwayBill({
      invoice_no: dispatch.dispatch_no,
      invoice_date: new Date().toISOString(),
      vehicle_no: dispatch.vehicle_no || '',
      total_value: Number(dispatch.total_value),
    });
    eway_bill_no = out.eway_bill_no || undefined;
    valid_until = out.valid_until;
  }

  const { data, error } = await supabaseAdmin.from('dispatches')
    .update({
      eway_bill_no: eway_bill_no || null,
      eway_bill_valid_until: valid_until,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);

  await audit(req, 'dispatch.eway_bill', 'dispatches', data.id, dispatch, data);
  ok(res, data, 'e-Way bill attached');
});

export const markOut = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, status: 'out' });
  const { data: dispatch } = await supabaseAdmin.from('dispatches')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!dispatch) return notFound(res, 'Dispatch not found');
  if (dispatch.status !== 'prepared') return conflict(res, `Cannot dispatch from status=${dispatch.status}`);

  // e-Way bill required if grand_total > threshold.
  if (ewayRequired(Number(dispatch.total_value)) && !dispatch.eway_bill_no) {
    return conflict(res, `e-Way bill required for dispatches over ₹50,000`);
  }
  const { data, error } = await supabaseAdmin.from('dispatches')
    .update({ status: 'out', dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'dispatch.mark_out', 'dispatches', data.id, dispatch, data);
  ok(res, data, 'Dispatch marked out');
});
