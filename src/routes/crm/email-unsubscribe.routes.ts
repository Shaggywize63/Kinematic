/**
 * Public unsubscribe handler. Hit by recipients straight from their
 * inbox — no Authorization header — so this router is mounted in
 * app.ts BEFORE the auth-gated /api/v1/crm router and the path is
 * whitelisted by the global requireAuth gate.
 *
 * Two shapes per RFC 8058 (one-click) + RFC 2369:
 *
 *   GET  /unsubscribe?t=<token>     ← user clicks the footer link
 *   POST /unsubscribe?t=<token>     ← Gmail/Yahoo inbox UI POSTs here
 *                                     with `List-Unsubscribe=One-Click`
 *
 * Both call the same handler. The shared secret in `t` IS the auth:
 * a 32-char hex token, also used as the tracking pixel token, scoped
 * to a single sent message. recordUnsubscribe() finds the row and
 * upserts crm_email_unsubscribes so future sends to that address
 * skip the provider call.
 */
import { Router, Request, Response } from 'express';
import * as emailsSvc from '../../services/crm/emails.service';

const router: Router = Router();

const handle = async (req: Request, res: Response) => {
  const token = String(req.query.t ?? '').trim();
  if (!token) {
    res.status(400).type('text/plain').send('Missing unsubscribe token.');
    return;
  }
  // RFC 8058 requires a 2xx on the POST regardless. We still return a
  // user-readable confirmation for the GET case, but never surface
  // whether the token was valid (recipient privacy + no enumeration).
  const email = await emailsSvc.recordUnsubscribe(
    token,
    req.method === 'POST' ? 'one_click' : 'link',
  ).catch(() => null);

  if (req.method === 'POST') {
    // Gmail/Yahoo don't render the body — they only check status.
    res.status(200).type('text/plain').send('ok');
    return;
  }

  // GET → render a minimal HTML confirmation. Inline styles only,
  // works in plaintext browsers, no external assets so no CSP grief.
  const body = email
    ? `You've been unsubscribed. Future emails to <strong>${escapeHtml(email)}</strong> will be blocked.`
    : `Your unsubscribe request has been received.`;
  res.status(200).type('text/html').send(
    `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/></head>` +
    `<body style="font:14px/1.5 system-ui,-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:0 16px;color:#222">` +
    `<h1 style="font-size:18px;margin:0 0 12px">Unsubscribed</h1>` +
    `<p>${body}</p>` +
    `<p style="color:#666;font-size:12px;margin-top:32px">If this was a mistake, contact the sender directly to be added back.</p>` +
    `</body></html>`,
  );
};

router.get('/', handle);
router.post('/', handle);

export default router;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
