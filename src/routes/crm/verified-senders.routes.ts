/**
 * Per-tenant verified sender CRUD + verification confirmation.
 * Mounted at /api/v1/crm/verified-senders.
 *
 * The /verify/:token endpoint is intentionally public — the recipient of
 * the verification email isn't necessarily a logged-in Kinematic user.
 */
import { Router, Request, Response, NextFunction } from 'express';
import {
  listSenders, addSender, deleteSender, setDefault,
} from '../../services/crm/verifiedSenders.service';
import type { AuthRequest } from '../../types';

const router: Router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get('/', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  const verifiedOnly = req.query.verified === '1' || req.query.verified === 'true';
  const rows = await listSenders(u.org_id, verifiedOnly);
  res.json({ success: true, data: rows });
}));

router.post('/', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  const { email, display_name } = (req.body || {}) as { email?: string; display_name?: string };
  if (!email) return res.status(400).json({ success: false, error: 'email is required' });
  const row = await addSender(u.org_id, u.client_id ?? null, u.id, email, display_name);
  res.status(201).json({ success: true, data: row });
}));

router.delete('/:id', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  await deleteSender(u.org_id, req.params.id);
  res.status(204).end();
}));

router.post('/:id/default', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  await setDefault(u.org_id, req.params.id);
  res.json({ success: true });
}));

// Public verification endpoint lives in verified-senders-public.routes.ts
// — mounted at /crm/verified-senders/verify in app.ts BEFORE requireAuth.
// Keeping it here would have meant requireAuth would 401 the inbound click
// before the handler ever ran.

export default router;
