/**
 * Who may manage whom (AZ-1 / AZ-2 of the 2026-10 audit).
 *
 * updateUser / resetUserPassword / sendUserPasswordReset took the target id from the URL and called GoTrue with the
 * service key, so any admin-tier caller could reset the password of any account in the project, and `role` could be
 * set to anything. The rules here:
 *
 *  - ORG (enforced): the target must live in the caller's org, or in a client the caller's org owns (Client
 *    Management creates one org per client), or the caller is a platform operator. Anything else is a 404, so ids
 *    cannot be probed. This is the rule deleteUser/getUserById already apply.
 *  - SUPER_ADMIN (enforced): only a super_admin may manage a super_admin (deleteUser already says so).
 *  - SELF-PROMOTION (enforced): nobody raises their own role above their current one.
 *  - RANK (log-only by default): managing, or assigning, a role above the caller's own. Some tenants may rely on a
 *    client-level login editing an admin it created, so this only logs `[authz-shadow]` until USER_RANK_ENFORCE=on.
 */
import { supabaseAdmin } from './supabase';
import { logger } from './logger';
import { isPlatformOperator } from './tenantScope';
import { AppError, isUUID } from '../utils';

export const ROLE_RANK: Record<string, number> = {
  super_admin: 100, admin: 90, main_admin: 80, client: 70, sub_admin: 60, city_manager: 50, hr: 50,
  supervisor: 40, executive: 10, field_executive: 10,
};

export const roleRank = (role?: string | null): number => ROLE_RANK[(role || '').toLowerCase()] ?? 0;

const rankEnforced = (): boolean => (process.env.USER_RANK_ENFORCE || '').toLowerCase() === 'on';

export interface GuardActor { id?: string | null; role?: string | null; org_id?: string | null; email?: string | null; client_id?: string | null }
export interface GuardTarget { id: string; org_id?: string | null; client_id?: string | null; role?: string | null }

export type Decision =
  | { ok: true; shadow?: string }
  | { ok: false; status: 403 | 404; message: string; code: string };

const NOT_FOUND: Decision = { ok: false, status: 404, message: 'User not found or no permission', code: 'NOT_FOUND' };

/** Pure policy: may `actor` manage `target`? `ownsTargetClient` = the target's client is owned by the actor's org. */
export function decideManage(actor: GuardActor, target: GuardTarget, ownsTargetClient: boolean): Decision {
  const self = !!actor.id && actor.id === target.id;
  const operator = isPlatformOperator(actor);
  if (!self && !operator) {
    const sameOrg = !!actor.org_id && actor.org_id === target.org_id;
    if (!sameOrg && !ownsTargetClient) return NOT_FOUND;
  }
  const targetRole = (target.role || '').toLowerCase();
  const actorRole = (actor.role || '').toLowerCase();
  if (!self && targetRole === 'super_admin' && actorRole !== 'super_admin') {
    return { ok: false, status: 403, message: 'Only a super admin can manage a super admin.', code: 'FORBIDDEN' };
  }
  if (!self && !operator && roleRank(targetRole) > roleRank(actorRole)) {
    if (rankEnforced()) return { ok: false, status: 403, message: 'You cannot manage a user of a higher role.', code: 'FORBIDDEN' };
    return { ok: true, shadow: `manage higher role (${actorRole} -> ${targetRole})` };
  }
  return { ok: true };
}

/** Pure policy: may `actor` give `targetId` the role `newRole`? */
export function decideAssignRole(actor: GuardActor, newRole: string | null | undefined, targetId?: string | null): Decision {
  if (!newRole) return { ok: true };
  const role = newRole.toLowerCase();
  const actorRole = (actor.role || '').toLowerCase();
  if (isPlatformOperator(actor) || actorRole === 'super_admin') return { ok: true };
  const above = roleRank(role) > roleRank(actorRole);
  if (!above) return { ok: true };
  if (targetId && actor.id === targetId) {
    return { ok: false, status: 403, message: 'You cannot raise your own role.', code: 'FORBIDDEN' };
  }
  if (rankEnforced()) return { ok: false, status: 403, message: 'You cannot assign a role above your own.', code: 'FORBIDDEN' };
  return { ok: true, shadow: `assign higher role (${actorRole} -> ${role})` };
}

function apply(decision: Decision, what: string, actor: GuardActor, targetId?: string | null): void {
  if (decision.ok) {
    const shadow = (decision as { shadow?: string }).shadow;
    if (shadow) logger.warn(`[authz-shadow] ${what}: actor=${actor.id} (${actor.role}) target=${targetId ?? '-'} ${shadow}`);
    return;
  }
  const deny = decision as Extract<Decision, { ok: false }>; // tsconfig is not strict, so `ok` does not narrow the union
  logger.warn(`[authz-deny] ${what}: actor=${actor.id} (${actor.role}) target=${targetId ?? '-'} ${deny.code}`);
  throw new AppError(deny.status, deny.message, deny.code);
}

/** Load a user and say whether the actor may reach them (same org, a client their org owns, the operator, or self). */
async function loadReachable(actor: GuardActor, targetId: string): Promise<{ target: GuardTarget | null; reachable: boolean; ownsClient: boolean }> {
  if (!isUUID(targetId)) throw new AppError(400, 'Invalid user id', 'VALIDATION_ERROR');
  const { data, error } = await supabaseAdmin.from('users').select('id, org_id, client_id, role').eq('id', targetId).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) return { target: null, reachable: false, ownsClient: false };
  const target = data as GuardTarget;

  let ownsClient = false;
  if (actor.org_id && target.org_id !== actor.org_id && target.client_id) {
    const { data: c } = await supabaseAdmin.from('clients').select('owner_org_id, org_id').eq('id', target.client_id).maybeSingle();
    const row = c as { owner_org_id?: string | null; org_id?: string | null } | null;
    ownsClient = !!row && (row.owner_org_id === actor.org_id || row.org_id === actor.org_id);
  }
  const reachable = actor.id === target.id || isPlatformOperator(actor) || (!!actor.org_id && actor.org_id === target.org_id) || ownsClient;
  return { target, reachable, ownsClient };
}

/** Load the target and apply the full policy; throws 404/403. Returns the loaded target row. */
export async function assertMayManageUser(actor: GuardActor, targetId: string, what = 'manage-user'): Promise<GuardTarget> {
  const { target, ownsClient } = await loadReachable(actor, targetId);
  if (!target) throw new AppError(404, 'User not found or no permission', 'NOT_FOUND');
  apply(decideManage(actor, target, ownsClient), what, actor, targetId);
  return target;
}

/** Org / ownership check only (no rank rules): for writes that name a user, e.g. an attendance override. 404 when out of reach. */
export async function assertUserReachable(actor: GuardActor, targetId: string, what = 'reach-user'): Promise<void> {
  const { target, reachable } = await loadReachable(actor, targetId);
  if (target && reachable) return;
  logger.warn(`[authz-deny] ${what}: actor=${actor.id} (${actor.role}) target=${targetId} NOT_FOUND`);
  throw new AppError(404, 'User not found or no permission', 'NOT_FOUND');
}

/** Throws when the actor may not give `targetId` (omit for a create) the role `newRole`. */
export function assertMayAssignRole(actor: GuardActor, newRole: string | null | undefined, targetId?: string | null, what = 'assign-role'): void {
  apply(decideAssignRole(actor, newRole, targetId), what, actor, targetId);
}

/**
 * Is a row owned by `rowOrgId` within the actor's reach? Same org, or the platform operator. (Rows that carry a
 * client_id can additionally be reached through client ownership; callers with that column pass `clientOwnedByActor`.)
 */
export const orgRowReachable = (actor: GuardActor, rowOrgId: string | null | undefined, clientOwnedByActor = false): boolean =>
  isPlatformOperator(actor) || clientOwnedByActor || (!!actor.org_id && !!rowOrgId && actor.org_id === rowOrgId);
