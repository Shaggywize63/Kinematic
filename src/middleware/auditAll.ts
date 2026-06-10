/**
 * Global audit middleware. Every state-change (POST/PATCH/PUT/DELETE) gets a
 * row in audit_log — both successes (2xx/3xx) and failures (4xx/5xx). For
 * failures we capture the error message so the activity log shows what went
 * wrong instead of just an opaque HTTP status code.
 *
 * Best-effort — never blocks or fails the request.
 *
 * Read traffic (GET/HEAD/OPTIONS) is skipped on purpose; logging it would 10×
 * the table size with no forensic value.
 */
import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { logger } from '../lib/logger';

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Keys that should NEVER land in audit_log.after — these are
// credential-grade or otherwise sensitive. Matching is case-insensitive
// and works on any nesting depth via scrubBody().
const SENSITIVE_KEYS = new Set([
  'password', 'new_password', 'current_password', 'old_password',
  'token', 'access_token', 'refresh_token', 'id_token',
  'secret', 'app_secret', 'webhook_secret', 'agent_secret', 'client_secret',
  'api_key', 'apikey',
  'mfa_secret', 'totp_secret', 'otp', 'pin',
  'oauth_credentials', 'oauth_credentials_encrypted', 'credentials',
  'authorization',
]);

/**
 * Recursively replace sensitive values with '[REDACTED]'. Operates on
 * a structural clone so we don't mutate the live req.body. Arrays and
 * nested objects walk through; primitives are returned unchanged.
 */
function scrubBody(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 8) return '[depth-limit]'; // defence against pathological nesting
  if (Array.isArray(value)) return value.map((v) => scrubBody(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : scrubBody(v, depth + 1);
  }
  return out;
}

/**
 * Map a request to a coarse {action, entity_table} based on the URL.
 * Examples:
 *   POST   /api/v1/crm/leads         → leads.create
 *   PATCH  /api/v1/crm/leads/123     → leads.update
 *   DELETE /api/v1/distribution/orders/456 → orders.delete
 */
function describeRequest(method: string, originalUrl: string): { action: string; entity_table: string; entity_id: string | null } {
  const url = originalUrl.split('?')[0];
  const parts = url.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);
  const verb = method.toLowerCase() === 'patch' || method.toLowerCase() === 'put' ? 'update'
             : method.toLowerCase() === 'post' ? 'create'
             : method.toLowerCase() === 'delete' ? 'delete'
             : method.toLowerCase();

  if (parts.length === 0) return { action: verb, entity_table: 'unknown', entity_id: null };

  // First path segment is the resource group (crm, distribution, attendance, etc.).
  // Use the deepest non-id segment as the entity, and the last UUID-shaped
  // segment as the entity_id.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let entity = parts[parts.length - 1];
  let entityId: string | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (uuidRe.test(parts[i])) {
      entityId = parts[i];
      // The entity name is the segment immediately before the id.
      if (i > 0) entity = parts[i - 1];
      break;
    }
  }
  if (uuidRe.test(entity) && parts.length >= 2) entity = parts[parts.length - 2];

  // Sub-action: /:id/win, /:id/cancel, /:id/move-stage etc. — capture the verb.
  const tail = parts[parts.length - 1];
  if (tail && !uuidRe.test(tail) && entityId && tail !== entity) {
    return { action: `${entity}.${tail}`, entity_table: entity, entity_id: entityId };
  }

  return { action: `${entity}.${verb}`, entity_table: entity, entity_id: entityId };
}

// Body fields used to build a human-readable summary for the activity log:
// "leads.create — Acme Corp" beats a bare "leads.create".
const SUMMARY_KEYS = [
  'name', 'full_name', 'title', 'subject', 'label',
  'company', 'email', 'phone',
];

function extractSummary(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;
  for (const k of SUMMARY_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      return s.length > 80 ? s.slice(0, 77) + '…' : s;
    }
  }
  return null;
}

// Map a known mobile/web platform header to a stable lowercase token.
function detectPlatform(req: AuthRequest): 'web' | 'android' | 'ios' | 'api' {
  const p = ((req.headers['x-kinematic-platform'] as string) || '').trim().toLowerCase();
  if (p === 'android' || p === 'ios' || p === 'web') return p;
  const ua = ((req.headers['user-agent'] as string) || '').toLowerCase();
  if (/android/.test(ua)) return 'android';
  if (/(iphone|ipad|ios)/.test(ua)) return 'ios';
  if (/mozilla|chrome|safari|firefox|edge/.test(ua)) return 'web';
  return 'api';
}

// Intercept the response body so we can pull the error message out of failed
// requests. We wrap res.json + res.send and stash the last payload they saw.
// This is best-effort — controllers that stream raw or use res.end() with a
// buffer won't be captured, but every error response in this codebase goes
// through asyncHandler → res.json(...).
function captureResponseBody(res: Response): { peek: () => unknown } {
  let captured: unknown = null;
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  res.json = ((body: unknown) => { captured = body; return origJson(body); }) as typeof res.json;
  res.send = ((body: unknown) => {
    if (captured === null) {
      if (typeof body === 'string') {
        try { captured = JSON.parse(body); } catch { captured = body; }
      } else captured = body;
    }
    return origSend(body as never);
  }) as typeof res.send;
  return { peek: () => captured };
}

function pickErrorMessage(body: unknown, status: number): string | null {
  if (status < 400) return null;
  if (!body) return `HTTP ${status}`;
  if (typeof body === 'string') return body.length > 240 ? body.slice(0, 237) + '…' : body;
  if (typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const msg = obj.message || obj.error || (obj.error as Record<string, unknown> | undefined)?.message;
    if (typeof msg === 'string' && msg.trim()) {
      return msg.length > 240 ? msg.slice(0, 237) + '…' : msg;
    }
  }
  return `HTTP ${status}`;
}

export function auditAll(req: AuthRequest, res: Response, next: NextFunction): void {
  if (SKIP_METHODS.has(req.method)) return next();

  // Capture body shape upfront — by the time res.on('finish') fires, downstream
  // code may have mutated req.body. Cap it to keep the row small.
  // Sensitive keys (password, *token*, secrets, MFA, OAuth blobs) are
  // replaced with '[REDACTED]' so the audit row never persists raw
  // credentials. Org admins routinely read audit_log; without this
  // any password reset / OAuth refresh would land in plaintext.
  let bodySnapshot: unknown = null;
  let summary: string | null = null;
  try {
    if (req.body && typeof req.body === 'object') {
      const json = JSON.stringify(req.body);
      const parsed = json.length > 8000 ? '[truncated]' : JSON.parse(json);
      bodySnapshot = typeof parsed === 'string' ? parsed : scrubBody(parsed);
      summary = extractSummary(req.body);
    }
  } catch { /* unparseable; skip */ }

  const responseCapture = captureResponseBody(res);

  res.on('finish', () => {
    if (!req.user) return;
    // Skip purely-informational 1xx/3xx ranges so the table only carries
    // outcomes worth showing (success + failures).
    if (res.statusCode < 200 || (res.statusCode >= 300 && res.statusCode < 400)) return;

    const { action, entity_table, entity_id } = describeRequest(req.method, req.originalUrl);
    const clientHeader = (req.headers['x-client-id'] as string | undefined)?.trim();
    const clientId = req.user.client_id
      || (clientHeader && /^[0-9a-f-]{36}$/i.test(clientHeader) ? clientHeader : null);

    const platform     = detectPlatform(req);
    const deviceModel  = (req.headers['x-device-model']  as string | undefined)?.trim() || null;
    const deviceBrand  = (req.headers['x-device-brand']  as string | undefined)?.trim() || null;
    const osVersion    = (req.headers['x-os-version']    as string | undefined)?.trim() || null;
    const errorMessage = pickErrorMessage(responseCapture.peek(), res.statusCode);

    void supabaseAdmin
      .from('audit_log')
      .insert({
        org_id:         req.user.org_id,
        client_id:      clientId,
        actor_user_id:  req.user.id,
        actor_role:     req.user.role,
        action,
        entity_table,
        entity_id,
        before:         null,
        after:          bodySnapshot,
        metadata: {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          platform,
          device_model: deviceModel,
          device_brand: deviceBrand,
          os_version: osVersion,
          summary,
          error: errorMessage,
        },
        ip_address:     (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
        user_agent:     (req.headers['user-agent'] as string) || null,
      })
      .then(({ error }) => {
        if (error) logger.warn(`[auditAll] insert failed: ${error.message}`);
      });
  });

  next();
}
