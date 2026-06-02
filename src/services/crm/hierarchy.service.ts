import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { logger } from '../../lib/logger';

// Per-request memo so the gate + the subtree query don't hit Supabase
// repeatedly when a single handler asks for both (e.g. the leads route
// does the gate check first, then fetches the subtree IDs). Cleared
// implicitly: each request creates a new closure scope so there's no
// long-lived state to worry about.

const gateCache = new WeakMap<AuthRequest, Promise<boolean>>();
// null = "no owner restriction" (the caller's data_scope is 'all'); an array
// = the explicit set of owner ids the caller may see.
const subtreeCache = new WeakMap<AuthRequest, Promise<string[] | null>>();

/**
 * True when the caller's client has opted into hierarchy-based scoping
 * (clients.settings.uses_hierarchy_rbac === true). Defaults to false in
 * every other case — caller has no client_id, the client row is
 * missing, the flag is missing or non-true — so every existing tenant
 * (Tata Tiscon included) keeps the role/city based path untouched.
 */
export async function useHierarchyRbac(req: AuthRequest): Promise<boolean> {
  const cached = gateCache.get(req);
  if (cached) return cached;
  const p = (async () => {
    const clientId = req.user?.client_id;
    if (!clientId) return false;
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('settings')
      .eq('id', clientId)
      .maybeSingle();
    if (error) {
      logger.warn(`useHierarchyRbac lookup failed for client ${clientId}: ${error.message}`);
      return false;
    }
    const settings = (data?.settings ?? {}) as Record<string, unknown>;
    return settings.uses_hierarchy_rbac === true;
  })();
  gateCache.set(req, p);
  return p;
}

/**
 * Returns the set of user ids whose records the caller may see, derived from
 * the org-role tree (org_roles.parent_id) rather than users.supervisor_id —
 * because tenants configure their hierarchy as a tree of designations
 * (Business Head → Area Sales Manager → Area Sales Officer → …) and assign
 * users to those roles, leaving supervisor_id empty.
 *
 * Driven by the role's data_scope (org_roles.data_scope):
 *   - 'own'  → the caller sees ONLY their own records. A frontline rep is
 *              capped to themselves regardless of peers sharing the role.
 *   - 'team' → the caller sees themselves plus every user whose role is a
 *              DESCENDANT of theirs in the role tree (down the tree only,
 *              never up to a supervisor or sideways). Backed by the SQL
 *              function public.role_subtree_user_ids.
 *   - 'all'  → NO owner restriction (returns null). The caller — an admin /
 *              tenant-wide role such as CRM Admin or Business Head — sees
 *              every owner's records. City scope still applies on top, so a
 *              user with all CRM modules + all cities sees all leads, while a
 *              user with all modules but a narrow city set still only sees
 *              that city's leads. This is what makes an admin-level role with
 *              no descendants (a leaf in the tree) see the whole tenant rather
 *              than just themselves.
 *
 * Returns null = "no owner filter"; an array = the explicit visible-owner set.
 * Failures fall back to "the caller alone" rather than throwing — read-scope
 * must always degrade safely (showing less data, never more, and never an
 * error from the list endpoint).
 */
export async function subtreeUserIds(req: AuthRequest): Promise<string[] | null> {
  const cached = subtreeCache.get(req);
  if (cached !== undefined) return cached;
  const userId = req.user?.id;
  if (!userId) return [];
  const scope = req.user?.org_role_data_scope ?? 'all';
  // 'all' → tenant-wide: no owner restriction (city scope still applies).
  if (scope === 'all') {
    const none = Promise.resolve<string[] | null>(null);
    subtreeCache.set(req, none);
    return none;
  }
  // 'own' → only the caller's own records.
  if (scope === 'own') {
    const self = Promise.resolve<string[] | null>([userId]);
    subtreeCache.set(req, self);
    return self;
  }
  // 'team' → the caller plus their role-tree descendants.
  const p = (async (): Promise<string[] | null> => {
    const { data, error } = await supabaseAdmin.rpc('role_subtree_user_ids', { p_user_id: userId });
    if (error) {
      logger.warn(`role_subtree_user_ids RPC failed for ${userId}: ${error.message}`);
      return [userId];
    }
    const ids = (data ?? []).map((r: any) => r.user_id as string);
    // Guarantee the caller is always included even if their role row is
    // missing/misconfigured, so a manager never loses sight of their own work.
    return ids.includes(userId) ? ids : [userId, ...ids];
  })();
  subtreeCache.set(req, p);
  return p;
}

/**
 * Combo helper used by list-route handlers: returns the subtree id list
 * when the gate is on, else null. Callers pass the result straight into
 * the crud helper's `visibleOwnerIds` option — null means "skip the
 * filter and keep the legacy code path."
 */
export async function maybeSubtreeOwnerIds(req: AuthRequest): Promise<string[] | null> {
  if (!(await useHierarchyRbac(req))) return null;
  return subtreeUserIds(req);
}
