/**
 * Internal cron endpoints — gated by a shared secret, NOT user JWT,
 * because they're invoked by pg_cron via a Supabase Edge Function
 * (no human user, no Supabase Auth context).
 *
 * Mounted in app.ts BEFORE the auth catch-all on /api/v1, so requests
 * to /api/v1/cron/* bypass the requireAuth middleware. Anything not
 * carrying `Authorization: Bearer ${KINEMATIC_EDGE_SECRET}` gets a 401.
 *
 * KINEMATIC_EDGE_SECRET must be set on both Railway (this server) and
 * Supabase (the edge function caller). If it's missing on the server,
 * we return 503 so we never silently allow unauthenticated traffic
 * through a misconfigured deploy.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { dispatchPendingPushes } from '../services/notifications.service';
import { logger } from '../lib/logger';

const router = Router();

function requireEdgeSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.KINEMATIC_EDGE_SECRET || '';
  if (!secret) {
    logger.warn('[cron] KINEMATIC_EDGE_SECRET not configured — refusing to authorise');
    return res.status(503).json({
      success: false,
      error: 'KINEMATIC_EDGE_SECRET not configured on the server',
      code: 'CRON_SECRET_MISSING',
    });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized', code: 'BAD_EDGE_SECRET' });
  }
  next();
}

/**
 * POST /api/v1/cron/dispatch-pushes
 *
 * Fan-out for unsent rows in public.notifications. Pulls up to 200
 * rows per call; pg_cron schedules this every minute (see migration
 * crm_reminder_push_dispatch). Idempotent on sent_at, so concurrent
 * invocations cap at "same row twice" worst case — never spam.
 */
router.post('/dispatch-pushes', requireEdgeSecret, async (_req, res) => {
  try {
    const result = await dispatchPendingPushes({ limit: 200 });
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`[cron] dispatch-pushes crashed: ${err?.message || err}`);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
