// OAuth 2.0 authorization server routes. Mounted at /oauth (see app.ts), BEFORE
// the global requireAuth catch-all — these endpoints authenticate the user
// themselves and must be reachable without a Supabase Bearer JWT.
//
// Body parsing: the app mounts express.json() globally, but the OAuth token +
// consent endpoints receive application/x-www-form-urlencoded, so we add an
// urlencoded parser here. (json content-type is already parsed upstream.)

import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as ctrl from '../controllers/oauth.controller';
import { perRouteLimit } from '../middleware/security';
import { oauthDiag } from '../lib/oauth/store';

const router = Router();
const form = express.urlencoded({ extended: false });
const json = express.json();

// Route-boundary probe: fires the INSTANT a token request reaches Express —
// before the rate-limiter or body parser can reject it. Lets us tell "the
// request never reached the server" (edge/WAF block or client never sent it)
// apart from "reached the server but our own middleware rejected it". Paired
// with the `token_received` diag inside the controller.
const probeTokenRoute = (req: Request, _res: Response, next: NextFunction) => {
  void oauthDiag('token_route_hit', {
    method: req.method,
    ct: (req.headers['content-type'] as string | undefined) ?? null,
    len: (req.headers['content-length'] as string | undefined) ?? null,
    ua: String(req.headers['user-agent'] ?? '').slice(0, 80),
    ip: req.ip ?? null,
  });
  next();
};

// Dynamic Client Registration (RFC 7591) — MCP connectors self-register.
// Rate-limited since it is unauthenticated + creates rows.
router.post('/register', perRouteLimit({ windowMs: 60_000, max: 10 }), json, ctrl.register);

// Login + consent screen.
router.get('/authorize', ctrl.authorize);
router.post('/authorize', perRouteLimit({ windowMs: 60_000, max: 20 }), form, ctrl.authorizeSubmit);

// Token exchange + refresh, and revocation.
router.post('/token', probeTokenRoute, perRouteLimit({ windowMs: 60_000, max: 60 }), form, ctrl.token);
router.post('/revoke', form, ctrl.revoke);

export default router;
