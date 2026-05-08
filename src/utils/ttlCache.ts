/**
 * Tiny TTL + LRU cache. Used for hot lookups (crm_settings, ICP config,
 * feature flags, deal-stage maps) that are read on every request but rarely
 * change. Avoids hammering Postgres for the same row hundreds of times per
 * second under load.
 *
 * Not a full LRU — just a Map with a soft size cap that evicts the
 * insertion-oldest entry when the cap is hit. Good enough for ~1000 entries
 * with low contention. For larger working sets, switch to lru-cache.
 */

type Entry<V> = { value: V; expiresAt: number };

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
  /** Get-or-set: returns the cached value, or runs `loader` and caches it. */
  remember(key: string, loader: () => Promise<V>, ttlMs?: number): Promise<V>;
}

export function createTtlCache<V>(opts: { defaultTtlMs: number; maxSize?: number } = { defaultTtlMs: 60_000 }): TtlCache<V> {
  const max = opts.maxSize ?? 1000;
  const store = new Map<string, Entry<V>>();
  const inflight = new Map<string, Promise<V>>(); // dedupe concurrent loads

  const get = (key: string): V | undefined => {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      store.delete(key);
      return undefined;
    }
    return hit.value;
  };

  const set = (key: string, value: V, ttlMs?: number) => {
    if (store.size >= max) {
      const firstKey = store.keys().next().value;
      if (firstKey !== undefined) store.delete(firstKey);
    }
    store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? opts.defaultTtlMs) });
  };

  const del = (key: string) => { store.delete(key); };
  const clear = () => { store.clear(); inflight.clear(); };

  const remember = async (key: string, loader: () => Promise<V>, ttlMs?: number): Promise<V> => {
    const cached = get(key);
    if (cached !== undefined) return cached;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const value = await loader();
        set(key, value, ttlMs);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };

  return { get, set, delete: del, clear, remember };
}
