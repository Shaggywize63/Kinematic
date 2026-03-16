import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

import authRoutes        from './routes/auth.routes';
import attendanceRoutes  from './routes/attendance.routes';
import managementRoutes  from './routes/management.routes';
import analyticsRoutes   from './routes/analytics.routes';
import broadcastRoutes   from './routes/broadcast.routes';
import candidatesRoutes  from './routes/candidates.routes';
import aiRoutes          from './routes/ai.routes';
import settingsRoutes    from './routes/settings.routes';
import builderRoutes     from './routes/builder.routes';
import wmsRoutes         from './routes/wms.routes';

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

// ── API Routes ────────────────────────────────────────────────
app.use('/api/v1/auth',        authRoutes);        // login, logout, me
app.use('/api/v1/attendance',  attendanceRoutes);  // team, history, summary, override
app.use('/api/v1/warehouses',  wmsRoutes);         // warehouse alias (frontend uses /warehouses)
app.use('/api/v1/cities',      managementRoutes); // cities CRUD
app.use('/api/v1/analytics',   analyticsRoutes);   // live-locations, summary, weekly-contacts
app.use('/api/v1/broadcast',   broadcastRoutes);   // broadcast questions & answers
app.use('/api/v1/candidates',  candidatesRoutes);  // HR hiring pipeline & documents
app.use('/api/v1/ai',          aiRoutes);          // Kinematic AI chat proxy
app.use('/api/v1/settings',    settingsRoutes);    // geofence, working hours, role access
app.use('/api/v1/builder',     builderRoutes);     // form builder — forms, pages, questions, submissions
app.use('/api/v1/wms',         wmsRoutes);         // warehouse management (original mount)

// ── 404 + error handlers ──────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
