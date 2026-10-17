// Which companies (clients) of the org a caller may see or assign.
// An org-wide admin (no client of their own) sees them all; anyone tied to a client
// only sees that client, or the set of companies they have been assigned.
export interface VisibilityUser { client_id?: string | null; company_client_ids?: string[] }

/** The caller's visible company ids, or null when they are org-wide (every company in their org). */
export function visibleCompanyIds(user: VisibilityUser | undefined | null): string[] | null {
  const assigned = Array.isArray(user?.company_client_ids) ? user!.company_client_ids! : [];
  if (assigned.length > 0) return assigned;
  if (user?.client_id) return [user.client_id];
  return null;
}

/** True when every id is visible to the caller (org-wide callers see all). */
export function canSeeAll(visible: string[] | null, ids: string[]): boolean {
  if (visible === null) return true;
  const ok = new Set(visible.map((v) => v.toLowerCase()));
  return ids.every((i) => ok.has(i.toLowerCase()));
}

/**
 * Limits a `distribution_integrations` query to connections pinned to a company the caller can see.
 * Org-wide callers are unchanged; a client-pinned caller no longer sees other clients' connections
 * (or org-wide ones that belong to nobody in particular).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scopeIntegrations(q: any, user: VisibilityUser | undefined | null) {
  const visible = visibleCompanyIds(user);
  return visible ? q.in('config->>client_id', visible) : q;
}
