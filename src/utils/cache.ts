/**
 * HTTP response cache helpers.
 *
 * Sets `Cache-Control` + `ETag` so browsers, the dashboard's SWR layer,
 * and any CDN in front of Railway can short-circuit repeat reads.
 *
 * Use sparingly: only on idempotent GETs whose payload is OK to be a few
 * seconds stale. Mutations should never set these.
 */

import type { Response, RequestHandler } from 'express';
import crypto from 'crypto';

/** Cache-Control: private, max-age=N, must-revalidate. Per-user only. */
export function setCachePrivate(res: Response, seconds: number) {
  res.setHeader('Cache-Control', `private, max-age=${seconds}, must-revalidate`);
}

/** Cache-Control: public, max-age=N. For org-public catalogues (states, etc). */
export function setCachePublic(res: Response, seconds: number) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}, must-revalidate`);
}

/** Compute weak ETag from JSON body and 304 if If-None-Match matches. */
export function tryEtag304(req: import('express').Request, res: Response, body: unknown): boolean {
  try {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    const etag = 'W/"' + crypto.createHash('sha1').update(json).digest('base64').slice(0, 27) + '"';
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return true;
    }
    return false;
  } catch { return false; }
}

/**
 * Wrap a GET controller so repeats from the same client get a 304.
 * Use as a route-level middleware factory:
 *
 *   router.get('/today', cacheGet(30), ctrl.getToday);
 */
export function cacheGet(seconds: number): RequestHandler {
  return (_req, res, next) => {
    setCachePrivate(res, seconds);
    next();
  };
}
