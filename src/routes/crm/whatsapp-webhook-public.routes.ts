/**
 * Public Meta WhatsApp Business webhook — verification handshake (GET) and
 * inbound message / status ingestion (POST).
 *
 * MUST be mounted BEFORE the `requireAuth`-gated `/api/v1/crm` catch-all in
 * app.ts: Meta calls this URL with no Authorization header, so if it resolved
 * through the auth gate every call would 401 and the callback URL would never
 * validate. (This is why the earlier in-router copy of these handlers, sitting
 * inside crm.routes behind the auth mount, could never be reached by Meta.)
 *
 * Tenanting: Meta does not send our X-Kinematic-Project / X-Org-Id headers, so
 * we resolve the owning project + org from the payload's
 * `value.metadata.phone_number_id` against each project's
 * crm_whatsapp_connections, then process the batch inside that project's
 * AsyncLocalStorage context. A legacy X-Org-Id header (the internal WA-bridge)
 * is still honoured as a fallback.
 */
import { Router } from 'express';
import { knownProjectKeys, adminClientFor, runWithProject, fallbackProjectKey } from '../../lib/projects';
import { logger } from '../../lib/logger';
import * as whatsappSvc from '../../services/crm/whatsapp.service';

const router = Router();

// ── GET: Meta verification challenge ────────────────────────────────────────
// The verify token is a single global value (project-independent) — it only
// proves the caller configured the same secret in the Meta app, before any
// tenant context exists.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.CRM_WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
});

// ── Tenant resolution by Cloud-API phone_number_id ──────────────────────────
interface Tenant { project: string; org_id: string; }
const tenantCache = new Map<string, { tenant: Tenant | null; exp: number }>();
const TENANT_TTL_MS = 5 * 60 * 1000;

async function resolveTenantByPhoneId(phoneNumberId: string): Promise<Tenant | null> {
  const hit = tenantCache.get(phoneNumberId);
  if (hit && hit.exp > Date.now()) return hit.tenant;
  let tenant: Tenant | null = null;
  for (const project of knownProjectKeys()) {
    try {
      const { data } = await adminClientFor(project)
        .from('crm_whatsapp_connections')
        .select('org_id')
        .eq('phone_number_id', phoneNumberId)
        .limit(1)
        .maybeSingle();
      const orgId = (data as { org_id?: string } | null)?.org_id;
      if (orgId) { tenant = { project, org_id: orgId }; break; }
    } catch {
      /* table absent in a project that hasn't provisioned WhatsApp — skip */
    }
  }
  tenantCache.set(phoneNumberId, { tenant, exp: Date.now() + TENANT_TTL_MS });
  return tenant;
}

// ── POST: inbound messages + delivery/read status updates ───────────────────
router.post('/', async (req, res) => {
  // Signature check against the RAW request bytes. Meta signs the literal POST
  // body; re-stringifying parsed JSON would not reproduce the exact bytes and
  // would reject every genuine call. `req.rawBody` is stashed by the global
  // json parser (app.ts). Only enforced once the app secret is configured;
  // before then we fail-open so the callback still verifies.
  const appSecret = process.env.CRM_WHATSAPP_APP_SECRET;
  const sigHeader = req.headers['x-hub-signature-256'];
  if (appSecret && typeof sigHeader === 'string') {
    const crypto = await import('crypto');
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody
      ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sigHeader, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  }

  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        const phoneNumberId = value?.metadata?.phone_number_id as string | undefined;

        // Resolve the owning tenant: phone_number_id → connection row, else the
        // legacy X-Org-Id header (internal WA-bridge) in the current project.
        let tenant: Tenant | null = phoneNumberId ? await resolveTenantByPhoneId(phoneNumberId) : null;
        if (!tenant) {
          const headerOrg = req.headers['x-org-id'] as string | undefined;
          if (headerOrg) {
            const project = (req as unknown as { projectKey?: string }).projectKey || fallbackProjectKey();
            tenant = { project, org_id: headerOrg };
          }
        }
        if (!tenant) {
          logger.warn(`[whatsapp-webhook] unresolved tenant for phone_number_id=${phoneNumberId ?? 'n/a'} — dropping change`);
          continue;
        }

        const orgId = tenant.org_id;
        await runWithProject(tenant.project, async () => {
          for (const m of value.messages ?? []) {
            const bodyText = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
            const buttonPayload = m.button?.payload ?? m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id;
            await whatsappSvc.recordInbound({
              org_id: orgId,
              from_phone: m.from,
              to_phone: value.metadata?.display_phone_number,
              body_text: bodyText,
              button_payload: buttonPayload,
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
              pricing: s.pricing ? { category: s.pricing.category, billable: s.pricing.billable } : undefined,
            });
          }
        });
      }
    }
  } catch (e) {
    // Never fail the webhook — Meta retries and eventually disables a URL that
    // keeps erroring. Log and 200 so a bad single payload can't take it down.
    logger.warn(`[whatsapp-webhook] processing error: ${(e as Error)?.message || e}`);
  }
  res.sendStatus(200);
});

export default router;
