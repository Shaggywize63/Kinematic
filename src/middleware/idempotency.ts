import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { conflict } from '../utils/response';
import { logger } from '../lib/logger';

// Hash of (method + path + body) so a replay with a different body is caught.
function hashRequest(req: AuthRequest): string {
  const payload = JSON.stringify({
    m: req.method,
    p: req.originalUrl.split('?')[0],
    b: req.body || {},
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Idempotency middleware. Required on every distribution mutation.
 *
 *   Same key + same body  → returns the cached response (status + body).
 *   Same key + diff body  → 409 IDEMPOTENCY_CONFLICT.
 *   New key               → captures res.json() and persists once status < 500.
 *
 * Header: `Idempotency-Key: <uuid>` (any opaque string up to 200 chars).
 * If the header is missing the request proceeds without replay protection.
 */
export async function idempotency(req: AuthRequest, res: Response, next: NextFunction) {
  const key = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;
  if (!key || key.length === 0) return next();
  if (key.length > 200) return conflict(res, 'Idempotency-Key too long');

  const user = req.user;
  if (!user) return next();

  const reqHash = hashRequest(req);
  const route = req.method + ' ' + req.originalUrl.split('?')[0];

  // Look up an existing key for this user.
  const { data: existing } = await supabaseAdmin
    .from('idempotency_keys')
    .select('*')
    .eq('key', key)
    .maybeSingle();

  if (existing) {
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      // Expired — purge and proceed as a fresh request.
      await supabaseAdmin.from('idempotency_keys').delete().eq('key', key);
    } else {
      if (existing.user_id !== user.id) {
        return conflict(res, 'Idempotency-Key belongs to a different user');
      }
      if (existing.request_hash !== reqHash) {
        return conflict(res, 'Idempotency-Key reused with a different request body');
      }
      // Replay — return cached response.
      return res.status(existing.response_status).json(existing.response_body);
    }
  }

  // Capture json() so we can persist the body after the controller responds.
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    const status = res.statusCode || 200;
    if (status < 500) {
      // Fire-and-forget; controller already responded by the time this runs.
      supabaseAdmin
        .from('idempotency_keys')
        .insert({
          key,
          org_id: user.org_id,
          user_id: user.id,
          route,
          request_hash: reqHash,
          response_status: status,
          response_body: body,
        })
        .then(({ error }) => {
          if (error && error.code !== '23505') {
            logger.warn(`[idempotency] persist failed: ${error.message}`);
          }
        });
    }
    return origJson(body);
  };

  next();
}
