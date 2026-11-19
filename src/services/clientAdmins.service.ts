/**
 * Client admins (Client Management → Admins).
 *
 * A client's admins are the logins that run that client's own workspace: role `client`, bound to the client
 * (`client_id`) and living in the org that holds the client's users. Client Management used to create exactly one,
 * from the Email / Login Password fields when the client was first set up, and there was no way to add more. The
 * other route, Settings → Users with role "Client", went through POST /users, which stamps the CALLER's org. That
 * left the new admin in the master admin's org, where it could not see the client's data.
 *
 * The functions here take an explicit target — the Supabase project, org and client id that actually hold the
 * client's users — so they also work for a client whose data lives in another project (data_project_key /
 * data_client_id), the same target the seat cap and notification settings use.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError, isUUID } from '../utils';
import { validatePassword } from '../middleware/security';
import { normalizeMobile, MOBILE_RE } from '../lib/userContact';
import { clearEmailProjectCache } from '../lib/projects';
import { clientGrantedModuleIds } from '../lib/entitlements';
import { readSeatCap, countActiveUsers, isStaffEmail, queueSeatCharge } from './clientBilling.service';
import { logger } from '../lib/logger';

/** The role a new client admin gets — the same one the client's first login has always had. */
export const CLIENT_ADMIN_ROLE = 'client';

/** Roles listed as a client's admins: `client`, plus older admin-tier rows bound to the client. */
export const CLIENT_ADMIN_ROLES = ['client', 'main_admin', 'admin'] as const;

/**
 * Whether a user row counts as one of the client's admins. Checked here, NOT as `.in('role', …)` in the query:
 * `users.role` is a Postgres enum whose values differ between projects (the Kinematic database has no `main_admin`),
 * and PostgREST rejects the whole query when a filter names a value the enum does not have.
 */
export const isClientAdminRole = (role: unknown): boolean =>
  (CLIENT_ADMIN_ROLES as readonly string[]).includes(String(role ?? '').toLowerCase());

/** Where a client's users live: the project's admin client, the org, and the client id inside that project. */
export interface ClientAdminTarget {
  admin: SupabaseClient;
  orgId: string;
  clientId: string;
  /** The project key holding the users (for the response, so the UI can say where the login lives). */
  project: string;
}

export interface NewClientAdmin {
  name: string;
  email: string;
  mobile: string | null;
  password: string;
}

export interface ClientAdminRow {
  id: string;
  name: string | null;
  email: string | null;
  mobile: string | null;
  role: string | null;
  is_active: boolean;
  created_at: string | null;
  /** The client's own contact login (the one created with the client). */
  is_primary: boolean;
  /** False for an admin bound to this client but stored in another org, so it cannot see the client's data. */
  in_client_org: boolean;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; code: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_COLS = 'id, name, email, mobile, role, is_active, created_at, org_id';

const fail = (message: string, code = 'VALIDATION_ERROR'): Parsed<never> => ({ ok: false, message, code });

/** Validate the "add admin" form. Pure, so the rules are unit-tested without a database. */
export function parseNewClientAdmin(body: unknown): Parsed<NewClientAdmin> {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return fail('Enter the admin’s name.');
  if (name.length > 120) return fail('The name is too long (120 characters at most).');
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email) return fail('Enter an email. Admins sign in to the dashboard with it.');
  if (!EMAIL_RE.test(email)) return fail('Enter a valid email address.');
  const mobile = normalizeMobile(b.mobile);
  if (mobile && !MOBILE_RE.test(mobile)) return fail('The mobile number must be exactly 10 digits.');
  const pw = validatePassword(b.password);
  if (!pw.ok) return fail((pw as { reason: string }).reason, 'WEAK_PASSWORD');
  return { ok: true, value: { name, email, mobile, password: b.password as string } };
}

/**
 * Why a new (or re-activated) admin would go over the client's seat cap, or null when it fits. Staff emails never
 * count toward the cap, the same rule assertActiveUserCap and the seat counter use.
 */
export function seatProblem(cap: number | null, active: number, email: string | null | undefined): string | null {
  if (cap == null || isStaffEmail(email)) return null;
  if (active < cap) return null;
  return `This client is using all ${cap} of its active-user seats. Raise Max Active Users on this client, or switch someone off, then try again.`;
}

const toRow = (r: Record<string, unknown>, target: ClientAdminTarget, primaryEmail?: string | null): ClientAdminRow => {
  const email = (r.email as string | null) ?? null;
  return {
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    email,
    mobile: (r.mobile as string | null) || null,
    role: (r.role as string | null) ?? null,
    is_active: r.is_active === true,
    created_at: (r.created_at as string | null) ?? null,
    is_primary: !!email && !!primaryEmail && email.toLowerCase() === primaryEmail.trim().toLowerCase(),
    in_client_org: r.org_id === target.orgId,
  };
};

/** The client's admins, oldest first. Soft-deleted users are left out, as in the user directory. */
export async function listClientAdmins(target: ClientAdminTarget, primaryEmail?: string | null): Promise<ClientAdminRow[]> {
  const { data, error } = await target.admin
    .from('users')
    .select(LIST_COLS)
    .eq('client_id', target.clientId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new AppError(500, `Could not load this client’s admins: ${error.message}`, 'DB_ERROR');
  return ((data || []) as Record<string, unknown>[])
    .filter((r) => isClientAdminRole(r.role))
    .map((r) => toRow(r, target, primaryEmail));
}

async function assertSeat(target: ClientAdminTarget, email: string | null | undefined): Promise<void> {
  const cap = await readSeatCap(target.admin, target.orgId);
  if (cap == null) return;
  const problem = seatProblem(cap, await countActiveUsers(target.admin, target.orgId), email);
  if (problem) throw new AppError(409, problem, 'SEAT_LIMIT');
}

/**
 * Create a client admin: a sign-in account plus a `users` row in the client's org, with the client's granted modules
 * mirrored onto it (what the client's first login gets). Any failure after the sign-in account exists undoes it, so a
 * refused create never leaves a half-made login behind.
 */
export async function createClientAdmin(target: ClientAdminTarget, input: NewClientAdmin): Promise<ClientAdminRow> {
  const { admin } = target;
  await assertSeat(target, input.email);

  const { data: byEmail } = await admin.from('users').select('id, name').eq('email', input.email).limit(1).maybeSingle();
  if (byEmail) {
    throw new AppError(409, `${input.email} is already used by ${(byEmail as { name?: string }).name || 'another user'}.`, 'DUPLICATE_ERROR');
  }
  if (input.mobile) {
    const { data: byMobile } = await admin.from('users').select('id, name')
      .eq('org_id', target.orgId).eq('mobile', input.mobile).limit(1).maybeSingle();
    if (byMobile) {
      throw new AppError(409, `Mobile ${input.mobile} is already used by ${(byMobile as { name?: string }).name || 'another user'} in this client.`, 'DUPLICATE_ERROR');
    }
  }

  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { name: input.name, mobile: input.mobile, role: CLIENT_ADMIN_ROLE },
  });
  if (authErr || !authData?.user) {
    const already = /already/i.test(authErr?.message || '');
    throw new AppError(
      already ? 409 : 400,
      already ? `An account with ${input.email} already exists. Use a different email.` : `Could not create the login: ${authErr?.message || 'no account returned'}`,
      already ? 'DUPLICATE_ERROR' : 'AUTH_ERROR',
    );
  }
  const id = authData.user.id;
  const undoAuth = async () => {
    try { await admin.auth.admin.deleteUser(id); }
    catch (e: any) { logger.warn(`[ClientAdmins] could not remove the sign-in account ${id} after a failed create: ${e?.message || e}`); }
  };

  const row = {
    id,
    org_id: target.orgId,
    client_id: target.clientId,
    name: input.name,
    email: input.email,
    mobile: input.mobile,
    role: CLIENT_ADMIN_ROLE,
    is_active: true,
  };
  let ins = await admin.from('users').insert(row).select(LIST_COLS).single();
  // A project where users.mobile is still NOT NULL takes '' (what the client's first login has always stored).
  if (ins.error?.code === '23502' && /mobile/i.test(ins.error.message || '') && row.mobile == null) {
    ins = await admin.from('users').insert({ ...row, mobile: '' }).select(LIST_COLS).single();
  }
  if (ins.error || !ins.data) {
    await undoAuth();
    if (ins.error?.code === '23505') throw new AppError(409, 'A user with this email or mobile number already exists.', 'DUPLICATE_ERROR');
    throw new AppError(500, `Could not create the admin: ${ins.error?.message || 'no row returned'}`, 'DB_ERROR');
  }

  const grants = await clientGrantedModuleIds(target.clientId, admin);
  if (grants.length) {
    const { error } = await admin.from('user_module_permissions').insert(grants.map((module_id) => ({ user_id: id, module_id })));
    if (error) {
      await admin.from('users').delete().eq('id', id);
      await undoAuth();
      throw new AppError(500, `Could not give the admin this client’s modules: ${error.message}`, 'DB_ERROR');
    }
  }

  // The email now lives in this project: drop any stale login-routing cache.
  clearEmailProjectCache(input.email);

  // A newly-created admin seat may be billed mid-cycle, pro-rated — see
  // clientBilling.service.ts. No-op for clients without a per-seat price set.
  await queueSeatCharge(target.clientId, id, input.name);

  return toRow(ins.data as Record<string, unknown>, target);
}

/**
 * Switch a client admin on or off. Only an admin of THIS client can be changed here; switching one back on counts
 * against the seat cap and clears a soft-delete, as updateUser does.
 */
export async function setClientAdminActive(
  target: ClientAdminTarget,
  userId: string,
  active: boolean,
  actorId: string | null | undefined,
  primaryEmail?: string | null,
): Promise<ClientAdminRow> {
  if (!isUUID(userId)) throw new AppError(404, 'Admin not found', 'NOT_FOUND');
  const { data: found, error } = await target.admin
    .from('users')
    .select(LIST_COLS)
    .eq('id', userId)
    .eq('client_id', target.clientId)
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!found || !isClientAdminRole((found as { role?: unknown }).role)) throw new AppError(404, 'Admin not found', 'NOT_FOUND');
  const current = found as Record<string, unknown>;
  if (!active && actorId && actorId === userId) throw new AppError(400, 'You cannot switch off your own login.', 'VALIDATION_ERROR');
  if (current.is_active === active) return toRow(current, target, primaryEmail);

  if (active) await assertSeat(target, current.email as string | null);
  const { data, error: upErr } = await target.admin
    .from('users')
    .update(active ? { is_active: true, deleted_at: null } : { is_active: false })
    .eq('id', userId)
    .eq('client_id', target.clientId)
    .select(LIST_COLS)
    .single();
  if (upErr || !data) throw new AppError(500, `Could not update the admin: ${upErr?.message || 'no row returned'}`, 'DB_ERROR');

  // A reactivated admin seat may be billed mid-cycle, pro-rated. The early
  // return above (current.is_active === active) already skips a no-op toggle.
  if (active) await queueSeatCharge(target.clientId, userId, (current.name as string | null) || 'Reactivated admin');

  return toRow(data as Record<string, unknown>, target, primaryEmail);
}

/**
 * Move an admin of this client into the client's org. Fixes an admin made through Settings → Users (POST /users),
 * which stamped the caller's org: bound to the client by client_id, but unable to see its data. Only the org changes.
 */
export async function moveClientAdminIntoClientOrg(
  target: ClientAdminTarget,
  userId: string,
  primaryEmail?: string | null,
): Promise<ClientAdminRow> {
  if (!isUUID(userId)) throw new AppError(404, 'Admin not found', 'NOT_FOUND');
  const { data: found, error } = await target.admin
    .from('users')
    .select(LIST_COLS)
    .eq('id', userId)
    .eq('client_id', target.clientId)
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!found || !isClientAdminRole((found as { role?: unknown }).role)) throw new AppError(404, 'Admin not found', 'NOT_FOUND');
  const current = found as Record<string, unknown>;
  if (current.org_id === target.orgId) return toRow(current, target, primaryEmail);

  // Moving an active admin into the client's org takes one of its seats.
  if (current.is_active === true) await assertSeat(target, current.email as string | null);
  const { data, error: upErr } = await target.admin
    .from('users')
    .update({ org_id: target.orgId })
    .eq('id', userId)
    .eq('client_id', target.clientId)
    .select(LIST_COLS)
    .single();
  if (upErr || !data) throw new AppError(500, `Could not move the admin: ${upErr?.message || 'no row returned'}`, 'DB_ERROR');
  return toRow(data as Record<string, unknown>, target, primaryEmail);
}
