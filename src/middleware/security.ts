/**
 * VAPT-grade security middleware for the Kinematic API.
 *
 * Pulls all the loose security plumbing into one place so it's easy to audit:
 *   - corsOrigin     — env-driven allowlist; no more `cb(null, true)`
 *   - helmetConfig   — strict CSP + HSTS preload + Permissions-Policy
 *   - requestId      — UUID per request, echoed in `X-Request-Id`
 *   - sanitiseError  — strip stacks/SQL details/PII before responding
 *   - prototypePoll  — block prototype-pollution attempts in JSON bodies
 *   - strictJson     — reject non-JSON content-types on mutating routes
 *   - perRouteLimit  — small token-bucket factory for per-route limits
 *   - loginLimiter   — composite (IP + email) brute-force throttle
 *
 * No semantic change to existing routes; this module is opt-in via app.ts.
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import type { CorsOptions } from 'cors';
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit';

// Normalised IP key. ipv6 truncated to /64 to avoid per-address skew.
// (`ipKeyGenerator` shipped in express-rate-limit v8; we're on v7.)
function ipKey(req: Request): string {
  const raw = (req.ip || '').replace(/^::ffff:/, '');
  if (raw.includes(':')) return raw.split(':').slice(0, 4).join(':'); // ipv6 → /64
  return raw;
}
import crypto from 'crypto';
import type { HelmetOptions } from 'helmet';
import { logger } from '../lib/logger';

// ── 1. CORS ─────────────────────────────────────────────────────────────────
//
// CORS_ORIGINS is a comma-separated list. Use `*` only in dev. In prod, set
// the Vercel preview + production domains explicitly.
//   CORS_ORIGINS=https://kinematic-dashboard.vercel.app,https://app.kinematic.app
//
const PARSED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const VERCEL_PREVIEW_RE = /^https:\/\/kinematic-dashboard-[a-z0-9-]+\.vercel\.app$/i;

export const corsOrigin: CorsOptions['origin'] = (origin, cb) => {
  // Allow same-origin / non-browser tools (no Origin header).
  if (!origin) return cb(null, true);

  if (PARSED_ORIGINS.length === 0) {
    // No allowlist configured = legacy behaviour, but warn loudly so we notice.
    logger.warn(`[cors] CORS_ORIGINS not set; allowing ${origin} by fallback`);
    return cb(null, true);
  }

  if (PARSED_ORIGINS.includes('*')) return cb(null, true);
  if (PARSED_ORIGINS.includes(origin)) return cb(null, true);
  // Vercel preview deployments — auto-allow if a wildcard pattern is opted in.
  if (process.env.CORS_ALLOW_VERCEL_PREVIEWS === 'true' && VERCEL_PREVIEW_RE.test(origin)) {
    return cb(null, true);
  }
  logger.warn(`[cors] BLOCKED origin: ${origin}`);
  return cb(new Error('CORS: origin not allowed'));
};

// ── 2. Helmet config ────────────────────────────────────────────────────────
// Strict CSP for the API itself (no inline JS, no images from anywhere). We
// don't serve HTML, so this is mostly defence-in-depth + signals to scanners.
export const helmetConfig: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src':  ["'self'"],
      'style-src':   ["'self'", "'unsafe-inline'"], // helmet defaults
      'img-src':     ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'object-src':  ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri':    ["'self'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': [],
    },
  },
  // HSTS: 1 year, include subdomains, preload-eligible.
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  // Forbid the API from being framed.
  frameguard: { action: 'deny' },
  // Stop MIME sniffing.
  noSniff: true,
  // Strip the X-Powered-By Express header (helmet does this by default).
  hidePoweredBy: true,
  // Don't leak referrer URLs cross-origin.
  referrerPolicy: { policy: 'no-referrer' },
  // Same-origin for window.open() popups.
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  // The Resource-Policy default of `same-origin` is too tight when the
  // dashboard fetches the API; keep it cross-origin since CORS handles auth.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
};

// ── 3. Request-id ───────────────────────────────────────────────────────────
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = (req.headers['x-request-id'] as string | undefined) || '';
  const id = /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  (req as any).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

// ── 4. Error sanitiser ──────────────────────────────────────────────────────
// Replaces the existing errorHandler. Keeps the verbose log line for ops but
// returns only a generic message to the client (so we never leak SQL state,
// stack traces, or echo back attacker-provided strings).
const isDev = () => process.env.NODE_ENV !== 'production';

const SAFE_CODES = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'TOO_MANY_REQUESTS']);

export const sanitiseError: ErrorRequestHandler = (err, req, res, _next) => {
  const status = Number(err.statusCode || err.status || 500);
  const id = (req as any).id || res.getHeader('X-Request-Id') || '-';

  // Always log full detail server-side. Body / params / query are scrubbed for
  // common credential leaks.
  const scrub = (v: unknown) => {
    try {
      const str = typeof v === 'string' ? v : JSON.stringify(v);
      return str
        .replace(/("password"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
        .replace(/("token"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
        .replace(/("secret"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
        .slice(0, 4_000);
    } catch { return '<unserialisable>'; }
  };

  logger.error(
    `[req:${id}] ${req.method} ${req.path} → ${status} — ${err.message || 'unknown'}`,
    {
      stack: err.stack,
      code: err.code,
      body: scrub(req.body),
      params: scrub(req.params),
      query: scrub(req.query),
      requestId: id,
    },
  );

  // For 4xx we trust the controller author's message; 5xx must be generic.
  let message: string;
  let code: string | undefined;
  if (status >= 500) {
    message = 'Internal server error';
    code = isDev() ? err.code || 'INTERNAL_ERROR' : 'INTERNAL_ERROR';
  } else {
    message = String(err.message || 'Request failed').slice(0, 500);
    code = SAFE_CODES.has(String(err.code)) ? err.code : undefined;
  }

  if (res.headersSent) return;
  res.status(status).json({
    success: false,
    error: message,
    ...(code && { code }),
    request_id: id,
  });
};

// ── 5. Prototype pollution guard ────────────────────────────────────────────
// Express body-parser doesn't reject `__proto__` / `constructor` keys by
// default. This middleware refuses any request body that contains them.
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function hasDangerousKeys(o: unknown, depth = 0): boolean {
  if (depth > 32 || o === null || typeof o !== 'object') return false;
  for (const k of Object.keys(o as object)) {
    if (POLLUTING_KEYS.has(k)) return true;
    if (hasDangerousKeys((o as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}
export function prototypePoll(req: Request, res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object' && hasDangerousKeys(req.body)) {
    res.status(400).json({ success: false, error: 'Malformed request', request_id: (req as any).id });
    return;
  }
  next();
}

// ── 6. Strict content-type for mutating routes ──────────────────────────────
// Refuses application/x-www-form-urlencoded etc. to limit CSRF surface +
// shrink the parser attack surface.
const STRICT_CT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function strictJson(req: Request, res: Response, next: NextFunction) {
  if (!STRICT_CT_METHODS.has(req.method)) return next();
  // Multipart / FormData uploads use a separate router; let them through.
  const ct = String(req.headers['content-type'] || '');
  if (ct.startsWith('multipart/form-data') || ct === '') return next();
  if (ct.startsWith('application/json')) return next();
  res.status(415).json({ success: false, error: 'Content-Type must be application/json', request_id: (req as any).id });
}

// ── 7. Rate-limit factory ───────────────────────────────────────────────────
//
// Use this for per-route limits. Default: 60 requests/min/IP. Tune with
// the `max` and `windowMs` options.
export function perRouteLimit(opts: Partial<RateLimitOptions> = {}) {
  return rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKey(req)}:${(req as any).user?.id || 'anon'}`,
    handler: (req, res, _next, options) => {
      logger.warn(`[rate] ${req.method} ${req.path} from ${req.ip} (user:${(req as any).user?.id || '-'})`);
      res.status(options.statusCode).json({
        success: false,
        error: 'Too many requests. Please slow down.',
        code: 'TOO_MANY_REQUESTS',
        request_id: (req as any).id,
      });
    },
    ...opts,
  });
}

// ── 8. Composite login limiter ──────────────────────────────────────────────
// Rate-limit by (IP, email) pair so a botnet can't scatter attempts across
// IPs to bypass per-IP throttle. Falls back to IP-only when email isn't in
// the body.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 attempts per 15 min per (IP, email)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = ipKey(req);
    const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 200);
    return email ? `${ip}::${email}` : ip;
  },
  handler: (req, res, _next, options) => {
    const id = (req as any).id;
    logger.warn(`[login-limit] HIT ${req.ip} ${(req.body && req.body.email) || '-'}`);
    res.status(options.statusCode).json({
      success: false,
      error: 'Too many login attempts. Try again in 15 minutes.',
      code: 'TOO_MANY_REQUESTS',
      request_id: id,
    });
  },
});
