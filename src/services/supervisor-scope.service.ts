import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { logger } from '../lib/logger';

/**
 * Supervisor-hierarchy visibility scoping for FIELD-FORCE surfaces (Live
 * Trailing, attendance, work activities, user-performance, route plans).
 *
 * By default a client-bound manager (org-role data_scope='team') sees every
 * field executive in their org. Clients that opt in via
 * `clients.settings.uses_supervisor_scope === true` instead restrict a team
 * manager to their SUPERVISOR SUBTREE — themselves plus everyone who reports
 * up to them through users.supervisor_id. Every other tenant (the flag off —
 * Tata, Kinematic, …) is completely unaffected: the resolver returns null =
 * "no restriction" for them, so their existing org-scoped behaviour is kept.
 *
 * The org master / Kinematic-team logins (staff cap-exempt domains) and any
 * data_scope='all' role always see everyone, so a top admin never loses sight
 * of the whole team.
 */

// Kinematic-team / staff domains — mirrors ACTIVE_CAP_BYPASS_DOMAINS. These
// accounts manage the client and must keep full visibility.
const STAFF_DOMAINS = new Set(['kinematicapp.com', 'horizontechstudio.com', 'kinematic.com', 'kaiyotechnologylabs.com']);
const domainOf = (email?: string | null) => String(email || '').split('@')[1]?.toLowerCase().trim() || '';

const flagCache = new WeakMap<AuthRequest, Promise<boolean>>();

/** True when the caller's client opted into supervisor-hierarchy scoping. */
export async function usesSupervisorScope(req: AuthRequest): Promise<boolean> {
  const cached = flagCache.get(req);
  if (cached) return cached;
  const p = (async () => {
    const clientId = req.user?.client_id;
    if (!clientId) return false;
    const { data, error } = await supabaseAdmin.from('clients').select('settings').eq('id', clientId).maybeSingle();
    if (error) { logger.warn(`usesSupervisorScope lookup failed for ${clientId}: ${error.message}`); return false; }
    return ((data?.settings ?? {}) as Record<string, unknown>).uses_supervisor_scope === true;
  })();
  flagCache.set(req, p);
  return p;
}

/** Self + all descendants via users.supervisor_id (in-memory BFS over the org). */
export async function supervisorSubtreeIds(orgId: string, rootUserId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('users').select('id, supervisor_id')
    .eq('org_id', orgId).eq('is_active', true).is('deleted_at', null);
  const rows = (data || []) as { id: string; supervisor_id: string | null }[];
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.supervisor_id) continue;
    (children.get(r.supervisor_id) ?? children.set(r.supervisor_id, []).get(r.supervisor_id)!).push(r.id);
  }
  const out = new Set<string>([rootUserId]);
  const queue = [rootUserId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of children.get(cur) || []) if (!out.has(c)) { out.add(c); queue.push(c); }
  }
  return [...out];
}

/**
 * The set of user ids the caller may see on field-force surfaces, or null for
 * "no restriction". null when: not client-bound (platform), a staff cap-exempt
 * domain (the master), data_scope='all', or the client hasn't opted in. An
 * array when scoped: [self] for 'own', self + supervisor descendants for 'team'.
 * Fails safe to [self] rather than widening.
 */
export async function fieldForceScopeIds(req: AuthRequest): Promise<string[] | null> {
  const u = req.user;
  if (!u?.id) return [];
  if (!u.client_id) return null;                          // platform / non-client-bound
  if (STAFF_DOMAINS.has(domainOf(u.email))) return null;  // master / Kinematic team
  if (!(await usesSupervisorScope(req))) return null;     // client not opted in → legacy behaviour
  const scope = u.org_role_data_scope ?? 'all';
  if (scope === 'all') return null;
  if (scope === 'own') return [u.id];
  try {
    return await supervisorSubtreeIds(u.org_id, u.id);
  } catch (e) {
    logger.warn(`fieldForceScopeIds subtree failed for ${u.id}: ${(e as Error).message}`);
    return [u.id];
  }
}
