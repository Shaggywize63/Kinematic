import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { isOurUploadUrl } from '../../utils/upload-signer';
import { getDemoReturns } from '../../utils/demoDistribution';

const itemSchema = z.object({
  sku_id: z.string().uuid(),
  qty: z.number().int().positive(),
  condition: z.enum(['saleable', 'damaged', 'expired']),
  original_invoice_item_id: z.string().uuid().optional(),
});

const returnSchema = z.object({
  outlet_id: z.string().uuid(),
  original_invoice_id: z.string().uuid(),
  reason_code: z.string().min(1).max(48),
  reason_notes: z.string().optional(),
  photo_urls: z.array(z.string().url()).min(1),
  items: z.array(itemSchema).min(1),
  gps: z.object({ lat: z.number(), lng: z.number() }).optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoReturns());
  let q = supabaseAdmin.from('returns').select('*, return_items(*)').eq('org_id', user.org_id).order('created_at', { ascending: false }).limit(100);
  if (req.query.status)    q = q.eq('status', req.query.status as string);
  if (req.query.outlet_id) q = q.eq('outlet_id', req.query.outlet_id as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = returnSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return created(res, getDemoReturns()[0], 'Return queued (Demo)');

  // All photos must come from our signed-upload flow.
  for (const url of parsed.data.photo_urls) {
    if (!isOurUploadUrl(url, user.org_id, 'return')) {
      return badRequest(res, 'photo_urls must be signed-upload URLs we issued');
    }
  }

  // Verify original invoice + return-window.
  const { data: inv } = await supabaseAdmin.from('invoices')
    .select('id, outlet_id, distributor_id, issued_at, status, invoice_items(*)').eq('id', parsed.data.original_invoice_id).eq('org_id', user.org_id).maybeSingle();
  if (!inv) return notFound(res, 'Invoice not found');
  if (inv.status === 'cancelled') return conflict(res, 'Cannot return against a cancelled invoice');
  if (inv.outlet_id !== parsed.data.outlet_id) return conflict(res, 'Invoice belongs to a different outlet');

  // Compute totals from items snapshot.
  let total_value = 0, cgst = 0, sgst = 0, igst = 0, cess = 0;
  const itemRows: any[] = [];
  for (const it of parsed.data.items) {
    const orig = (inv.invoice_items as any[]).find((ii) => ii.sku_id === it.sku_id);
    const unit_price = orig ? Number(orig.unit_price) : 0;
    const taxable    = Math.round(unit_price * it.qty * 100) / 100;
    const gst_rate   = orig ? Number(orig.gst_rate) : 0;
    const intraState = (Number(orig?.cgst || 0) + Number(orig?.sgst || 0)) > 0;
    const tax = (taxable * gst_rate) / 100;
    const c   = intraState ? Math.round((tax / 2) * 100) / 100 : 0;
    const s   = c;
    const i   = intraState ? 0 : Math.round(tax * 100) / 100;
    total_value += taxable + tax;
    cgst += c; sgst += s; igst += i;
    itemRows.push({ sku_id: it.sku_id, sku_name: orig?.sku_name, qty: it.qty, unit_price, taxable_value: taxable, gst_rate, cgst: c, sgst: s, igst: i, cess: 0, total: taxable + tax, condition: it.condition, original_invoice_item_id: it.original_invoice_item_id ?? orig?.id });
  }

  // Supervisor threshold from salesman_ext.
  let requires_supervisor = false;
  if (user.role === 'field_executive') {
    const { data: ext } = await supabaseAdmin.from('salesman_ext').select('return_threshold_value').eq('user_id', user.id).maybeSingle();
    if (ext && total_value > Number(ext.return_threshold_value || 0)) requires_supervisor = true;
  }

  const { data: retNo } = await supabaseAdmin.rpc('gen_return_no', { p_org: user.org_id });
  const idemKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

  const { data: ret, error } = await supabaseAdmin.from('returns').insert({
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    return_no: retNo || `RET-${Date.now()}`,
    outlet_id: parsed.data.outlet_id,
    distributor_id: inv.distributor_id,
    salesman_id: user.id,
    original_invoice_id: parsed.data.original_invoice_id,
    reason_code: parsed.data.reason_code,
    reason_notes: parsed.data.reason_notes ?? null,
    photo_urls: parsed.data.photo_urls,
    status: 'requested',
    requires_supervisor,
    total_value,
    cgst, sgst, igst, cess,
    gps_lat: parsed.data.gps?.lat ?? null,
    gps_lng: parsed.data.gps?.lng ?? null,
    idempotency_key: idemKey ?? null,
    created_by: user.id,
  }).select().single();
  if (error) {
    if (error.code === '23505') return conflict(res, 'Duplicate return (idempotency or return_no)');
    return badRequest(res, error.message);
  }
  await supabaseAdmin.from('return_items').insert(itemRows.map((r) => ({ ...r, return_id: ret.id })));
  await audit(req, 'return.create', 'returns', ret.id, null, ret);
  created(res, ret, 'Return queued');
});

export const approve = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, status: 'credited' });

  const { data: before } = await supabaseAdmin.from('returns').select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Return not found');
  if (!['requested', 'supervisor_approved'].includes(before.status)) return conflict(res, `Cannot approve from status=${before.status}`);

  const { data: after, error } = await supabaseAdmin.from('returns').update({
    status: 'credited',
    approved_by: user.id, approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);

  // Ledger CR for the return value (credit note).
  await supabaseAdmin.rpc('post_ledger_entry', {
    p_org: user.org_id, p_client: user.client_id ?? null,
    p_outlet: before.outlet_id, p_distributor: before.distributor_id,
    p_entry_type: 'return', p_ref_table: 'returns', p_ref_id: before.id,
    p_dr: 0, p_cr: before.total_value,
    p_notes: `Return ${before.return_no} (${before.reason_code})`,
    p_posted_by: user.id, p_posted_role: user.role,
  });

  await audit(req, 'return.approve', 'returns', after.id, before, after);
  ok(res, after, 'Return approved & credited');
});

export const reject = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, status: 'rejected' });
  const reason = (req.body?.reason || '').toString().slice(0, 500);
  const { data: before } = await supabaseAdmin.from('returns').select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Return not found');
  if (before.status === 'credited') return conflict(res, 'Already credited');
  const { data, error } = await supabaseAdmin.from('returns').update({
    status: 'rejected', rejected_by: user.id, rejected_at: new Date().toISOString(),
    rejection_reason: reason, updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'return.reject', 'returns', data.id, before, data, { reason });
  ok(res, data);
});
