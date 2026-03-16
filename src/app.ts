import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

import authRoutes       from './routes/auth.routes';
import attendanceRoutes from './routes/attendance.routes';
import managementRoutes from './routes/management.routes';
import analyticsRoutes  from './routes/analytics.routes';
import broadcastRoutes  from './routes/broadcast.routes';
import candidatesRoutes from './routes/candidates.routes';
import aiRoutes         from './routes/ai.routes';
import settingsRoutes   from './routes/setting.routes';
import builderRoutes    from './routes/builder.routes';
import wmsRoutes        from './routes/wms.routes';

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.set('trust proxy', 1);

app.use(cors({
  origin: (origin, cb) => { cb(null, true); },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '200', 10),
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', limiter);

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health'
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'kinematic-api', timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/v1/auth',       authRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/analytics',  analyticsRoutes);
app.use('/api/v1/broadcast',  broadcastRoutes);
app.use('/api/v1/candidates', candidatesRoutes);
app.use('/api/v1/ai',         aiRoutes);
app.use('/api/v1/settings',   settingsRoutes);
app.use('/api/v1/builder',    builderRoutes);
app.use('/api/v1/warehouses', wmsRoutes);
app.use('/api/v1/wms',        wmsRoutes);
app.use('/api/v1',            managementRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
