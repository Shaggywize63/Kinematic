import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { generateIRN, EInvoicePayload } from '../../services/einvoice';
import { getDemoInvoice } from '../../utils/demoDistribution';

const issueSchema = z.object({ order_id: z.string().uuid() });

// ── List ────────────────────────────────────────────────────────────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, [getDemoInvoice()]);
  let q = supabaseAdmin.from('invoices')
    .select('*').eq('org_id', user.org_id)
    .order('issued_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit as string) || 50, 200));
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.outlet_id)      q = q.eq('outlet_id', req.query.outlet_id as string);
  if (req.query.status)         q = q.eq('status', req.query.status as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { ...getDemoInvoice(), invoice_items: [] });
  const { data, error } = await supabaseAdmin.from('invoices')
    .select('*, invoice_items(*)').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Invoice not found');
  ok(res, data);
});

// ── Issue invoice from approved order ───────────────────────────────────────
export const issue = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = issueSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return created(res, getDemoInvoice(), 'Invoice issued (Demo)');

  const orderId = parsed.data.order_id;
  const { data: order } = await supabaseAdmin.from('orders')
    .select('*, order_items(*)').eq('id', orderId).eq('org_id', user.org_id).maybeSingle();
  if (!order) return notFound(res, 'Order not found');
  if (order.status !== 'approved') return conflict(res, `Cannot invoice from status=${order.status}`);

  // Hydrate seller (distributor) + buyer (outlet) for e-invoice payload.
  const [{ data: dist }, { data: outlet }, { data: outletExt }] = await Promise.all([
    supabaseAdmin.from('distributors').select('legal_name, gstin, state_code').eq('id', order.distributor_id).maybeSingle(),
    supabaseAdmin.from('stores').select('name').eq('id', order.outlet_id).maybeSingle(),
    supabaseAdmin.from('outlet_distribution_ext').select('gstin, state_code').eq('outlet_id', order.outlet_id).maybeSingle(),
  ]);

  // Generate invoice no.
  const { data: invNo } = await supabaseAdmin.rpc('gen_invoice_no', { p_org: user.org_id, p_dist: order.distributor_id });
  const invoice_no = invNo || `INV-${Date.now()}`;

  // Build IRP payload + IRN (stub or live).
  const payload: EInvoicePayload = {
    invoice_no,
    invoice_date: new Date().toISOString(),
    seller: { gstin: dist?.gstin || null, legal_name: dist?.legal_name || null, state_code: dist?.state_code || null },
    buyer:  { gstin: outletExt?.gstin || null, legal_name: outlet?.name || null, state_code: outletExt?.state_code || null },
    place_of_supply: order.place_of_supply,
    items: (order.order_items || []).map((it: any) => ({
      sku_code: it.sku_code,
      sku_name: it.sku_name,
      hsn_code: it.hsn_code,
      qty: it.qty,
      unit_price: Number(it.unit_price),
      taxable_value: Number(it.taxable_value),
      gst_rate: Number(it.gst_rate),
      cgst: Number(it.cgst),
      sgst: Number(it.sgst),
      igst: Number(it.igst),
      cess: Number(it.cess),
    })),
    taxable_value: Number(order.taxable_value),
    cgst: Number(order.cgst),
    sgst: Number(order.sgst),
    igst: Number(order.igst),
    cess: Number(order.cess),
    grand_total: Number(order.grand_total),
  };
  const irn = await generateIRN(payload);

  const idemKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

  // Persist.
  const { data: invoice, error } = await supabaseAdmin.from('invoices').insert({
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    invoice_no,
    order_id: order.id,
    distributor_id: order.distributor_id,
    outlet_id: order.outlet_id,
    status: 'issued',
    irn: irn.irn,
    qr_code_url: irn.qr_code_url,
    place_of_supply: order.place_of_supply,
    is_reverse_charge: order.is_reverse_charge,
    subtotal: order.subtotal,
    discount_total: order.discount_total,
    scheme_total: order.scheme_total,
    taxable_value: order.taxable_value,
    cgst: order.cgst,
    sgst: order.sgst,
    igst: order.igst,
    cess: order.cess,
    round_off: order.round_off,
    grand_total: order.grand_total,
    issued_by: user.id,
    idempotency_key: idemKey ?? null,
  }).select().single();
  if (error) {
    if (error.code === '23505') {
      // Either uq_invoices_order_issued (already invoiced) or unique invoice_no.
      return conflict(res, 'Invoice for this order already exists');
    }
    return badRequest(res, error.message);
  }

  // Snapshot line items.
  const lineRows = (order.order_items || []).map((it: any) => ({
    invoice_id: invoice.id,
    sku_id: it.sku_id,
    sku_name: it.sku_name,
    sku_code: it.sku_code,
    hsn_code: it.hsn_code,
    qty: it.qty,
    uom: it.uom,
    pack_size: it.pack_size,
    unit_price: it.unit_price,
    mrp: it.mrp,
    discount_pct: it.discount_pct,
    discount_amt: it.discount_amt,
    scheme_id: it.scheme_id,
    scheme_version: it.scheme_version,
    is_free_good: it.is_free_good,
    taxable_value: it.taxable_value,
    gst_rate: it.gst_rate,
    cgst: it.cgst,
    sgst: it.sgst,
    igst: it.igst,
    cess: it.cess,
    total: it.total,
    line_no: it.line_no,
  }));
  await supabaseAdmin.from('invoice_items').insert(lineRows);

  // Mark order invoiced.
  await supabaseAdmin.from('orders').update({ status: 'invoiced', updated_at: new Date().toISOString() }).eq('id', order.id);

  // Post a DR to the outlet ledger (atomic; non-negative-balance trigger applies).
  const { error: ledgerErr } = await supabaseAdmin.rpc('post_ledger_entry', {
    p_org: user.org_id,
    p_client: user.client_id ?? null,
    p_outlet: order.outlet_id,
    p_distributor: order.distributor_id,
    p_entry_type: 'invoice',
    p_ref_table: 'invoices',
    p_ref_id: invoice.id,
    p_dr: order.grand_total,
    p_cr: 0,
    p_notes: `Invoice ${invoice_no}`,
    p_posted_by: user.id,
    p_posted_role: user.role,
  });
  if (ledgerErr && !ledgerErr.message?.includes('CREDIT_LIMIT_EXCEEDED')) {
    // Soft-warn but don't roll back the invoice; ledger reconciliation job will catch it.
  } else if (ledgerErr) {
    return conflict(res, 'CREDIT_LIMIT_EXCEEDED: outlet exceeds credit limit');
  }

  await audit(req, 'invoice.issue', 'invoices', invoice.id, null, invoice);

  const { data: full } = await supabaseAdmin.from('invoices').select('*, invoice_items(*)').eq('id', invoice.id).single();
  created(res, full, 'Invoice issued');
});

// ── Cancel invoice (admin only — credit-note ledger reversal) ───────────────
export const cancel = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, status: 'cancelled' });
  const reason = (req.body?.reason || '').toString().slice(0, 500);
  const { data: before } = await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Invoice not found');
  if (before.status === 'cancelled') return conflict(res, 'Invoice already cancelled');

  const { data: after, error } = await supabaseAdmin.from('invoices').update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    cancelled_by: user.id,
    cancel_reason: reason,
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select().single();
  if (error) return badRequest(res, error.message);

  // Ledger CR for the original invoice value (credit note).
  await supabaseAdmin.rpc('post_ledger_entry', {
    p_org: user.org_id,
    p_client: user.client_id ?? null,
    p_outlet: before.outlet_id,
    p_distributor: before.distributor_id,
    p_entry_type: 'credit_note',
    p_ref_table: 'invoices',
    p_ref_id: before.id,
    p_dr: 0,
    p_cr: before.grand_total,
    p_notes: `Cancellation: ${reason}`.slice(0, 500),
    p_posted_by: user.id,
    p_posted_role: user.role,
  });

  // Order reverts to approved.
  await supabaseAdmin.from('orders').update({ status: 'approved', updated_at: new Date().toISOString() }).eq('id', before.order_id);

  await audit(req, 'invoice.cancel', 'invoices', after.id, before, after, { reason });
  ok(res, after, 'Invoice cancelled');
});
