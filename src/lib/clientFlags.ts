import { supabaseAdmin } from './supabase';
import { currentProjectKey } from './projects';

/**
 * Data-driven per-client feature flags, read from `clients.settings` (jsonb).
 *
 * Replaces hardcoded per-client id lists (e.g. the steel-dealer deal-amount
 * derivation and the live-tracking kill switch): a new tenant opts in by
 * setting `clients.settings.<flag> = true`, with NO code change. Existing
 * hardcoded lists stay as a backward-compatible fallback so SRS/BMW/Tata
 * behaviour is byte-for-byte unchanged.
 *
 * A small TTL cache keeps hot paths (tracking pings, lead convert) from
 * hitting the DB on every call; flags are low-churn so 60s staleness is fine.
 */
type Entry = { settings: Record<string, unknown>; at: number };
const cache = new Map<string, Entry>();
const TTL_MS = 60_000;

async function loadSettings(clientId: string): Promise<Record<string, unknown>> {
  const key = `${currentProjectKey()}:${clientId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.settings;
  const { data } = await supabaseAdmin.from('clients').select('settings').eq('id', clientId).maybeSingle();
  const settings = ((data?.settings as Record<string, unknown>) ?? {}) || {};
  cache.set(key, { settings, at: Date.now() });
  return settings;
}

/** True when the client's `settings` jsonb has `settings[flag] === true`. */
export async function clientHasFlag(clientId: string | null | undefined, flag: string): Promise<boolean> {
  if (!clientId) return false;
  try { return (await loadSettings(clientId))[flag] === true; }
  catch { return false; }
}

/** Drop a client's cached settings (call after writing clients.settings). */
export function clearClientFlagCache(clientId?: string | null): void {
  if (!clientId) { cache.clear(); return; }
  for (const k of Array.from(cache.keys())) if (k.endsWith(`:${clientId}`)) cache.delete(k);
}
