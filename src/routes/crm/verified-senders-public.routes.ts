/**
 * Public verified-sender confirmation endpoint.
 *
 * The link in the verification email lands the recipient here without
 * any Authorization header — the 48+ char token in the URL path IS the
 * auth. Returns a tiny HTML page so the user sees a confirmation directly
 * in their browser (no need to be logged into the dashboard).
 *
 * Mounted in app.ts BEFORE the auth-gated /api/v1/crm prefix so neither
 * the global /api/v1 requireAuth catch-all nor the per-mount requireAuth
 * on the authenticated verified-senders router reject the click.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { verifyToken } from '../../services/crm/verifiedSenders.service';

const router: Router = Router();
const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get('/:token', wrap(async (req, res) => {
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
