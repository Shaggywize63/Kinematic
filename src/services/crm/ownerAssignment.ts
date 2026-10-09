/**
 * Who may choose a lead's owner.
 *
 * Opt-in per client, by data: `crm_settings.config.lead_form.owner_assignment = 'admin_only'`. A client
 * without it (Tata included) is untouched: every function here answers "allowed" without changing a thing,
 * and the pre-existing role rule in crm.routes.ts (`sanitizeOwnerId`) keeps applying exactly as before.
 *
 * With 'admin_only', a person who is NOT an admin cannot pick or change a lead's owner. "Admin" is the
 * expenses module's `isApprover` (admin / super_admin / main_admin / org_admin / sub_admin / client, and
 * never an own-scope field exec on a flat tenant), the same notion the targets and odometer endpoints use.
 * The CRM has an older role list for assignment (OWNER_ASSIGN_ROLES in crm.routes.ts: it also admits
 * supervisors and city managers, and omits org_admin) but that list is a H-2 mass-assignment guard, not a
 * product rule, and has no notion of data scope; under this switch the admin rule is the one that decides,
 * and the old guard still runs afterwards so the switch can only ever restrict.
 *
 * What it governs is a PERSON choosing an owner: the lead form, a lead edit, bulk assign, a CSV import with an
 * owner column, the marketing-visit "new lead", an assistant (KINI / MCP) reassigning. What it never governs
 * is the server doing it: assignment rules and round-robin, automations and workflows, webhook and chatbot
 * inbound leads. Those call createLead / assignOwner themselves and never pass through these guards.
 *
 * Failure mode: if the settings row cannot be read the switch is treated as OFF (and a warning logged). This
 * is a product rule rather than a security boundary, and failing closed would take lead edits down for every
 * client whenever the settings read hiccups.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils';
import { Actor, isApprover } from '../expenses/access';
import { loadLeadFormConfig, isAdminOnlyOwnerAssignment } from './leadFormConfig';

export const OWNER_ASSIGN_FORBIDDEN = 'OWNER_ASSIGN_FORBIDDEN';
export const OWNER_ASSIGN_FORBIDDEN_MESSAGE = 'Only an admin can assign leads';

/** The 403 every refused owner choice answers with. */
export const ownerAssignForbidden = (): AppError => new AppError(403, OWNER_ASSIGN_FORBIDDEN_MESSAGE, OWNER_ASSIGN_FORBIDDEN);

/** Does this client restrict owner choice to admins? Read failure => false (see the header). */
export async function adminOnlyOwnerAssignment(org_id: string, client_id: string | null): Promise<boolean> {
  try {
    return isAdminOnlyOwnerAssignment(await loadLeadFormConfig(org_id, client_id));
  } catch (e) {
    logger.warn(`[owner-assignment] lead_form config unavailable, treating owner assignment as unrestricted: ${(e as Error).message}`);
    return false;
  }
}

/** Pure rule: with the switch on, only an admin may choose an owner; with it off, everyone as before. */
export function canChooseOwner(adminOnly: boolean, actor: Actor): boolean {
  return !adminOnly || isApprover(actor);
}

/** May this person choose / change a lead's owner? (An admin is always allowed, so no settings read for them.) */
export async function mayChooseOwner(actor: Actor): Promise<boolean> {
  if (isApprover(actor)) return true;
  return canChooseOwner(await adminOnlyOwnerAssignment(actor.org_id, actor.client_id ?? null), actor);
}

/** Refuse (403 OWNER_ASSIGN_FORBIDDEN) unless this person may choose owners. For endpoints whose whole job is assigning. */
export async function assertMayChooseOwner(actor: Actor): Promise<void> {
  if (!(await mayChooseOwner(actor))) throw ownerAssignForbidden();
}

/**
 * Create paths: a person who may not choose the owner has any `owner_id` they sent ignored, so the lead gets
 * the normal default (assignment rules, else the creator, else the org default owner). Returns true when it
 * dropped one. Mutates `payload`.
 */
export async function dropOwnerUnlessAllowed(actor: Actor, payload: object): Promise<boolean> {
  if (!payload || !('owner_id' in payload)) return false;
  if (await mayChooseOwner(actor)) return false;
  delete (payload as Record<string, unknown>).owner_id;
  return true;
}

const sameOwner = (a: unknown, b: unknown): boolean =>
  (a == null || a === '') ? (b == null || b === '') : (typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase());

/**
 * Update paths: a person who may not choose owners cannot change a lead's owner. Apps often resend the
 * whole object, so an `owner_id` equal to the lead's current owner is not a change: it is dropped from the
 * payload and the update goes ahead. A different one is refused (403 OWNER_ASSIGN_FORBIDDEN). A lead that
 * does not exist is left for the update itself to 404. Mutates `payload`.
 */
export async function guardOwnerChange(actor: Actor, leadId: string, payload: object): Promise<void> {
  const requested = (payload as Record<string, unknown> | null)?.owner_id;
  if (!payload || !('owner_id' in payload) || requested === undefined) return;
  if (await mayChooseOwner(actor)) return;
  const { data } = await supabaseAdmin.from('crm_leads').select('owner_id')
    .eq('org_id', actor.org_id).eq('id', leadId).is('deleted_at', null).maybeSingle();
  if (!data) return;
  if (sameOwner((data as { owner_id?: string | null }).owner_id, requested)) {
    delete (payload as Record<string, unknown>).owner_id;
    return;
  }
  throw ownerAssignForbidden();
}
