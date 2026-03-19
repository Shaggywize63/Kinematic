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
import wmsRoutes          from './routes/wms.routes';
import usersRoutes        from './routes/users.routes';
import zonesRoutes        from './routes/zones.routes';
import routePlanRoutes    from './routes/route-plan.routes';
import candidatesRouter from './routes/candidates.routes';

// Other management routes (available, now mounted)
import activitiesRoutes   from './routes/activities.routes';
import assetsRoutes       from './routes/assets.routes';
import citiesRoutes       from './routes/cities.routes';
import managementRoutes   from './routes/management.routes';
import skusRoutes         from './routes/skus.routes';
import storesRoutes       from './routes/stores.routes';
import warehouseRoutes    from './routes/warehouse.routes';

const app = express();

// ── Security ─────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow Postman / server-to-server (no origin)
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 login attempts per window
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});

app.use('/api', limiter);
app.use('/api/v1/auth/login', authLimiter);

// ── HTTP logging ──────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// ── Body parsing & misc ───────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

app.use(`${V1}/auth`,         authRoutes);
app.use(`${V1}/attendance`,   attendanceRoutes);
app.use(`${V1}/forms`,        formsRoutes);
app.use(`${V1}/stock`,        stockRoutes);
app.use(`${V1}/broadcast`,    broadcastRoutes);
app.use(`${V1}/sos`,          sosRoutes);
app.use(`${V1}/leaderboard`,  leaderboardRoutes);
app.use(`${V1}/notifications`, notifRoutes);
app.use(`${V1}/learning`,     learningRoutes);
app.use(`${V1}/grievances`,   grievanceRoutes);
app.use(`${V1}/analytics`,    analyticsRoutes);
app.use(`${V1}/visits`,       visitlogRoutes);
app.use(`${V1}/upload`,       uploadRoutes);
app.use(`${V1}/warehouses`,   wmsRoutes);
app.use(`${V1}/users`,        usersRoutes);
app.use(`${V1}/zones`,        zonesRoutes);
app.use('/api/v1/candidates', candidatesRouter);
app.use('/api/v1/ai', aiRouter);


// Route plan (singular and plural alias)
app.use(`${V1}/route-plan`,   routePlanRoutes);
app.use(`${V1}/route-plans`,  routePlanRoutes);

// Other management mounts
app.use(`${V1}/activities`,   activitiesRoutes);
app.use(`${V1}/assets`,       assetsRoutes);
app.use(`${V1}/cities`,       citiesRoutes);
app.use(`${V1}/management`,   managementRoutes);
app.use(`${V1}/skus`,         skusRoutes);
app.use(`${V1}/stores`,       storesRoutes);
app.use(`${V1}/warehouse`,    warehouseRoutes);

// ── 404 + error handlers ──────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
