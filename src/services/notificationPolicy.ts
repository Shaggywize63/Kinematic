/**
 * Who may receive which notification.
 *
 * Two rules, applied where a notification leaves the server (the push dispatcher and the in-app list), so every
 * writer — the ~20 services that insert rows — is covered without being touched:
 *
 *  1. Project switch. Projects named in NOTIFICATIONS_DISABLED_PROJECTS receive nothing. Default: `default`, the
 *     Tata project. (Set it to an empty value to lift the switch.)
 *  2. Client catalogue. Everywhere else a notification is delivered only if its kind is switched on for the
 *     recipient's org (org_settings `notifications.enabled_kinds`, an array of catalogue kinds or ["*"]).
 *     No setting = nothing on. That is the default for every new client; Client Management turns kinds on.
 *
 * NOTIFICATION_POLICY=off removes both rules (the old behaviour: everything is delivered) — the rollback switch.
 * Under NODE_ENV=test the policy is off unless NOTIFICATION_POLICY=on, so unrelated tests keep exercising delivery.
 *
 * A failed settings read never suppresses anything: a dropped notification is stamped as handled and cannot be
 * recovered, so when the setting cannot be read the notification is delivered as before.
 */
import { supabaseAdmin } from '../lib/supabase';
import { currentProjectKey } from '../lib/projects';
import { logger } from '../lib/logger';
import { ALL_KINDS, canonicalKind, isKnownKind, parseEnabledKinds, NOTIFICATION_CATALOG } from '../lib/notificationCatalog';
import { notificationKind } from '../lib/notificationRoute';

export const SETTING_KEY = 'notifications.enabled_kinds';
const TTL_MS = 60_000;

export interface EnabledKinds { all: boolean; kinds: Set<string> }

export const policyActive = (): boolean => {
  const v = (process.env.NOTIFICATION_POLICY || '').toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  return process.env.NODE_ENV !== 'test';
};

/** Projects that receive no notifications at all. */
export function disabledProjects(): Set<string> {
  const raw = process.env.NOTIFICATIONS_DISABLED_PROJECTS;
  const list = raw === undefined ? 'default' : raw;
  return new Set(list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export const isProjectDisabled = (project: string = currentProjectKey()): boolean =>
  policyActive() && disabledProjects().has(String(project).toLowerCase());

/** What a stored value means: ["*"], ["kind", …] or { kinds: [...] }. Anything else = nothing on. */
export function toEnabled(value: unknown): EnabledKinds {
  const arr = Array.isArray(value) ? value
    : value && typeof value === 'object' && Array.isArray((value as { kinds?: unknown }).kinds) ? (value as { kinds: unknown[] }).kinds
    : [];
  const kinds = new Set<string>();
  let all = false;
  for (const k of arr) {
    const s = String(k ?? '').trim();
    if (s === ALL_KINDS) all = true;
    else if (s) kinds.add(canonicalKind(s));
  }
  return { all, kinds };
}

export const kindEnabled = (e: EnabledKinds | undefined, kind: string): boolean =>
  !!e && (e.all || e.kinds.has(canonicalKind(kind)));

const cache = new Map<string, { at: number; v: EnabledKinds }>();
const ck = (org: string) => `${currentProjectKey()}:${org}`;

/** Test seam. */
export const _resetPolicyCache = (): void => cache.clear();

/**
 * Settings for a set of orgs (one query for the misses). An org without a row is `{ all:false, kinds:∅ }` — nothing on.
 * Returns null when the settings could not be read, so callers deliver rather than drop.
 */
export async function loadEnabledKinds(orgIds: Array<string | null | undefined>): Promise<Map<string, EnabledKinds> | null> {
  const ids = [...new Set(orgIds.filter((x): x is string => !!x))];
  const out = new Map<string, EnabledKinds>();
  const miss: string[] = [];
  const now = Date.now();
  for (const id of ids) {
    const hit = cache.get(ck(id));
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.v); else miss.push(id);
  }
  if (miss.length) {
    const { data, error } = await supabaseAdmin.from('org_settings').select('org_id, value').eq('key', SETTING_KEY).in('org_id', miss);
    if (error) {
      logger.warn(`[notif-policy] settings read failed, delivering unfiltered: ${error.message}`);
      return null;
    }
    const found = new Map<string, EnabledKinds>();
    for (const r of (data ?? []) as Array<{ org_id: string; value: unknown }>) found.set(r.org_id, toEnabled(r.value));
    for (const id of miss) {
      const v = found.get(id) ?? { all: false, kinds: new Set<string>() };
      cache.set(ck(id), { at: now, v });
      out.set(id, v);
    }
  }
  return out;
}

const warnedUnknown = new Set<string>();
function noteUnknown(kind: string): void {
  if (isKnownKind(kind) || warnedUnknown.has(kind)) return;
  warnedUnknown.add(kind);
  logger.warn(`[notif-policy] notification kind "${kind}" is not in the catalogue (lib/notificationCatalog.ts); it is never delivered until added`);
}

/**
 * For each item, may it be delivered? Same order as the input. Items with no org are held back (nothing to look up)
 * unless the policy is inactive or the settings could not be read.
 */
export async function allowedFlags(items: Array<{ orgId?: string | null; kind: string }>): Promise<boolean[]> {
  if (!policyActive()) return items.map(() => true);
  if (isProjectDisabled()) return items.map(() => false);
  const settings = await loadEnabledKinds(items.map((i) => i.orgId));
  if (!settings) return items.map(() => true);
  return items.map((i) => {
    noteUnknown(i.kind);
    return !!i.orgId && kindEnabled(settings.get(i.orgId), i.kind);
  });
}

export async function isNotificationEnabled(orgId: string | null | undefined, kind: string): Promise<boolean> {
  return (await allowedFlags([{ orgId, kind }]))[0];
}

// ── Management (Client Management → Notifications) ──────────────────────────────────────────────────────────

export interface OrgNotificationSettings {
  project_disabled: boolean;
  all: boolean;
  enabled_kinds: string[];
  catalog: Array<{ kind: string; label: string; group: string; description: string; recommended: boolean; enabled: boolean }>;
}

/** `project` = the project the org lives in (a client linked to another project is read through that project's client). */
export async function readOrgSettings(orgId: string, client = supabaseAdmin, project: string = currentProjectKey()): Promise<OrgNotificationSettings> {
  const { data } = await client.from('org_settings').select('value').eq('org_id', orgId).eq('key', SETTING_KEY).maybeSingle();
  const e = toEnabled((data as { value?: unknown } | null)?.value);
  return {
    project_disabled: isProjectDisabled(project),
    all: e.all,
    enabled_kinds: e.all ? [ALL_KINDS] : [...e.kinds],
    catalog: NOTIFICATION_CATALOG.map((c) => ({
      kind: c.kind, label: c.label, group: c.group, description: c.description, recommended: !!c.recommended,
      enabled: e.all || e.kinds.has(c.kind),
    })),
  };
}

/** Replace the org's enabled kinds. Throws on an unknown kind. An empty list switches everything off. */
export async function writeOrgSettings(orgId: string, kindsInput: unknown, updatedBy: string | null, client = supabaseAdmin): Promise<string[]> {
  const kinds = parseEnabledKinds(kindsInput);
  await client.from('org_settings').delete().eq('org_id', orgId).eq('key', SETTING_KEY);
  const { error } = await client.from('org_settings').insert({ org_id: orgId, key: SETTING_KEY, value: kinds, updated_by: updatedBy });
  if (error) throw new Error(error.message);
  cache.delete(ck(orgId));
  return kinds;
}

// ── In-app surfaces other than the bell list ────────────────────────────────────────────────────────────────────

/**
 * The unread badge. It must agree with the list: a project or client with notifications off shows no badge, and a client
 * with only some kinds on counts only those. Fails open to the plain count when settings can't be read.
 */
export async function countUnreadAllowed(user: { id: string; org_id?: string | null }, client = supabaseAdmin): Promise<number> {
  const plain = async () => {
    const { count } = await client.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('is_read', false);
    return count ?? 0;
  };
  if (!policyActive()) return plain();
  if (isProjectDisabled()) return 0;
  const settings = await loadEnabledKinds([user.org_id]);
  if (!settings) return plain();
  const e = user.org_id ? settings.get(user.org_id) : undefined;
  if (!e || (!e.all && e.kinds.size === 0)) return 0;
  if (e.all) return plain();
  const { data } = await client.from('notifications').select('type, data').eq('user_id', user.id).eq('is_read', false).limit(500);
  return ((data ?? []) as Array<{ type?: string | null; data?: unknown }>).filter((r) => kindEnabled(e, notificationKind(r.type, r.data))).length;
}
