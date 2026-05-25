import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { logger } from '../../lib/logger';

// Per-request memo so the gate + the subtree query don't hit Supabase
// repeatedly when a single handler asks for both (e.g. the leads route
// does the gate check first, then fetches the subtree IDs). Cleared
// implicitly: each request creates a new closure scope so there's no
// long-lived state to worry about.

const gateCache = new WeakMap<AuthRequest, Promise<boolean>>();
const subtreeCache = new WeakMap<AuthRequest, Promise<string[]>>();

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
 * Returns the caller's own id plus the id of every direct/indirect
 * report (via users.supervisor_id). Backed by the SQL function
 * public.user_subtree_ids. Failures fall back to "the caller alone"
 * rather than throwing — read-scope must always degrade safely (showing
 * less data, never more, and never an error from the list endpoint).
 */
export async function subtreeUserIds(req: AuthRequest): Promise<string[]> {
  const cached = subtreeCache.get(req);
  if (cached) return cached;
  const userId = req.user?.id;
  if (!userId) return [];
  const p = (async () => {
    const { data, error } = await supabaseAdmin.rpc('user_subtree_ids', { p_user_id: userId });
    if (error) {
      logger.warn(`user_subtree_ids RPC failed for ${userId}: ${error.message}`);
      return [userId];
    }
    return (data ?? []).map((r: any) => r.user_id as string);
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
