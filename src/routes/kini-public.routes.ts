/**
 * Public (unauthenticated) KINI website-chatbot ingestion.
 *
 * Mounted at /api/v1/kini/public BEFORE the global requireAuth gate in app.ts
 * (same pattern as the lead-source webhooks at /api/v1/integrations/webhook and
 * the WhatsApp webhook at /api/v1/crm/webhooks/whatsapp). Authenticated by a
 * shared secret (KINI_WEB_CHAT_KEY) checked inside the controller.
 */
import { Router } from 'express';
import express from 'express';
import { perRouteLimit } from '../middleware/security';
import { publicIngest } from '../controllers/crm/webChat.controller';

const router: Router = Router();

// A chatty visitor sends one POST per turn; 120/min/IP is generous for a
// single conversation while capping abuse.
const chatLimit = perRouteLimit({ windowMs: 60_000, max: 120 });

router.post('/web-chat', chatLimit, express.json({ limit: '256kb' }), publicIngest);

export default router;
