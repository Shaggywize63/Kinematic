/**
 * Global audit middleware. Every successful state-change (POST/PATCH/PUT/DELETE
 * with 2xx response) gets a row in audit_log. Best-effort — never blocks or
 * fails the request.
 *
 * Read traffic (GET/HEAD/OPTIONS) is skipped on purpose; logging it would 10×
 * the table size with no forensic value.
 */
import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { logger } from '../lib/logger';

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

export function auditAll(req: AuthRequest, res: Response, next: NextFunction): void {
  if (SKIP_METHODS.has(req.method)) return next();

  // Capture body shape upfront — by the time res.on('finish') fires, downstream
  // code may have mutated req.body. Cap it to keep the row small.
  let bodySnapshot: unknown = null;
  try {
    if (req.body && typeof req.body === 'object') {
      const json = JSON.stringify(req.body);
      bodySnapshot = json.length > 8000 ? '[truncated]' : JSON.parse(json);
    }
  } catch { /* unparseable; skip */ }

  res.on('finish', () => {
    // Only audit successful state changes that have an authenticated user.
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    if (!req.user) return;

    const { action, entity_table, entity_id } = describeRequest(req.method, req.originalUrl);
    const clientHeader = (req.headers['x-client-id'] as string | undefined)?.trim();
    const clientId = req.user.client_id
      || (clientHeader && /^[0-9a-f-]{36}$/i.test(clientHeader) ? clientHeader : null);

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
        metadata:       { method: req.method, path: req.originalUrl, status: res.statusCode },
        ip_address:     (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
        user_agent:     (req.headers['user-agent'] as string) || null,
      })
      .then(({ error }) => {
        if (error) logger.warn(`[auditAll] insert failed: ${error.message}`);
      });
  });

  next();
}
