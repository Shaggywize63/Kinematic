/**
 * KINI agentic-v2 feature flag gate.
 *
 * Flag lives in `org_settings` with key='kini_agentic_v2'. The value column
 * can be a boolean, the string 'true'/'false', or a JSON blob with
 * { value: bool } or { enabled: bool } — all are accepted.
 *
 * Read precedence (first match wins):
 *   1. env override KINI_AGENTIC_V2_FORCE=true|false   (used in staging)
 *   2. org_settings row matching (org_id, client_id)
 *   3. org_settings row matching (org_id, client_id IS NULL)
 *   4. default: false
 *
 * Cached in-process for 60s, keyed by `${org_id}:${client_id ?? ''}`.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

const TTL_MS = 60_000;
const cache = new Map<string, { value: boolean; expires_at: number }>();

function envOverride(): boolean | null {
  const raw = (process.env.KINI_AGENTIC_V2_FORCE || '').toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

function parseBool(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    if ('value' in obj) return parseBool(obj.value);
    if ('enabled' in obj) return parseBool(obj.enabled);
  }
  return false;
}

export async function isAgenticV2Enabled(
  org_id: string,
  client_id: string | null,
): Promise<boolean> {
  const forced = envOverride();
  if (forced !== null) return forced;

  const key = `${org_id}:${client_id ?? ''}`;
  const hit = cache.get(key);
  if (hit && hit.expires_at > Date.now()) return hit.value;

  try {
    const { data, error } = await supabaseAdmin
      .from('org_settings')
      .select('value, client_id')
      .eq('org_id', org_id)
      .eq('key', 'kini_agentic_v2');

    if (error) {
      logger.warn(`[kiniFlags] read failed: ${error.message}`);
      cache.set(key, { value: false, expires_at: Date.now() + TTL_MS });
      return false;
    }

    const rows = (data || []) as Array<{ value: unknown; client_id: string | null }>;
    const clientRow = client_id ? rows.find((r) => r.client_id === client_id) : null;
    const orgRow = rows.find((r) => r.client_id === null);
    const value = parseBool((clientRow ?? orgRow)?.value);
    cache.set(key, { value, expires_at: Date.now() + TTL_MS });
    return value;
  } catch (e) {
    logger.warn(`[kiniFlags] exception: ${(e as Error).message}`);
    return false;
  }
}

export function clearKiniFlagsCache(): void {
  cache.clear();
}
