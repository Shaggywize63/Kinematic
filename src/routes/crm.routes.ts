/**
 * CRM module — single routes file with sub-routers per resource.
 * Mounted at /api/v1/crm in src/app.ts.
 *
 * Controllers are inlined (thin) to keep a single file as the routing
 * source-of-truth. All real logic lives in services/crm/*.
 */
import express, { Request, Response, NextFunction, Router } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { AppError } from '../utils';
import { supabaseAdmin } from '../lib/supabase';

import { demoCrmMiddleware } from '../utils/demoCrm';
import * as v from '../validators/crm.validators';
import * as crud from '../services/crm/crud.service';
import * as leadsSvc from '../services/crm/leads.service';
import * as dealsSvc from '../services/crm/deals.service';
import * as importSvc from '../services/crm/import.service';
import * as analyticsSvc from '../services/crm/analytics.service';
import * as emailsSvc from '../services/crm/emails.service';
import * as whatsappSvc from '../services/crm/whatsapp.service';
import * as productsSvc from '../services/crm/products.service';
import * as nbaSvc from '../services/crm/ai/nextBestAction.service';
import * as winSvc from '../services/crm/ai/winProbability.service';
import * as autoRespSvc from '../services/crm/ai/autoResponse.service';
import * as summarizeSvc from '../services/crm/ai/summarize.service';
import * as kiniTools from '../services/crm/ai/kiniTools.service';
import * as locationsSvc from '../services/crm/locations.service';
import * as whatsappTranslate from '../services/crm/whatsappTranslate.service';
import * as kiniQuota from '../services/crm/ai/kiniQuota.service';
import { chatWithTools } from '../services/crm/ai/aiClient';
import { stampOwnerNames, stampOwnerName } from '../services/crm/owners.helper';

const router: Router = express.Router();

// ----- PUBLIC ROUTES (registered before requireAuth) -----
// Email tracking + WhatsApp webhook accept signed/tokened requests; the
// shared secret in the URL path or body IS the auth.
router.get('/emails/track/open/:token', async (req, res) => {
  await emailsSvc.recordOpen(req.params.token).catch(() => {});
  res.set('Content-Type', 'image/gif');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});
router.get('/emails/track/click/:token', async (req, res) => {
  await emailsSvc.recordClick(req.params.token).catch(() => {});
  res.redirect(302, String(req.query.u ?? '/'));
});

// Meta WhatsApp Business webhook verification (challenge handshake).
router.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.CRM_WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge ?? ''));
  }
  res.sendStatus(403);
});
router.post('/webhooks/whatsapp', express.json({ limit: '2mb' }), async (req, res) => {
  const sigHeader = req.headers['x-hub-signature-256'];
  if (process.env.CRM_WHATSAPP_APP_SECRET && typeof sigHeader === 'string') {
    const crypto = await import('crypto');
    const raw = JSON.stringify(req.body);
    const expected = 'sha256=' + crypto
      .createHmac('sha256', process.env.CRM_WHATSAPP_APP_SECRET)
      .update(raw).digest('hex');
    if (expected !== sigHeader) return res.sendStatus(401);
  }
  const orgId = (req.body?.org_id as string | undefined)
    ?? (req.headers['x-org-id'] as string | undefined);
  if (!orgId) {
    return res.status(202).json({ ignored: 'no org context resolvable for stub provider' });
  }
  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        for (const m of value.messages ?? []) {
          await whatsappSvc.recordInbound({
            org_id: orgId,
            from_phone: m.from,
            to_phone: value.metadata?.display_phone_number,
            body_text: m.text?.body,
            media_url: m.image?.id ?? m.document?.id ?? m.video?.id,
            media_type: m.type,
            provider_message_id: m.id,
            in_reply_to: m.context?.id,
          });
        }
        for (const s of value.statuses ?? []) {
          await whatsappSvc.recordStatusUpdate({
            org_id: orgId,
            provider_message_id: s.id,
            status: s.status as 'delivered' | 'read' | 'failed',
            error: s.errors?.[0]?.title,
          });
        }
      }
    }
  } catch {
    // Best-effort; never fail the webhook so Meta doesn't retry.
  }
  res.sendStatus(200);
});

// ----- AUTHENTICATED ROUTES BELOW -----
router.use(requireAuth, requireModule('crm'));

// Wrap every res.json payload in {success, data} so the dashboard's
// Wrapped<T> typings match runtime. Pass-through if the body already has
// a `success` field (error handler emits {success:false,...}).
router.use((_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (body && typeof body === 'object' && 'success' in (body as Record<string, unknown>)) {
      return originalJson(body);
    }
    return originalJson({ success: true, data: body });
  };
  next();
});

// Demo bypass: when org_id=demo-org-999, short-circuit GETs to canned fixtures
// and writes to no-op success. Mounted AFTER the success-envelope wrapper so
// fixture payloads come out the same shape the frontend expects.
router.use(demoCrmMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- helpers --------------------------------------------------
const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

function orgId(req: Request): string {
  const r = req as Request & { user?: { org_id?: string }; auth?: { org_id?: string } };
  const id = r.user?.org_id ?? r.auth?.org_id ?? (req.headers['x-org-id'] as string | undefined);
  if (!id) throw new AppError(400, 'No org context on request', 'NO_ORG');
  return String(id);
}
function userId(req: Request): string | undefined {
  const r = req as Request & { user?: { id?: string; user_id?: string }; auth?: { user_id?: string } };
  return r.user?.id ?? r.user?.user_id ?? r.auth?.user_id;
}
// Multi-tenant: client_id scopes CRM data within an org.
// - super_admin: NEVER scoped. Sees every client's data + org-level rows
//   regardless of what's in the X-Client-Id header. The picker on the dashboard
//   is informational only for super-admins.
// - Client-level users (JWT has client_id): pinned to that client; the header is ignored.
// - Other org-level admins (no JWT client_id): may pass X-Client-Id (a UUID) so
//   the global picker can scope their CRM view/configuration to a specific client.
// - When no client is in scope, behaviour falls back to org-level (NULL client_id).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the client scope for the current request.
 *
 * Returns:
 *   - `{ id: <uuid>, strict: true }`  — caller's JWT pins them to a
 *     specific client (a "client-level" user like Hemanth). Lists
 *     MUST be hard-isolated to that client_id, otherwise legacy
 *     NULL-stamped rows leak across tenants. This is the data-leak
 *     fix: previously Hemanth's mobile login was seeing Nikhil's
 *     leads because the OR-with-NULL filter surfaced every legacy
 *     row to every client user.
 *   - `{ id: <uuid>, strict: false }` — caller is an org-level admin
 *     who selected a client from the global picker (header). They
 *     should still see legacy NULL rows alongside the selected
 *     client's rows so they can administer them — hence
 *     non-strict (OR with NULL).
 *   - `{ id: null, strict: false }` — org-level admin with no
 *     picker (or super_admin). No client filter applied.
 */
function clientScope(req: Request): { id: string | null; strict: boolean } {
  const r = req as Request & { user?: { client_id?: string | null; role?: string | null } };
  if (r.user?.role?.toLowerCase() === 'super_admin') return { id: null, strict: false };
  if (r.user?.client_id) return { id: r.user.client_id, strict: true };
  const headerVal = (req.headers['x-client-id'] as string | undefined)?.trim();
  if (headerVal && UUID_RE.test(headerVal)) return { id: headerVal, strict: false };
  return { id: null, strict: false };
}

/** Back-compat: most callers only need the id, not the source. */
function clientId(req: Request): string | null { return clientScope(req).id; }
function dateRange(req: Request): { from?: string; to?: string } {
  const from = req.query.from ? String(req.query.from) : undefined;
  const to = req.query.to ? String(req.query.to) : undefined;
  return { from, to };
}
function parse<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  try { return schema.parse(payload); }
  catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new AppError(400, `Validation failed: ${issues}`, 'VALIDATION');
    }
    throw e;
  }
}

// PLACEHOLDER_FOR_CONTENT_REPLACEMENT