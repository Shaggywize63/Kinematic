/**
 * Cache wrapper for analytics endpoints. Uses Upstash Redis (REST) when
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, otherwise
 * falls back to the in-process TtlCache. Either way the call site looks
 * the same: `cached(key, ttlSeconds, () => loader())`.
 *
 * Why Upstash REST: zero deps, edge-friendly, works through Railway's
 * outbound HTTPS without needing an ioredis driver. Falls back gracefully
 * if Upstash is down — we just compute the value live.
 */
import { createTtlCache } from './ttlCache';
import { logger } from '../lib/logger';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_ENABLED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

const inProcess = createTtlCache<string>({ defaultTtlMs: 60_000, maxSize: 2000 });

async function redisGet(key: string): Promise<string | null> {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      // Don't retry — analytics is fine to recompute on transient cache miss.
    });
    if (!r.ok) return null;
    const j = await r.json() as { result?: string | null };
    return j.result ?? null;
  } catch (e: any) {
    logger.warn(`[analyticsCache] redis GET failed: ${e.message}`);
    return null;
  }
}

async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttlSeconds}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
  } catch (e: any) {
    logger.warn(`[analyticsCache] redis SET failed: ${e.message}`);
  }
}

/**
 * Get-or-compute. `loader` runs on cache miss; result is JSON-serialised
 * and cached for `ttlSeconds`. Compute errors propagate. Cache errors are
 * logged and swallowed so the user never gets a 500 from a cache layer.
 */
export async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  if (REDIS_ENABLED) {
    const hit = await redisGet(key);
    if (hit != null) {
      try { return JSON.parse(hit) as T; }
      catch { /* corrupt entry; recompute */ }
    }
    const value = await loader();
    void redisSet(key, JSON.stringify(value), ttlSeconds);
    return value;
  }
  // In-process fallback
  const hit = inProcess.get(key);
  if (hit != null) {
    try { return JSON.parse(hit) as T; } catch { /* fallthrough */ }
  }
  const value = await loader();
  inProcess.set(key, JSON.stringify(value), ttlSeconds * 1000);
  return value;
}

/** Drop a single cache key. Use after writes that invalidate analytics. */
export async function bust(key: string): Promise<void> {
  if (REDIS_ENABLED) {
    try { await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }); }
    catch { /* ignore */ }
  }
  inProcess.delete(key);
}
