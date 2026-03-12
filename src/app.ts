import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import activitiesRouter from './routes/activities.routes';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requireAuth, requireRole } from './middleware/auth';
import * as misc from './controllers/misc.controller';
import * as attendanceCtrl from './controllers/attendance.controller';


// Routes
import authRoutes         from './routes/auth.routes';
import attendanceRoutes   from './routes/attendance.routes';
import formsRoutes        from './routes/forms.routes';
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
import citiesRouter       from './routes/cities.routes';
import storesRouter       from './routes/stores.routes';
import skusRouter         from './routes/skus.routes';
import assetsRouter       from './routes/assets.routes';
import routePlanRouter from './routes/route-plan.routes';
import warehouseRoutes from './routes/warehouse.routes';

const app = express();

// ── Security ──────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
  .split(',')
  .map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ─────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});

app.use('/api', limiter);
app.use('/api/v1/auth/login', authLimiter);

// ── Body parsing & misc ───────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── HTTP logging ──────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'kinematic-api',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── API routes ────────────────────────────────────────────────
const V1 = '/api/v1';

app.use(`${V1}/auth`,          authRoutes);
app.use(`${V1}/attendance`,    attendanceRoutes);
app.use(`${V1}/forms`,         formsRoutes);
app.use(`${V1}/stock`,         stockRoutes);
app.use(`${V1}/broadcast`,     broadcastRoutes);
app.use(`${V1}/sos`,           sosRoutes);
app.use(`${V1}/leaderboard`,   leaderboardRoutes);
app.use(`${V1}/notifications`, notifRoutes);
app.use(`${V1}/learning`,      learningRoutes);
app.use(`${V1}/grievances`,    grievanceRoutes);
app.use(`${V1}/analytics`,     analyticsRoutes);
app.use(`${V1}/visits`,        visitlogRoutes);
app.use(`${V1}/upload`,        uploadRoutes);
app.use(`${V1}/cities`,        citiesRouter);
app.use(`${V1}/stores`,        storesRouter);
app.use(`${V1}/skus`,          skusRouter);
app.use(`${V1}/assets`,        assetsRouter);
app.use(`${V1}/activities`, activitiesRouter);
app.use(`${V1}/route-plans`, routePlanRouter);
app.use('/api/v1/warehouse', warehouseRoutes);

app.get(`${V1}/users`,       requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), misc.getUsers);
app.post(`${V1}/users`,      requireAuth, requireRole('admin','city_manager','super_admin'), misc.createUser);
app.patch(`${V1}/users/:id`, requireAuth, requireRole('admin','city_manager','super_admin'), misc.updateUser);
app.get(`${V1}/zones`,       requireAuth, misc.getZones);
app.post(`${V1}/zones`,      requireAuth, requireRole('admin','super_admin'), misc.createZone);

// ── 404 + error handlers ──────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
