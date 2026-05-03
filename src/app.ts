import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import aiRouter from './routes/ai.routes';

import { logger } from './lib/logger';
import { notFoundHandler } from './middleware/errorHandler';
import { requireAuth } from './middleware/auth';
import {
  corsOrigin, helmetConfig, requestId, sanitiseError,
  prototypePoll, strictJson, perRouteLimit, loginLimiter,
} from './middleware/security';

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
import routePlanRoutes    from './routes/route-plan.routes';
import candidatesRouter   from './routes/candidates.routes';
import activityMappingRoutes from './routes/activity-mapping.routes';
import clientRoutes          from './routes/client.routes';
import miscRoutes            from './routes/misc.routes';
import planogramRoutes       from './routes/planogram.routes';

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

const app = express();

// ── Request correlation (per-request UUID, echoed in X-Request-Id) ──
app.use(requestId);

// ── Security headers (strict CSP + HSTS preload + Permissions-Policy) ──
app.use(helmet(helmetConfig));
app.set('trust proxy', 1);

// ── CORS allowlist (env-driven, no more open `cb(null,true)`) ──
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

// ── HTTP logging ─────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// ── Body parsing & misc ───────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '2mb', strict: true }));         // tighter cap (was 10mb); strict rejects scalars
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(strictJson);                                            // mutating routes must send JSON
app.use(prototypePoll);                                         // block __proto__ / constructor injection

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'kinematic-api',
    version: '1.0.1-perf-V6',
    timestamp: new Date().toISOString(),
  });
});

// ── API routes ────────────────────────────────────────────────────
const V1 = '/api/v1';

import { requireModule, enforceCityScope } from './middleware/rbac';

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

// ── Distribution module ─────────────────────────────────────────────
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

// ── 404 + error handlers ─────────────────────────────────────────────
app.use(notFoundHandler);
app.use(sanitiseError);                                         // no stacks/PII to client; log full detail server-side

export default app;
