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

// ── Configurable capture form ───────────────────────────────────────────────
// One form per org (applied to every outlet's QR page). Phone is implicit
// (always shown + required) and NOT part of this list. Built-in keys map to
// registration columns; custom keys (cf_*) land in capture_extra.

const BUILTIN_FIELD_KEYS = new Set(['consumer_name', 'consumer_email', 'sku_id', 'vehicle_reg']);

const captureFieldSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  type: z.enum(['text', 'email', 'tel', 'number', 'select', 'product']),
  enabled: z.boolean(),
  required: z.boolean(),
  builtin: z.boolean(),
  options: z.array(z.string().max(80)).max(40).optional(),
});
type CaptureField = z.infer<typeof captureFieldSchema>;

const DEFAULT_FIELDS: CaptureField[] = [
  { key: 'consumer_name', label: 'Your name', type: 'text', enabled: true, required: false, builtin: true },
  { key: 'sku_id', label: 'Which product did you buy?', type: 'product', enabled: true, required: false, builtin: true },
  { key: 'vehicle_reg', label: 'Vehicle / serial (optional)', type: 'text', enabled: true, required: false, builtin: true },
  { key: 'consumer_email', label: 'Email', type: 'email', enabled: false, required: false, builtin: true },
];

async function loadFields(orgId: string): Promise<CaptureField[]> {
  const { data } = await supabaseAdmin
    .from('distribution_capture_config')
    .select('fields')
    .eq('org_id', orgId)
    .maybeSingle();
  const raw = (data as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_FIELDS;
  const parsed = z.array(captureFieldSchema).safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_FIELDS;
}

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

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
  const [{ data: store }, { data: skus }, fields] = await Promise.all([
    supabaseAdmin.from('stores').select('name').eq('id', outlet.outlet_id).maybeSingle(),
    supabaseAdmin.from('skus')
      .select('id, name, sku_code')
      .eq('org_id', outlet.org_id)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(300),
    loadFields(outlet.org_id),
  ]);
  res.status(200).json({
    success: true,
    data: {
      outlet_name: (store as { name?: string } | null)?.name || 'this store',
      products: (skus || []).map((s: any) => ({ sku_id: s.id, name: s.name, sku_code: s.sku_code })),
      // Only the enabled fields, in admin order, drive the public page.
      fields: fields.filter((f) => f.enabled),
    },
  });
});

const publicSubmitSchema = z.object({
  consumer_phone: z.string().min(7).max(20),
  // Answers keyed by field key (built-in keys + custom cf_* keys). Values are
  // coerced to strings; the server maps built-ins to columns and the rest to
  // capture_extra per the org's form config.
  fields:         z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  // How the consumer arrived — a scanned QR (default), the wa.me link, or a
  // plain web form. Anything else is coerced to 'qr'.
  channel:        z.enum(['qr', 'whatsapp', 'webform']).optional(),
});

const strOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** POST /api/v1/distribution/capture/:token — record a consumer registration. */
export const publicSubmit = asyncHandler<Request>(async (req: Request, res: Response) => {
  const token = String(req.params.token || '').trim();
  const outlet = await outletForToken(token);
  if (!outlet || !outlet.capture_active) {
    res.status(404).json({ success: false, error: 'This capture link is not active.' });
    return;
  }
  const parsed = publicSubmitSchema.safeParse(req.body);
  if (!parsed.success || strOrNull(parsed.data.consumer_phone) === null) {
    res.status(400).json({ success: false, error: 'Please enter a valid phone number.' });
    return;
  }
  const answers = parsed.data.fields || {};
  const fieldDefs = (await loadFields(outlet.org_id)).filter((f) => f.enabled);

  // Enforce required fields (phone is always required and already checked).
  for (const f of fieldDefs) {
    if (f.required && strOrNull(answers[f.key]) === null) {
      res.status(400).json({ success: false, error: `${f.label} is required.` });
      return;
    }
  }

  // Split answers into built-in columns vs custom (capture_extra, keyed by label).
  const captureExtra: Record<string, string> = {};
  for (const f of fieldDefs) {
    if (BUILTIN_FIELD_KEYS.has(f.key)) continue;
    const v = strOrNull(answers[f.key]);
    if (v !== null) captureExtra[f.label] = v;
  }
  const rawSku = strOrNull(answers['sku_id']);

  try {
    const result = await registerConsumerPurchase(
      {
        consumer_phone: parsed.data.consumer_phone,
        consumer_name:  strOrNull(answers['consumer_name']),
        consumer_email: strOrNull(answers['consumer_email']),
        sku_id:         isUuid(rawSku) ? rawSku : null,
        serial_id:      null,
        serial_text:    null,
        // Attribute the sale to this outlet as the servicing retailer.
        retailer_id:    outlet.outlet_id,
        vehicle_reg:    strOrNull(answers['vehicle_reg']),
        registered_via: parsed.data.channel || 'qr',
        cashback_amount: 0,
        evidence_url:   null,
        capture_extra:  Object.keys(captureExtra).length ? captureExtra : null,
      },
      { org_id: outlet.org_id, client_id: outlet.client_id ?? null, actor_id: null },
    );
    res.status(201).json({ success: true, data: { id: result.reg.id } });
  } catch {
    // Never leak internals to an anonymous caller; the write path logs the cause.
    res.status(400).json({ success: false, error: 'Could not save. Please try again.' });
  }
});

// ── ADMIN: form config ──────────────────────────────────────────────────────

/** GET /api/v1/distribution/capture-admin/config — the org's capture form. */
export const adminGetConfig = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const fields = await loadFields(user.org_id);
  ok(res, { fields });
});

/** PUT /api/v1/distribution/capture-admin/config — save the org's capture form. */
export const adminSaveConfig = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = z.object({ fields: z.array(captureFieldSchema).max(40) }).safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Invalid form fields', parsed.error.errors);

  // Guard the built-in contract: built-in keys must be known; custom keys must
  // not collide with a built-in or with phone. Dedupe keys (last wins would be
  // ambiguous, so reject).
  const seen = new Set<string>();
  for (const f of parsed.data.fields) {
    if (f.key === 'consumer_phone') return badRequest(res, 'Phone is always captured and cannot be configured here.');
    if (f.builtin && !BUILTIN_FIELD_KEYS.has(f.key)) return badRequest(res, `Unknown built-in field: ${f.key}`);
    if (!f.builtin && BUILTIN_FIELD_KEYS.has(f.key)) return badRequest(res, `Reserved field key: ${f.key}`);
    if (seen.has(f.key)) return badRequest(res, `Duplicate field: ${f.key}`);
    seen.add(f.key);
    if (f.type === 'select' && (!f.options || f.options.length === 0)) {
      return badRequest(res, `Dropdown "${f.label}" needs at least one option.`);
    }
  }

  const { error } = await supabaseAdmin.from('distribution_capture_config').upsert(
    {
      org_id: user.org_id,
      client_id: user.client_id ?? null,
      fields: parsed.data.fields,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id' },
  );
  if (error) return badRequest(res, error.message);
  ok(res, { fields: parsed.data.fields });
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
