/**
 * Public webhook ingestion for lead-source integrations.
 *
 * Mounted at /api/v1/integrations BEFORE the global requireAuth middleware
 * in app.ts (mirroring the WhatsApp webhook pattern at
 * /api/v1/crm/webhooks/whatsapp) — see the mount note below for why it's
 * `/integrations` rather than `/integrations/webhook`. Authentication is
 * per-provider:
 *   - web-form / generic   — shared secret in URL (`?key=...`)
 *   - meta-lead-ads        — X-Hub-Signature-256 (HMAC over raw body)
 *   - google-ads           — shared key in payload
 *   - inbound-email relay  — shared X-Relay-Secret header (no per-integration
 *                            key; the alias token in the body IS the routing
 *                            key, not a secret)
 *
 * The endpoint always responds 200 (even on error) to prevent the
 * sender from retrying. Errors are persisted to crm_lead_inbound_events
 * and surfaced in the admin UI.
 */
import { Router } from 'express';
import { perRouteLimit } from '../middleware/security';
import { withIntegrationProject } from '../middleware/withProject';
import { inboundWebhook, verifyChallenge, inboundEmailRelay } from '../controllers/crm/integrations.controller';

const router = Router();

// 200 requests/min/IP. Web forms can burst (newsletter signup, contest
// landing page); generous ceiling avoids dropping legitimate spikes
// while keeping abusive traffic capped.
const webhookLimit = perRouteLimit({ windowMs: 60_000, max: 200 });

// NOTE on the mount: this router is mounted in app.ts at `${V1}/integrations`
// (not `${V1}/integrations/webhook`) specifically so the inbound-email relay
// route below can live at the exact `/api/v1/integrations/inbound-email/relay`
// path the already-deployed Lambda POSTs to — a sub-router mounted under
// `/webhook` can never produce a URL without "webhook" in it. The `/webhook`
// prefix is kept here on the two pre-existing routes instead, so their public
// URLs (`/api/v1/integrations/webhook/:provider/:id`) are byte-for-byte
// unchanged.

// Meta-style subscription handshake (GET). Only meta-lead-ads uses this
// today; other providers return 405 from the handler. Same path shape as
// the POST so admins paste a single URL into the provider's webhook field.
// withIntegrationProject routes the request to whichever project owns :id.
router.get('/webhook/:provider/:id', withIntegrationProject, webhookLimit, verifyChallenge);

// Generic shape: /webhook/:provider/:id?key=<webhook_secret>
//   :provider is the URL-slug form (web-form, meta-lead-ads, google-ads,
//             generic-webhook), translated to provider_id inside the
//             controller.
//   :id is the integration uuid.
router.post('/webhook/:provider/:id', withIntegrationProject, webhookLimit, inboundWebhook);

// Dedicated inbound-email relay: POST /api/v1/integrations/inbound-email/relay.
// No :id in the path (the Lambda only knows the alias address, not which
// integration owns it) so withIntegrationProject doesn't apply here — the
// controller itself probes every known project for the alias and authenticates
// via X-Relay-Secret instead of the `?key=`/:id shape above.
router.post('/inbound-email/relay', webhookLimit, inboundEmailRelay);

export default router;
