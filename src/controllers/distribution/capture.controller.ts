import { Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest } from '../../utils';
import { registerConsumerPurchase } from './consumer-registrations.controller';

/**
 * Consumer self-registration capture.
 *
 * Turns the previously-manual "secondary / consumer sale" entry into a
 * self-serve flow: each outlet carries a `capture_token` (see the
 * outlet_consumer_capture migration). A QR code / wa.me link built from that
 * token opens a public, no-login page; the consumer picks the product they
 * bought and leaves a phone number, which flows into the SAME consumer-
 * registration pipeline as the dashboard form (auto tertiary sale + CRM lead).
 *
 * PUBLIC handlers (no auth): resolve the outlet from the token alone. The router
 * runs them inside the token's Supabase project (withCaptureProject), so
 * `supabaseAdmin` here already points at the right tenant DB.
 *
 * ADMIN handlers (authed, module `distribution_consumer`): mint / rotate /
 * disable an outlet's token and list outlets so the dashboard can build a
 * printable QR pack.
 */

/** url-safe opaque token; long enough that it can't be guessed / enumerated. */
function genToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

// ── PUBLIC ────────────────────────────────────────────────────────────────

async function outletForToken(token: string) {
  if (!token) return null;
  const { data } = await supabaseAdmin
    .from('outlet_distribution_ext')
    .select('outlet_id, org_id, client_id, capture_active')
    .eq('capture_token', token)
    .maybeSingle();
  return data as { outlet_id: string; org_id: string; client_id: string | null; capture_active: boolean } | null;
}

/** GET /api/v1/distribution/capture/:token — context for the landing page. */
export const publicGet = asyncHandler<Request>(async (req: Request, res: Response) => {
  const token = String(req.params.token || '').trim();
  const outlet = await outletForToken(token);
  if (!outlet || !outlet.capture_active) {
    res.status(404).json({ success: false, error: 'This capture link is not active.' });
    return;
  }
  const [{ data: store }, { data: skus }] = await Promise.all([
    supabaseAdmin.from('stores').select('name').eq('id', outlet.outlet_id).maybeSingle(),
    supabaseAdmin.from('skus')
      .select('id, name, sku_code')
      .eq('org_id', outlet.org_id)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(300),
  ]);
  res.status(200).json({
    success: true,
    data: {
      outlet_name: (store as { name?: string } | null)?.name || 'this store',
      products: (skus || []).map((s: any) => ({ sku_id: s.id, name: s.name, sku_code: s.sku_code })),
    },
  });
});

const publicSubmitSchema = z.object({
  consumer_phone: z.string().min(7).max(20),
  consumer_name:  z.string().max(120).nullable().optional(),
  sku_id:         z.string().uuid().nullable().optional(),
  serial_text:    z.string().max(120).nullable().optional(),
  vehicle_reg:    z.string().max(40).nullable().optional(),
  // How the consumer arrived — a scanned QR (default), the wa.me link, or a
  // plain web form. Anything else is coerced to 'qr'.
  channel:        z.enum(['qr', 'whatsapp', 'webform']).optional(),
});

/** POST /api/v1/distribution/capture/:token — record a consumer registration. */
export const publicSubmit = asyncHandler<Request>(async (req: Request, res: Response) => {
  const token = String(req.params.token || '').trim();
  const outlet = await outletForToken(token);
  if (!outlet || !outlet.capture_active) {
    res.status(404).json({ success: false, error: 'This capture link is not active.' });
    return;
  }
  const parsed = publicSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Please enter a valid phone number.' });
    return;
  }
  try {
    const result = await registerConsumerPurchase(
      {
        consumer_phone: parsed.data.consumer_phone,
        consumer_name:  parsed.data.consumer_name ?? null,
        consumer_email: null,
        sku_id:         parsed.data.sku_id ?? null,
        serial_id:      null,
        serial_text:    parsed.data.serial_text ?? null,
        // Attribute the sale to this outlet as the servicing retailer.
        retailer_id:    outlet.outlet_id,
        vehicle_reg:    parsed.data.vehicle_reg ?? null,
        registered_via: parsed.data.channel || 'qr',
        cashback_amount: 0,
        evidence_url:   null,
      },
      { org_id: outlet.org_id, client_id: outlet.client_id ?? null, actor_id: null },
    );
    res.status(201).json({ success: true, data: { id: result.reg.id } });
  } catch {
    // Never leak internals to an anonymous caller; the write path logs the cause.
    res.status(400).json({ success: false, error: 'Could not save. Please try again.' });
  }
});

// ── ADMIN (authed, requireModule distribution_consumer) ─────────────────────

/** GET /api/v1/distribution/capture-admin/outlets — outlets + token status. */
export const adminListOutlets = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const [{ data: stores }, { data: exts }] = await Promise.all([
    supabaseAdmin.from('stores')
      .select('id, name')
      .eq('org_id', user.org_id)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(2000),
    supabaseAdmin.from('outlet_distribution_ext')
      .select('outlet_id, capture_token, capture_active')
      .eq('org_id', user.org_id),
  ]);
  const byId = new Map((exts || []).map((e: any) => [e.outlet_id, e]));
  const rows = (stores || []).map((s: any) => {
    const e = byId.get(s.id);
    return {
      outlet_id: s.id,
      outlet_name: s.name,
      capture_token: e?.capture_token ?? null,
      capture_active: !!e?.capture_active,
    };
  });
  ok(res, rows);
});

/** POST /api/v1/distribution/capture-admin/outlets/:outletId/token — mint/rotate. */
export const adminMintToken = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const outletId = String(req.params.outletId || '').trim();
  const rotate = !!req.body?.rotate;

  const { data: store } = await supabaseAdmin.from('stores')
    .select('id').eq('id', outletId).eq('org_id', user.org_id).maybeSingle();
  if (!store) return badRequest(res, 'Outlet not found');

  const { data: existing } = await supabaseAdmin.from('outlet_distribution_ext')
    .select('outlet_id, capture_token').eq('outlet_id', outletId).maybeSingle();

  let token = (existing as { capture_token?: string | null } | null)?.capture_token || null;
  if (!token || rotate) token = genToken();

  const { error } = await supabaseAdmin.from('outlet_distribution_ext').upsert(
    {
      outlet_id: outletId,
      org_id: user.org_id,
      client_id: user.client_id ?? null,
      capture_token: token,
      capture_active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'outlet_id' },
  );
  if (error) return badRequest(res, error.message);
  ok(res, { outlet_id: outletId, capture_token: token, capture_active: true });
});

/** POST /api/v1/distribution/capture-admin/outlets/:outletId/deactivate. */
export const adminDeactivate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const outletId = String(req.params.outletId || '').trim();
  const { error } = await supabaseAdmin.from('outlet_distribution_ext')
    .update({ capture_active: false, updated_at: new Date().toISOString() })
    .eq('outlet_id', outletId)
    .eq('org_id', user.org_id);
  if (error) return badRequest(res, error.message);
  ok(res, { outlet_id: outletId, capture_active: false });
});

/**
 * POST /api/v1/distribution/capture-admin/mint-all — one-click: mint a token for
 * every active outlet that doesn't have one yet (existing tokens are left alone,
 * so printed QRs never rotate). Powers the dashboard "generate QR for all
 * outlets" button.
 */
export const adminMintAll = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const [{ data: stores }, { data: exts }] = await Promise.all([
    supabaseAdmin.from('stores').select('id').eq('org_id', user.org_id).eq('is_active', true).limit(5000),
    supabaseAdmin.from('outlet_distribution_ext').select('outlet_id, capture_token').eq('org_id', user.org_id),
  ]);
  const hasToken = new Map((exts || []).map((e: any) => [e.outlet_id, e.capture_token]));
  const nowIso = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (const s of (stores || [])) {
    const id = (s as any).id;
    if (hasToken.get(id)) continue; // already has a token — leave it
    rows.push({
      outlet_id: id,
      org_id: user.org_id,
      client_id: user.client_id ?? null,
      capture_token: genToken(),
      capture_active: true,
      updated_at: nowIso,
    });
  }
  if (rows.length) {
    const { error } = await supabaseAdmin.from('outlet_distribution_ext').upsert(rows, { onConflict: 'outlet_id' });
    if (error) return badRequest(res, error.message);
  }
  ok(res, { minted: rows.length, total: (stores || []).length });
});
