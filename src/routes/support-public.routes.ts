/**
 * KINI WhatsApp bot → support tickets (NO user JWT). Authenticated by the shared KINI key (x-kini-key; SUPPORT_BOT_KEY,
 * else KINI_WEB_CHAT_KEY) checked in the controller. Mounted at /api/v1/support/public BEFORE the requireAuth gate.
 */
import express, { Router } from 'express';
import { perRouteLimit } from '../middleware/security';
import * as ctrl from '../controllers/support.controller';

const router: Router = Router();
router.use(perRouteLimit({ windowMs: 60_000, max: 120 }), express.json({ limit: '64kb' }));
router.post('/tickets', ctrl.botCreate);
router.get('/tickets', ctrl.botList);
router.post('/tickets/:ref/comments', ctrl.botComment);
router.post('/tickets/:ref/reopen', ctrl.botReopen);
router.patch('/tickets/:ref', ctrl.botTeamUpdate);

export default router;
