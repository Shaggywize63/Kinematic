// OAuth 2.0 authorization server routes. Mounted at /oauth (see app.ts), BEFORE
// the global requireAuth catch-all — these endpoints authenticate the user
// themselves and must be reachable without a Supabase Bearer JWT.
//
// Body parsing: the app mounts express.json() globally, but the OAuth token +
// consent endpoints receive application/x-www-form-urlencoded, so we add an
// urlencoded parser here. (json content-type is already parsed upstream.)

import express, { Router } from 'express';
import * as ctrl from '../controllers/oauth.controller';
import { perRouteLimit } from '../middleware/security';

const router = Router();
const form = express.urlencoded({ extended: false });
const json = express.json();

// Dynamic Client Registration (RFC 7591) — MCP connectors self-register.
// Rate-limited since it is unauthenticated + creates rows.
router.post('/register', perRouteLimit({ windowMs: 60_000, max: 10 }), json, ctrl.register);

// Login + consent screen.
router.get('/authorize', ctrl.authorize);
router.post('/authorize', perRouteLimit({ windowMs: 60_000, max: 20 }), form, ctrl.authorizeSubmit);

// Token exchange + refresh, and revocation.
router.post('/token', perRouteLimit({ windowMs: 60_000, max: 60 }), form, ctrl.token);
router.post('/revoke', form, ctrl.revoke);

export default router;
