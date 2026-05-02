import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import aiRouter from './routes/ai.routes';

import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requireAuth } from './middleware/auth';

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

const app = express();

// ── Security ──────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);

// ── CORS ─────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-org-id', 'x-client-id', 'X-Org-Id', 'X-Client-Id'],
}));

// ── Rate limiting ─────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '5000', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, Path: ${req.path}`);
    res.status(options.statusCode).send(options.message);
  },
  message: { success: false, error: 'Too many requests. Please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});

app.use('/api', limiter);
app.use('/api/v1/auth/login', authLimiter);

// ── HTTP logging ─────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// ── Body parsing & misc ───────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// Public/Auth routes
app.use(`${V1}/auth`,          authRoutes);

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
app.use(`${V1}/distribution/uploads`,        requireAuth,                                              distUploadsRoutes);
app.use(`${V1}/salesman`,                    requireAuth, enforceCityScope,                            distSalesmanRoutes);

// ── 404 + error handlers ─────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
