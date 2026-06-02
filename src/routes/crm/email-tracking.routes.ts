/**
 * Public email tracking handlers — the open pixel + click-redirect endpoints
 * that recipients hit from their inbox client without an Authorization
 * header. The shared secret in the URL token IS the auth.
 *
 * Mounted in app.ts BEFORE the auth-gated /api/v1/crm router so the
 * router-level requireAuth doesn't reject inbound clicks/opens.
 */
import { Router, Request, Response } from 'express';
import * as emailsSvc from '../../services/crm/emails.service';

const router: Router = Router();

router.get('/open/:token', async (req: Request, res: Response) => {
  await emailsSvc.recordOpen(req.params.token).catch(() => {});
  res.set('Content-Type', 'image/gif');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

router.get('/click/:token', async (req: Request, res: Response) => {
  await emailsSvc.recordClick(req.params.token).catch(() => {});
  // Open-redirect guard. Before: `res.redirect(302, req.query.u)` —
  // anyone could craft a phishing link
  //   `${api}/.../track/click/<token>?u=https://attacker.com`
  // that 302s the recipient off-platform. Now we only follow URLs whose
  // hostname is in CRM_TRACKING_REDIRECT_HOSTS (comma-separated env list,
  // defaults to DASHBOARD_URL) — anything else falls back to '/'.
  const raw = String(req.query.u ?? '/');
  let target = '/';
  try {
    if (raw.startsWith('/')) {
      target = raw; // relative paths are always same-origin
    } else {
      const u = new URL(raw);
      // Same-host is always allowed — can't be an open-redirect by
      // definition (we're redirecting from the API back to itself, e.g.
      // the sender-verification email's link → /verified-senders/verify/:token).
      const sameHost = req.hostname && u.hostname === req.hostname;
      const allow = (process.env.CRM_TRACKING_REDIRECT_HOSTS || process.env.DASHBOARD_URL || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
        .map((h) => { try { return new URL(h).hostname; } catch { return h.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); } });
      if (sameHost || allow.includes(u.hostname) || allow.some((h) => u.hostname.endsWith('.' + h))) {
        target = u.toString();
      }
    }
  } catch { /* fall through to '/' */ }
  res.redirect(302, target);
});

export default router;
