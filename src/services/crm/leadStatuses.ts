/**
 * Per-client lead statuses.
 *
 * Historically every tenant shared one hardcoded lifecycle enum
 * (new / working / nurturing / qualified / unqualified / converted / lost).
 * A client can now define its OWN ordered status set (label + colour) in
 * `crm_settings.config.lead_statuses` — exactly the way per-client field
 * overrides already live in `crm_settings.config.field_overrides`. This needs
 * no new table and no DDL: the settings row exists in every project and the
 * settings GET endpoint already returns `config` verbatim, so the dashboard /
 * iOS / Android clients receive the custom set for free.
 *
 * A tenant that has NOT configured `lead_statuses` falls back to the built-in
 * set, so production behaviour for Tata and every other existing client is
 * byte-for-byte unchanged.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export interface LeadStatusOption {
  value: string;
  label?: string;
  color?: string;
  position?: number;
  is_won?: boolean;
  is_lost?: boolean;
  is_open?: boolean;
}

// The historical lifecycle set. `BUILTIN_CREATE_STATUSES` excludes the terminal
// states (a lead is never *created* straight into converted/lost) to preserve
// the exact create-time whitelist the Zod enum used to enforce.
export const BUILTIN_LEAD_STATUSES = [
  'new', 'working', 'nurturing', 'qualified', 'unqualified', 'converted', 'lost',
] as const;
export const BUILTIN_CREATE_STATUSES = [
  'new', 'working', 'nurturing', 'qualified', 'unqualified',
] as const;

// Built-in disqualified/terminal states used by the auto-stamp of
// `disqualified_at`. Custom sets extend this via `is_lost`.
export const BUILTIN_DISQUALIFIED_STATES = ['unqualified', 'lost'] as const;

// A status value must be a safe lowercase slug. Blocks oversized / injection-y
// values while allowing any tenant-defined key (e.g. `visit_planned`).
const STATUS_SLUG = /^[a-z][a-z0-9_]{0,63}$/;

interface CacheEntry { at: number; statuses: LeadStatusOption[] | null }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** Pull + validate the `lead_statuses` array out of a crm_settings.config blob. */
export function parseLeadStatuses(config: unknown): LeadStatusOption[] | null {
  const raw = (config && typeof config === 'object')
    ? (config as Record<string, unknown>).lead_statuses
    : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: LeadStatusOption[] = [];
  for (const r of raw) {
    if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      if (typeof o.value === 'string' && STATUS_SLUG.test(o.value)) {
        out.push({
          value: o.value,
          label: typeof o.label === 'string' ? o.label : undefined,
          color: typeof o.color === 'string' ? o.color : undefined,
          position: typeof o.position === 'number' ? o.position : undefined,
          is_won: o.is_won === true,
          is_lost: o.is_lost === true,
          is_open: o.is_open === true,
        });
      }
    }
  }
  if (!out.length) return null;
  return out.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/**
 * The client's configured status set, or null when none is configured (→ the
 * caller uses the built-in set). Cached briefly so lead create/update don't pay
 * a settings read on every write.
 */
export async function loadClientLeadStatuses(
  org_id: string,
  client_id: string | null,
): Promise<LeadStatusOption[] | null> {
  if (!client_id) return null;
  const key = `${org_id}|${client_id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.statuses;
  const { data } = await supabaseAdmin
    .from('crm_settings')
    .select('config')
    .eq('org_id', org_id)
    .eq('client_id', client_id)
    .maybeSingle();
  const statuses = parseLeadStatuses((data as { config?: unknown } | null)?.config);
  cache.set(key, { at: Date.now(), statuses });
  return statuses;
}

/** Invalidate the cache for a client (call after an admin edits its statuses). */
export function invalidateLeadStatusCache(org_id: string, client_id: string | null): void {
  if (client_id) cache.delete(`${org_id}|${client_id}`);
}

/**
 * Reject a status that isn't valid for this client. No-op when status is
 * undefined (an optional PATCH field). Custom-status clients must use one of
 * their configured values; everyone else uses the built-in whitelist, with the
 * create path excluding the terminal states exactly as before.
 */
export async function assertValidLeadStatus(
  org_id: string,
  client_id: string | null,
  status: string | undefined | null,
  forCreate: boolean,
): Promise<void> {
  if (status == null) return;
  const custom = await loadClientLeadStatuses(org_id, client_id);
  if (custom) {
    if (!custom.some((s) => s.value === status)) {
      throw new AppError(400, `Invalid lead status "${status}" for this client`, 'INVALID_STATUS');
    }
    return;
  }
  const allowed: readonly string[] = forCreate ? BUILTIN_CREATE_STATUSES : BUILTIN_LEAD_STATUSES;
  if (!allowed.includes(status)) {
    throw new AppError(400, `Invalid lead status "${status}"`, 'INVALID_STATUS');
  }
}

/**
 * The set of statuses that count as "disqualified" (auto-stamp disqualified_at)
 * for a client — its `is_lost` statuses when a custom set is configured,
 * otherwise the built-in terminal states.
 */
export async function disqualifiedStatesFor(
  org_id: string,
  client_id: string | null,
): Promise<Set<string>> {
  const custom = await loadClientLeadStatuses(org_id, client_id);
  if (custom) {
    const lost = custom.filter((s) => s.is_lost).map((s) => s.value);
    return new Set(lost.length ? lost : []);
  }
  return new Set(BUILTIN_DISQUALIFIED_STATES);
}
