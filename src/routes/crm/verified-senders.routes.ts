/**
 * Per-tenant verified sender CRUD + verification confirmation.
 * Mounted at /api/v1/crm/verified-senders.
 *
 * The /verify/:token endpoint is intentionally public — the recipient of
 * the verification email isn't necessarily a logged-in Kinematic user.
 */
import { Router, Request, Response, NextFunction } from 'express';
import {
  listSenders, addSender, verifyToken, deleteSender, setDefault,
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

// Public verification endpoint — the link in the verification email lands
// the recipient here without an auth header. Returns a tiny HTML page so
// the user sees confirmation in their browser.
router.get('/verify/:token', wrap(async (req, res) => {
  const row = await verifyToken(req.params.token);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!row) {
    res.status(400).send(verifyPage('This verification link is invalid or has expired.', false));
    return;
  }
  res.send(verifyPage(`${row.email} is now a verified sender.`, true));
}));

function verifyPage(message: string, ok: boolean): string {
  const colour = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sender verification</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f1115;color:#fff}
.card{background:#1a1e26;border:1px solid #2a2f3a;border-radius:14px;padding:32px 28px;max-width:420px;text-align:center}
h1{margin:0 0 12px;font-size:18px;color:${colour}}p{font-size:14px;color:#cbd0d8;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>${ok ? 'Verified' : 'Could not verify'}</h1><p>${message}</p></div></body></html>`;
}

export default router;
