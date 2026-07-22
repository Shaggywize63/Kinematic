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
 *   - validatePassword — password policy ({ ok, reason }) used by user create/update
 *
 * No semantic change to existing routes; this module is opt-in via app.ts.
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import type { CorsOptions } from 'cors';
import { ZodError } from 'zod';
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
// Allowlist is a UNION of three sources:
//
//   1. KNOWN_ORIGINS — baked-in canonical surfaces (production dashboard,
//      Vercel previews, localhost dev). These work out of the box; no env
//      config required. This is what makes the dashboard "just work" after
//      a fresh deploy.
//
//   2. KNOWN_PATTERNS — regex patterns (Vercel preview URLs are dynamic).
//
//   3. CORS_ORIGINS env var — comma-separated extras for custom domains
//      (e.g. https://app.kinematic.app). Set `*` to unlock everything in
//      dev/staging.
//
const KNOWN_ORIGINS = new Set<string>([
  // Production dashboard surfaces
  'https://dashboard.kinematicapp.com',
  'https://app.kinematicapp.com',
  'https://kinematic-dashboard.vercel.app',
  'https://kinematic-dashboard.kaiyo.app',
  'https://app.kinematic.app',
  'https://app.kaiyolabs.com',
  // Vercel production/branch aliases for the dashboard project (verified
  // against the project's real domain list).
  'https://kinematic-dashboard-shaggywize63s-projects.vercel.app',
  'https://kinematic-dashboard-git-main-shaggywize63s-projects.vercel.app',
  // Local dev
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]);

// SECURITY_AUDIT_2026-07.md C1: the previous patterns allowed (a) ANY
// `kinematic-dashboard-*.vercel.app` — which any Vercel user could create — and
// (b) EVERY subdomain of four apex domains, so a single subdomain takeover /
// dangling DNS granted credentialed cross-origin access. Replaced with a single
// preview pattern pinned to our Vercel team suffix. Specific production hosts
// live in KNOWN_ORIGINS above; add new ones there (or via CORS_ORIGINS), not as
// a wildcard.
const KNOWN_PATTERNS: RegExp[] = [
  /^https:\/\/kinematic-dashboard-[a-z0-9-]+-shaggywize63s-projects\.vercel\.app$/i,
];

const PARSED_EXTRA = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const corsOrigin: CorsOptions['origin'] = (origin, cb) => {
  // Allow same-origin / non-browser tools (no Origin header).
  if (!origin) return cb(null, true);

  // 1. Baked-in canonical surfaces.
  if (KNOWN_ORIGINS.has(origin)) return cb(null, true);

  // 2. Pattern matches (Vercel previews, branded subdomains).
  if (KNOWN_PATTERNS.some((re) => re.test(origin))) return cb(null, true);

  // 3. Env-driven extras for custom domains.
  if (PARSED_EXTRA.includes('*')) return cb(null, true);
  if (PARSED_EXTRA.includes(origin)) return cb(null, true);

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
  // Zod validation failures must surface as 400, not 500. Without this, every
  // malformed-body request looks like a server crash to the client (e.g. iOS
  // captures hitting /api/v1/planograms/captures with an empty image_url).
  if (err instanceof ZodError) {
    const id = (req as any).id || res.getHeader('X-Request-Id') || '-';
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        error: 'Invalid request body',
        code: 'BAD_REQUEST',
        details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        request_id: id,
      });
    }
    return;
  }

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
  // OAuth 2.0 token / authorize / revoke endpoints use
  // application/x-www-form-urlencoded per RFC 6749 / 7009 (the login-consent
  // form and the connectors POST form-encoded). Allow it on the public /oauth
  // paths only — they have their own urlencoded parser + strict validation.
  if (ct.startsWith('application/x-www-form-urlencoded') && req.path.startsWith('/oauth')) return next();
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

// ── 9. Password policy ──────────────────────────────────────────────────────
// Lightweight VAPT-grade password validator used by user create / update /
// reset flows. Returns `{ ok, reason }` so the controller can surface the
// specific rule the user violated. Was previously referenced via
// `require('../middleware/security').validatePassword(...)` but the function
// itself was missing — that turned every user-with-password create/edit into
// a 500 (TypeError: validatePassword is not a function).
//
// Policy (matches the comment block in misc.controller.ts):
//   • length ≥ 10
//   • not in the common-password denylist below
//   • no 4+ repeated characters in a row (e.g. "aaaa")
//   • no 6+ char keyboard / numeric sequence (e.g. "123456", "abcdef")
//   • max 200 chars (DoS-budget on hashing)
const COMMON_PASSWORDS = new Set<string>([
  'password', 'password1', 'password12', 'password123', 'pass1234',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdfghjkl',
  'iloveyou', 'iloveyou1', 'admin', 'admin123', 'administrator',
  'welcome', 'welcome1', 'welcome123', 'letmein', 'letmein123',
  'monkey', 'dragon', 'sunshine', 'football', 'baseball', 'master',
  'princess', 'kinematic', 'kinematic123', 'changeme', 'changeme123',
  '1234567890', '0123456789', '1q2w3e4r5t', 'qazwsxedc',
]);

const SEQUENCES: string[] = [
  'abcdefghijklmnopqrstuvwxyz',
  'zyxwvutsrqponmlkjihgfedcba',
  '0123456789',
  '9876543210',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '1qaz2wsx3edc',
];

export function validatePassword(pw: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof pw !== 'string') return { ok: false, reason: 'Password must be a string.' };
  const p = pw;
  if (p.length < 10) return { ok: false, reason: 'Password must be at least 10 characters.' };
  if (p.length > 200) return { ok: false, reason: 'Password is too long (max 200 characters).' };

  const lower = p.toLowerCase();

  if (COMMON_PASSWORDS.has(lower)) {
    return { ok: false, reason: 'This password is too common. Pick something less guessable.' };
  }

  // Run of 4+ same chars: "aaaa", "1111", "!!!!"
  if (/(.)\1{3,}/.test(p)) {
    return { ok: false, reason: 'Password cannot contain 4 or more repeated characters in a row.' };
  }

  // Common keyboard / numeric sequences (6 chars or longer chunk)
  for (const seq of SEQUENCES) {
    for (let i = 0; i <= seq.length - 6; i++) {
      const slice = seq.slice(i, i + 6);
      if (lower.includes(slice)) {
        return { ok: false, reason: 'Password contains a common keyboard or numeric sequence (e.g. 123456, qwerty).' };
      }
    }
  }

  return { ok: true };
}
