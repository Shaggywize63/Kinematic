/**
 * Who is who in the expense module. Shared by the claims service and the policy
 * engine so neither has to import the other.
 */
export interface Actor {
  id: string;
  org_id: string;
  role?: string | null;
  client_id?: string | null;
  data_scope?: string | null;
}

const ADMIN_ROLES = ['admin', 'super_admin', 'main_admin', 'org_admin', 'sub_admin', 'client'];

export function isAdmin(role?: string | null): boolean {
  return ADMIN_ROLES.includes((role ?? '').toLowerCase());
}

/**
 * Can this actor act as an approver/admin for expenses? Identical to isAdmin on
 * the legacy role, EXCEPT a field executive is never one. Flat field-force
 * tenants (e.g. ByteBack) give reps the `sub_admin` role — which isAdmin would
 * wrongly accept — distinguished from real managers only by an org-role
 * data_scope of 'own'. Denying own-scope here stops a rep from seeing or
 * deciding other people's claims via the coarse role check.
 */
export function isApprover(actor: Actor): boolean {
  if ((actor.data_scope ?? '').toLowerCase() === 'own') return false;
  return isAdmin(actor.role);
}
