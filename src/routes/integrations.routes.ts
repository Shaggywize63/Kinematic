/**
 * Authenticated CRUD on lead-source integrations + per-user Google
 * Calendar OAuth handshake. Mounted at /api/v1/integrations AFTER the
 * global requireAuth middleware in app.ts.
 *
 * Google Calendar routes are declared BEFORE the /:id routes so that
 * "/google" / "/google/status" etc. don't accidentally match :id.
 */
import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  listIntegrationEvents,
  testIntegration,
} from '../controllers/crm/integrations.controller';
import {
  buildAuthUrl,
  completeOAuth,
  disconnect as disconnectGoogle,
  getStatus as getGoogleStatus,
  isConfigured as googleConfigured,
} from '../services/integrations/googleCalendar.service';
import { AppError } from '../utils';

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

function reqUser(req: Request): { id: string; org_id: string } {
  const r = req as Request & { user?: { id?: string; org_id?: string } };
  const id = r.user?.id;
  const org = r.user?.org_id;
  if (!id || !org) throw new AppError(401, 'Not authenticated', 'NO_USER');
  return { id, org_id: org };
}

function stateSecret(): string {
  return process.env.GOOGLE_OAUTH_STATE_SECRET
      || process.env.SUPABASE_JWT_SECRET
      || 'dev-only-secret-replace-me';
}

// ── Google Calendar OAuth ────────────────────────────────────────────────
router.get('/google/authorize', wrap(async (req, res) => {
  if (!googleConfigured()) throw new AppError(500, 'Google OAuth is not configured', 'NOT_CONFIGURED');
  const u = reqUser(req);
  // Sign user + org into the state so the callback can map the code
  // back to the right rep (no cookies survive Google's redirect).
  const state = jwt.sign(
    { uid: u.id, oid: u.org_id, kind: 'google_oauth' },
    stateSecret(),
    { expiresIn: '10m' },
  );
  res.json({ url: buildAuthUrl(state) });
}));

router.get('/google/status', wrap(async (req, res) => {
  const u = reqUser(req);
  if (!googleConfigured()) return res.json({ connected: false, configured: false });
  const s = await getGoogleStatus(u.id);
  res.json({ ...s, configured: true });
}));

router.delete('/google', wrap(async (req, res) => {
  const u = reqUser(req);
  await disconnectGoogle(u.id);
  res.status(204).end();
}));

// ── Lead-source integrations CRUD ────────────────────────────────────────
router.get('/',               listIntegrations);
router.post('/',              createIntegration);
router.get('/:id',            getIntegration);
router.patch('/:id',          updateIntegration);
router.delete('/:id',         deleteIntegration);
router.get('/:id/events',     listIntegrationEvents);
router.post('/:id/test',      testIntegration);

export default router;
