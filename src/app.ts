import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import aiRouter from './routes/ai.routes';
import kiniRoutes from './routes/kini.routes';
import leadNbaRoutes from './routes/crm/lead-nba.routes';
import leadUpdatesRoutes from './routes/crm/lead-updates.routes';

import { logger } from './lib/logger';
import { notFoundHandler } from './middleware/errorHandler';
import { requireAuth } from './middleware/auth';
import { auditAll } from './middleware/auditAll';
import auditLogRoutes from './routes/auditLog.routes';
import {
  corsOrigin, helmetConfig, requestId, sanitiseError,
  prototypePoll, strictJson, perRouteLimit, loginLimiter,
} from './middleware/security';
import { demoExtensionsMiddleware } from './utils/demoExtensions';

// Routes
import authRoutes         from './routes/auth.routes';
import attendanceRoutes   from './routes/attendance.routes';
import formsRoutes        from './routes/forms.routes';
import builderRoutes      from './routes/builder.routes';
import stockRoutes        from './routes/stock.routes';
import broadcastRoutes    from './routes/broadcast.routes';
import sosRoutes          from './routes/sos.routes';
import leaderboardRoutes  from './routes/leaderboard.routes';
import notifRoutes        from './routes/notifications.routes';
import learningRoutes     from './routes/learning.routes';
import grievanceRoutes    from './routes/grievance.routes';
import analyticsRoutes    from './routes/analytics.routes';
import visitlogRoutes     from './routes/visitlog.routes';
import uploadRoutes       from './routes/upload.routes';
import wmsRoutes          from './routes/wms.routes';
import usersRoutes        from './routes/users.routes';
import zonesRoutes        from './routes/zones.routes';
import rolesRoutes        from './routes/roles.routes';
import routePlanRoutes    from './routes/route-plan.routes';
import candidatesRouter   from './routes/candidates.routes';
import activityMappingRoutes from './routes/activity-mapping.routes';
import clientRoutes          from './routes/client.routes';
import miscRoutes            from './routes/misc.routes';
import planogramRoutes       from './routes/planogram.routes';
import integrationsRoutes        from './routes/integrations.routes';
import messagingRoutes           from './routes/messaging.routes';
import integrationsPublicRoutes  from './routes/integrations-public.routes';
import distIntegrationsRoutes    from './routes/distribution/integrations.routes';
import tallyAgentPublicRoutes    from './routes/tally-agent-public.routes';
import orgSettingsRoutes         from './routes/org-settings.routes';
import cronRoutes                from './routes/cron.routes';
import { startTallyEnqueuePoller } from './services/distribution/integrations/enqueue.poller';

// Other management routes (available, now mounted)
import activitiesRoutes   from './routes/activities.routes';
import assetsRoutes       from './routes/assets.routes';
import citiesRoutes       from './routes/cities.routes';
import managementRoutes   from './routes/management.routes';
import skusRoutes         from './routes/skus.routes';
import storesRoutes       from './routes/stores.routes';
import warehouseRoutes    from './routes/warehouse.routes';

// Distribution module
import distBrandsRoutes        from './routes/distribution/brands.routes';
import distDistributorsRoutes  from './routes/distribution/distributors.routes';
import distPriceListsRoutes    from './routes/distribution/price-lists.routes';
import distOrdersRoutes        from './routes/distribution/orders.routes';
import distSalesmanRoutes      from './routes/distribution/salesman.routes';
import distUploadsRoutes       from './routes/distribution/uploads.routes';
import distInvoicesRoutes      from './routes/distribution/invoices.routes';
import distDispatchesRoutes    from './routes/distribution/dispatches.routes';
import distDeliveriesRoutes    from './routes/distribution/deliveries.routes';
import distPaymentsRoutes      from './routes/distribution/payments.routes';
import distLedgerRoutes        from './routes/distribution/ledger.routes';
import distSchemesRoutes       from './routes/distribution/schemes.routes';
import distReturnsRoutes       from './routes/distribution/returns.routes';
import distSecondaryRoutes     from './routes/distribution/secondary-sales.routes';
import distGstinRoutes         from './routes/distribution/gstin.routes';
import organisationsRoutes     from './routes/organisations.routes';
import crmRoutes               from './routes/crm.routes';

const app = express();

// ── Request correlation (per-request UUID, echoed in X-Request-Id) ──
app.use(requestId);

// ── Security headers (strict CSP + HSTS preload + Permissions-Policy) ──
app.use(helmet(helmetConfig));
app.set('trust proxy', 1);

// ── CORS allowlist (env-driven, no more open `cb(null,true)`) ──
// Public lead-capture endpoints (embed.js + the matching webhook POST)
// need to allow ANY origin so customers can paste them on their own
// sites. Mount this BEFORE the env-driven cors() so the global
// allowlist doesn't block the cross-origin POST that the embed makes.
import * as path from 'path';
app.get('/embed.js', cors({ origin: '*' }), function (_req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // Short cache so brand-tweaks ship within an hour without a version bump.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, '..', 'public', 'embed.js'));
});

// ── Hosted lead-capture form ─────────────────────────────────────
// Zero-code option for clients who don't have / can't edit a website.
// They share https://<api>/f/<integration_id>?key=<webhook_secret> as
// a link or QR — visitors land on a clean Kinematic-branded page that
// posts directly to the integration's webhook. Same dedup + scope as
// every other inbound surface.
app.get('/f/:id', cors({ origin: '*' }), async function (req, res, next) {
  try {
    const { supabaseAdmin } = await import('./lib/supabase');
    const integrationId = String(req.params.id || '').trim();
    const key = String(req.query.key || '').trim();
    if (!integrationId || !key) {
      res.status(400).type('text/html').send('<h2 style="font-family:sans-serif">Invalid form link</h2>');
      return;
    }
    const { data: integration } = await supabaseAdmin.from('crm_lead_source_integrations')
      .select('id, label, provider, webhook_secret, status')
      .eq('id', integrationId)
      .maybeSingle();
    if (!integration || integration.webhook_secret !== key || integration.status === 'disabled') {
      res.status(404).type('text/html').send('<h2 style="font-family:sans-serif">Form not found</h2>');
      return;
    }
    const providerSlug = String(integration.provider).replace('_', '-');
    const webhookBase = `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${webhookBase}/api/v1/integrations/webhook/${providerSlug}/${integration.id}?key=${encodeURIComponent(key)}`;
    const embedUrl   = `${webhookBase}/embed.js`;
    const title      = (integration.label || 'Get a callback').replace(/</g, '&lt;');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    html,body{margin:0;padding:0;background:#F3F4F6;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111827;}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
    .card{max-width:440px;width:100%;background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,0.08);padding:8px;}
    footer{margin-top:14px;font-size:11px;color:#6B7280;text-align:center;}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="card">
      <div data-kinematic-form="${webhookUrl}"
           data-title="${title}"
           data-primary-color="#E01E2C"
           data-fields="name,email,phone,city,message"></div>
    </div>
  </main>
  <script src="${embedUrl}" async></script>
</body>
</html>`);
  } catch (e) { next(e); }
});

// Wildcard CORS specifically for the inbound webhook path. The endpoint
// authenticates per request via the `?key=<webhook_secret>` query param,
// so opening it to all origins is intentional — anyone with the URL is
// already authorised.
app.use('/api/v1/integrations/webhook', cors({ origin: '*' }));

app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'Idempotency-Key', 'X-Idempotency-Key',
    'x-org-id', 'x-client-id', 'X-Org-Id', 'X-Client-Id', 'X-Request-Id',
  ],
  maxAge: 600,
}));

// ── Global rate limiting (broad ceiling). Per-route caps are applied below. ──
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '5000', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, Path: ${req.path}`);
    res.status(options.statusCode).json({
      success: false,
      error: 'Too many requests. Please slow down.',
      code: 'TOO_MANY_REQUESTS',
      request_id: (req as any).id,
    });
  },
});

app.use('/api', limiter);
app.use('/api/v1/auth/login', loginLimiter);                   // composite (IP + email) brute-force throttle

// ── HTTP logging ─────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// ── Body parsing & misc ────────────────────────────────────
app.use(compression({ threshold: 1024 }));   // skip gzip on payloads <1KB — saves CPU on small JSON
app.use(express.json({
  limit: '2mb',
  strict: true,
  // Stash the raw request body on `req.rawBody` so webhook providers can
  // verify HMAC signatures (e.g. Meta Lead Ads' X-Hub-Signature-256 is a
  // sha256 of the literal POST bytes — re-stringifying parsed JSON would
  // break the digest). Kept only for the request lifetime; max 2MB so
  // memory impact is bounded by the parser's own limit.
  verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(strictJson);                                            // mutating routes must send JSON
app.use(prototypePoll);                                         // block __proto__ / constructor injection
app.use(auditAll);                                              // log every state change after the response finishes

// ── Health check ───────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'kinematic-api',
    version: '1.0.1-perf-V6',
    timestamp: new Date().toISOString(),
  });
});

// ── API routes ─────────────────────────────────────
const V1 = '/api/v1';

import { requireModule, enforceCityScope } from './middleware/rbac';

// ── Public webhook ingestion (NO auth) ───────────────────────
// Mounted BEFORE the auth-catch-all below so provider webhooks
// (web-form, generic, Meta, Google Ads) can post without a JWT. Each
// integration is identified by `:id` in the URL and verified via the
// per-integration secret (URL key or HMAC, depending on provider).
// Mirrors the WhatsApp webhook pattern at /crm/webhooks/whatsapp.
app.use(`${V1}/integrations/webhook`, integrationsPublicRoutes);

// Public Google OAuth callback — Google redirects without an auth
// header so this MUST be mounted before the requireAuth gate. The
// state JWT carries the user id, so we still verify identity.
app.get(`${V1}/integrations/google/callback`, async (req, res, next) => {
  try {
    const { default: jwt } = await import('jsonwebtoken');
    const { completeOAuth, isConfigured } = await import('./services/integrations/googleCalendar.service');
    const dashUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
    // Bounce back to the Activities calendar view (where the banner
    // lives) instead of the old standalone settings page.
    const back = `${dashUrl}/dashboard/crm/activities?layout=calendar`;
    if (!isConfigured()) {
      return res.redirect(`${back}&error=not_configured`);
    }
    const code  = String(req.query.code || '');
    const state = String(req.query.state || '');
    const err   = String(req.query.error || '');
    if (err) return res.redirect(`${back}&error=${encodeURIComponent(err)}`);
    if (!code || !state) return res.redirect(`${back}&error=missing_params`);
    const secret = process.env.GOOGLE_OAUTH_STATE_SECRET || process.env.SUPABASE_JWT_SECRET || 'dev-only-secret-replace-me';
    let payload: { uid: string; oid: string; kind: string };
    try {
      payload = jwt.verify(state, secret) as { uid: string; oid: string; kind: string };
    } catch {
      return res.redirect(`${back}&error=invalid_state`);
    }
    if (payload.kind !== 'google_oauth' || !payload.uid || !payload.oid) {
      return res.redirect(`${back}&error=invalid_state`);
    }
    const { email } = await completeOAuth(payload.uid, payload.oid, code);
    return res.redirect(`${back}&connected=${encodeURIComponent(email)}`);
  } catch (e) { next(e); }
});

// ── Public Tally bridge-agent endpoints (NO auth) ────────────────────
// The Windows bridge agent running on the distributor's PC polls these
// to fetch pending Tally jobs and report back results. Per-integration
// agent_secret in `?key=` verifies identity (constant-time compared in
// the controller). Mounted BEFORE the auth catch-all so the agent never
// needs a JWT.
app.use(`${V1}/integrations/tally`, tallyAgentPublicRoutes);

// ── Internal cron endpoints (NO user JWT) ───────────────────────
// Invoked by pg_cron via a Supabase Edge Function. Each endpoint in
// this router enforces its own shared-secret bearer check (see
// requireEdgeSecret in cron.routes.ts) so unauthenticated callers get
// a 401 immediately. Mounted BEFORE the auth catch-all so requests
// don't get short-circuited by requireAuth (which would 401 on a
// missing Supabase JWT).
app.use(`${V1}/cron`, cronRoutes);

// ── Demo intercept for non-CRM modules ──────────────────────────
// Mounted before the protected route handlers so demo-org requests get
// canned fixtures from demoExtensionsMiddleware instead of hitting empty
// database queries. /auth/* is excluded (those routes can't require auth —
// they're what *issues* tokens). CRM has its own demoCrmMiddleware on the
// CRM router; this middleware skips /crm/* paths internally so requests
// fall through to it.
//
// Performance note: requireAuth's profile cache makes the second invocation
// (from the per-route mounts below) a single map lookup, so the overhead
// here is negligible on the hot path.
app.use(V1, (req, res, next) => {
  const p = req.path;
  if (p === '/auth' || p.startsWith('/auth/')) return next();
  return requireAuth(req as any, res, next);
}, demoExtensionsMiddleware);

// Public/Auth routes (loginLimiter already applied at /auth/login above)
app.use(`${V1}/auth`,          perRouteLimit({ windowMs: 60_000, max: 30 }), authRoutes);

// Protected routes with RBAC
app.use(`${V1}/attendance`,    requireAuth, enforceCityScope, attendanceRoutes);
app.use(`${V1}/forms`,         requireAuth, enforceCityScope, formsRoutes);
app.use(`${V1}/builder`,       requireAuth, builderRoutes);
app.use(`${V1}/stock`,         requireAuth, requireModule('inventory'), stockRoutes);
app.use(`${V1}/broadcast`,     requireAuth, broadcastRoutes);
app.use(`${V1}/sos`,           requireAuth, sosRoutes);
app.use(`${V1}/leaderboard`,   requireAuth, leaderboardRoutes);
app.use(`${V1}/notifications`, requireAuth, notifRoutes);
app.use(`${V1}/learning`,      requireAuth, learningRoutes);
app.use(`${V1}/grievances`,    requireAuth, requireModule('reports'), grievanceRoutes);
app.use(`${V1}/analytics`,     requireAuth, enforceCityScope, analyticsRoutes);
app.use(`${V1}/visits`,        requireAuth, enforceCityScope, visitlogRoutes);
app.use(`${V1}/upload`,        requireAuth, uploadRoutes);
app.use(`${V1}/warehouses`,    requireAuth, requireModule('inventory'), wmsRoutes);
app.use(`${V1}/users`,         requireAuth, requireModule('users'), usersRoutes);
app.use(`${V1}/zones`,         requireAuth, enforceCityScope, zonesRoutes);
app.use('/api/v1/candidates',  requireAuth, candidatesRouter);
app.use(`${V1}/roles`,         requireAuth, rolesRoutes);
app.use('/api/v1/ai',          requireAuth, aiRouter);
app.use(`${V1}/activity-mappings`, requireAuth, activityMappingRoutes);
app.use(`${V1}/clients`,           requireAuth, clientRoutes);
app.use(`${V1}/misc`,              requireAuth, miscRoutes);
app.use(`${V1}/planograms`,        planogramRoutes);

// Route plan (singular and plural alias)
app.use(`${V1}/route-plan`,    requireAuth, enforceCityScope, routePlanRoutes);
app.use(`${V1}/route-plans`,   requireAuth, enforceCityScope, routePlanRoutes);

// Other management mounts
app.use(`${V1}/activities`,    requireAuth, activitiesRoutes);
app.use(`${V1}/assets`,        requireAuth, requireModule('inventory'), assetsRoutes);
app.use(`${V1}/cities`,        requireAuth, citiesRoutes);
app.use(`${V1}/management`,    requireAuth, managementRoutes);
app.use(`${V1}/skus`,          requireAuth, requireModule('inventory'), skusRoutes);
app.use(`${V1}/stores`,        requireAuth, enforceCityScope, storesRoutes);
app.use(`${V1}/warehouse`,     requireAuth, requireModule('inventory'), warehouseRoutes);

// ── Org-level admin settings (location-ping cadence today; more to come) ──
app.use(`${V1}/org-settings`,  requireAuth, orgSettingsRoutes);

// ── Distribution module ────────────────────────────────
app.use(`${V1}/distribution/brands`,         requireAuth, requireModule('distribution_brands'),       distBrandsRoutes);
app.use(`${V1}/distribution/distributors`,   requireAuth, requireModule('distribution_distributors'), distDistributorsRoutes);
app.use(`${V1}/distribution/price-lists`,    requireAuth, requireModule('distribution_pricing'),      distPriceListsRoutes);
app.use(`${V1}/distribution/orders`,         requireAuth, requireModule('distribution_orders'),       distOrdersRoutes);
app.use(`${V1}/distribution/invoices`,       requireAuth, requireModule('distribution_invoicing'),    distInvoicesRoutes);
app.use(`${V1}/distribution/dispatches`,     requireAuth, requireModule('distribution_invoicing'),    distDispatchesRoutes);
app.use(`${V1}/distribution/deliveries`,     requireAuth,                                              distDeliveriesRoutes);
app.use(`${V1}/distribution/payments`,       requireAuth, requireModule('distribution_payments'),     distPaymentsRoutes);
app.use(`${V1}/distribution/ledger`,         requireAuth, requireModule('distribution_ledger'),       distLedgerRoutes);
app.use(`${V1}/distribution/schemes`,        requireAuth, requireModule('distribution_schemes'),      distSchemesRoutes);
app.use(`${V1}/distribution/returns`,        requireAuth, requireModule('distribution_returns'),      distReturnsRoutes);
app.use(`${V1}/distribution/secondary-sales`,requireAuth, requireModule('distribution_consumer'),     distSecondaryRoutes);
// External-facing / abuse-prone endpoints get tighter per-route limits.
app.use(`${V1}/distribution/gstin`,          requireAuth, perRouteLimit({ windowMs: 60_000, max: 30 }),  distGstinRoutes);
app.use(`${V1}/organisations`,               requireAuth,                                                organisationsRoutes);
app.use(`${V1}/distribution/uploads`,        requireAuth, perRouteLimit({ windowMs: 60_000, max: 60 }),  distUploadsRoutes);
app.use(`${V1}/salesman`,                    requireAuth, enforceCityScope, perRouteLimit({ windowMs: 60_000, max: 120 }), distSalesmanRoutes);

// Distribution → accounting integrations (Tally + future). Authenticated
// admin CRUD only; the bridge agent uses the public /integrations/tally
// routes mounted above.
app.use(`${V1}/distribution/integrations`,   requireAuth,                                             distIntegrationsRoutes);

// ── CRM lead NBA + Updates timeline (mounted BEFORE the main CRM router) ───
// Express short-circuits at the first mount whose path prefix matches AND
// whose router responds. Non-matching /leads/* and /ai/* paths fall
// through to crmRoutes below, so the existing routes are untouched.
app.use(`${V1}/crm/ai/next-best-action/lead`, requireAuth, leadNbaRoutes);
app.use(`${V1}/crm/leads`,                    requireAuth, leadUpdatesRoutes);

// ── CRM module ──────────────────────────────────────
app.use(`${V1}/crm`, requireAuth, crmRoutes);

// ── KINI agentic v2 (flag-gated; legacy /crm/ai/chat untouched) ─────────────
// Per-tenant rollout is controlled by org_settings(key='kini_agentic_v2'),
// enforced inside each handler via gate(). Disabled tenants get a clean
// 403 KINI_V2_DISABLED and clients fall back to the legacy v1 chat path.
app.use(`${V1}/kini`, requireAuth, kiniRoutes);

// ── Lead-source integrations (admin CRUD) ──────────────────────────
// Public webhook ingestion lives above the auth catch-all; this is the
// authenticated admin surface for connect/list/edit/disconnect/events.
app.use(`${V1}/integrations`, requireAuth, integrationsRoutes);

// ── Messaging — DMs, team chat, @mentions, web-push subscriptions ─────────
// Scope enforcement (city ∩ hierarchy subtree) lives in the service layer.
app.use(`${V1}/messaging`, requireAuth, messagingRoutes);

// ── Activity Log (super-admin only) ────────────────────────────
app.use(`${V1}/audit-log`, requireAuth, auditLogRoutes);

// ── 404 + error handlers ──────────────────────────────────
app.use(notFoundHandler);
app.use(sanitiseError);                                         // no stacks/PII to client; log full detail server-side

// ── Background workers ───────────────────────────────────
if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_TALLY_POLLER !== 'true') {
  startTallyEnqueuePoller();
}

export default app;
