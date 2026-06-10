import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, isDemo } from '../../utils';
import { audit } from '../../utils/audit';

/**
 * Consumer registrations — the bridge between Supply Chain and CRM.
 *
 * A consumer registers their unit via:
 *   - whatsapp        (the dominant channel for rural / unorganized buyers)
 *   - app             (the brand's consumer app, if any)
 *   - dealer          (logged at the dealer counter)
 *   - cashback_form   (web form linked from invoice / QR)
 *   - sms             (legacy SMS shortcode)
 *   - webform         (the brand's marketing site)
 *
 * Every successful registration:
 *   1. Creates a `distribution_consumer_registrations` row (this controller)
 *   2. Creates a `distribution_tertiary_sales` row attributed to the
 *      registered retailer + sku (this controller does it inline)
 *   3. Creates a CRM `Lead` so the consumer enters the lead pipeline for
 *      service reminders, warranty extension upsells, referral programs
 *      and churn analysis (this controller does it inline)
 *
 * The two side-effects are best-effort — registration succeeds even if
 * the cross-module hops fail, with the back-pointer columns left null.
 * That keeps the consumer-facing flow (which terminates a payment) from
 * failing on a CRM hiccup.
 */

const registrationSchema = z.object({
  // Either a matched serial_id (validated against sku_serials) or raw text.
  serial_id:        z.string().uuid().nullable().optional(),
  serial_text:      z.string().nullable().optional(),
  sku_id:           z.string().uuid().nullable().optional(),
  retailer_id:      z.string().uuid().nullable().optional(),
  consumer_phone:   z.string().min(7).max(20),
  consumer_name:    z.string().nullable().optional(),
  consumer_email:   z.string().email().nullable().optional(),
  vehicle_reg:      z.string().nullable().optional(),
  registered_via:   z.enum(['whatsapp', 'app', 'dealer', 'cashback_form', 'sms', 'webform']),
  cashback_amount:  z.number().nonnegative().optional().default(0),
  evidence_url:     z.string().url().nullable().optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin
    .from('distribution_consumer_registrations')
    .select('*')
    .eq('org_id', user.org_id)
    .order('registered_at', { ascending: false })
    .limit(500);
  if (user.client_id)             q = q.eq('client_id', user.client_id);
  if (req.query.retailer_id)      q = q.eq('retailer_id', req.query.retailer_id as string);
  if (req.query.consumer_phone)   q = q.eq('consumer_phone', req.query.consumer_phone as string);
  if (req.query.registered_via)   q = q.eq('registered_via', req.query.registered_via as string);
  if (req.query.from)             q = q.gte('registered_at', req.query.from as string);
  if (req.query.to)               q = q.lte('registered_at', req.query.to as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-consumer-reg', ...req.body });
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  // ── 1. Resolve serial (if any) → sku_id + retailer_id where possible.
  //      Keeps the registration row self-contained even when the consumer
  //      only typed the serial code from the sidewall.
  let serial_id  = parsed.data.serial_id ?? null;
  let sku_id     = parsed.data.sku_id ?? null;
  let retailer_id = parsed.data.retailer_id ?? null;

  if (!serial_id && parsed.data.serial_text) {
    const { data: matched } = await supabaseAdmin
      .from('distribution_sku_serials')
      .select('id, sku_id, current_holder_type, current_holder_id')
      .eq('org_id', user.org_id)
      .eq('serial', parsed.data.serial_text.trim())
      .maybeSingle();
    if (matched) {
      serial_id = matched.id;
      sku_id    = sku_id ?? matched.sku_id;
      // If the serial is currently held by a retailer, attribute the sale
      // to that retailer automatically — saves the consumer from having
      // to remember the shop name.
      if (matched.current_holder_type === 'retailer' && matched.current_holder_id && !retailer_id) {
        retailer_id = matched.current_holder_id;
      }
    }
  }

  // ── 2. Create the registration row.
  const { data: reg, error: regErr } = await supabaseAdmin
    .from('distribution_consumer_registrations')
    .insert({
      serial_id,
      serial_text: parsed.data.serial_text ?? null,
      sku_id,
      retailer_id,
      consumer_phone: parsed.data.consumer_phone.trim(),
      consumer_name: parsed.data.consumer_name ?? null,
      consumer_email: parsed.data.consumer_email ?? null,
      vehicle_reg: parsed.data.vehicle_reg ?? null,
      registered_via: parsed.data.registered_via,
      cashback_amount: parsed.data.cashback_amount ?? 0,
      evidence_url: parsed.data.evidence_url ?? null,
      org_id: user.org_id,
      client_id: user.client_id ?? null,
    })
    .select()
    .single();
  if (regErr) return badRequest(res, regErr.message);

  // ── 3. Side-effect: create a tertiary_sale row so the brand's sell-
  //      through dashboard sees the unit as moved. Best-effort — log the
  //      back-pointer when it succeeds.
  let tertiary_sale_id: string | null = null;
  if (sku_id) {
    const { data: ts } = await supabaseAdmin
      .from('distribution_tertiary_sales')
      .insert({
        org_id: user.org_id,
        client_id: user.client_id ?? null,
        retailer_id,
        sku_id,
        serial_id,
        consumer_phone: reg.consumer_phone,
        consumer_name: reg.consumer_name,
        consumer_email: reg.consumer_email,
        vehicle_reg: reg.vehicle_reg,
        qty: 1,
        sold_at: reg.registered_at,
        captured_by: 'consumer_self',
        captured_user_id: user.id,
        notes: `Auto-created from consumer registration ${reg.id}`,
      })
      .select('id')
      .single();
    if (ts) tertiary_sale_id = ts.id;
  }

  // ── 4. Side-effect: create a CRM Lead so the consumer enters the lead
  //      pipeline. Marked B2C, source = the registered_via channel; the
  //      registered_via value matches an existing CRM lead source slug.
  let lead_id: string | null = null;
  try {
    const nameParts = (reg.consumer_name || '').trim().split(/\s+/);
    const first_name = nameParts[0] || 'Consumer';
    const last_name  = nameParts.slice(1).join(' ') || null;
    const { data: lead } = await supabaseAdmin
      .from('crm_leads')
      .insert({
        org_id: user.org_id,
        client_id: user.client_id ?? null,
        first_name,
        last_name,
        phone: reg.consumer_phone,
        email: reg.consumer_email,
        is_b2c: true,
        status: 'new',
        notes: [
          `Auto-created from consumer registration ${reg.id}`,
          reg.vehicle_reg ? `Vehicle: ${reg.vehicle_reg}` : null,
          retailer_id ? `Retailer: ${retailer_id}` : null,
        ].filter(Boolean).join('\n'),
        tags: ['consumer_registration', reg.registered_via],
      })
      .select('id')
      .single();
    if (lead) lead_id = lead.id;
  } catch { /* lead creation is best-effort */ }

  // ── 5. Stitch back-pointers on the registration row.
  if (tertiary_sale_id || lead_id) {
    await supabaseAdmin
      .from('distribution_consumer_registrations')
      .update({ tertiary_sale_id, lead_id })
      .eq('id', reg.id);
  }

  await audit(req, 'consumer_registration.create',
              'distribution_consumer_registrations', reg.id, null,
              { ...reg, tertiary_sale_id, lead_id });

  created(res, { ...reg, tertiary_sale_id, lead_id });
});
