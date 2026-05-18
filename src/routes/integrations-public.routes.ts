/**
 * Public webhook ingestion for lead-source integrations.
 *
 * Mounted at /api/v1/integrations/webhook BEFORE the global requireAuth
 * middleware in app.ts (mirroring the WhatsApp webhook pattern at
 * /api/v1/crm/webhooks/whatsapp). Authentication is per-provider:
 *   - web-form / generic   — shared secret in URL (`?key=...`)
 *   - meta-lead-ads        — X-Hub-Signature-256 (HMAC over raw body)
 *   - google-ads           — shared key in payload
 *
 * The endpoint always responds 200 (even on error) to prevent the
 * sender from retrying. Errors are persisted to crm_lead_inbound_events
 * and surfaced in the admin UI.
 */
import { Router } from 'express';
import { perRouteLimit } from '../middleware/security';
import { inboundWebhook } from '../controllers/crm/integrations.controller';

const router = Router();

// 200 requests/min/IP. Web forms can burst (newsletter signup, contest
// landing page); generous ceiling avoids dropping legitimate spikes
// while keeping abusive traffic capped.
const webhookLimit = perRouteLimit({ windowMs: 60_000, max: 200 });

// Generic shape: /webhook/:provider/:id?key=<webhook_secret>
//   :provider is the URL-slug form (web-form, meta-lead-ads, google-ads,
//             generic), translated to provider_id inside the controller.
//   :id is the integration uuid.
router.post('/:provider/:id', webhookLimit, inboundWebhook);

// GET is reserved for verification challenges (Meta uses it on the
// leadgen subscription; the WhatsApp pattern handles this for that
// provider already). For v1 we wire only POST; the GET arrives with
// Meta v2 and we'll plug a `verifyChallenge` provider hook in then.

export default router;
