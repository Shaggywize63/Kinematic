/**
 * Co-owners (additional owners) on a CRM lead / account / contact / deal.
 *
 * The record keeps its single PRIMARY owner on `<table>.owner_id` — that is unchanged and still drives
 * assignment, the hierarchy subtree and "my leads". A CO-owner is a peer who ALSO sees the record in
 * their lists and reports, without becoming the primary. They live in one shared table
 * (`crm_record_owners`, entity_type + entity_id) so the two questions the app asks —
 *   • "who co-owns this record?" (the detail chips)
 *   • "which records of type T do I co-own?" (fold into the list read-scope)
 * — are each one query.
 *
 * Rules kept here (not in the route): a co-owner must be a real user of the org; the record's own
 * primary `owner_id` is never stored as a co-owner (it would be redundant and would double-count in a
 * report); the set is replaced wholesale on a PUT (add the new, soft-delete the gone) so the caller
 * sends the list it wants and the table ends up matching it.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { assertAssigneesInOrg } from './activityExtras.service';

export type OwnerEntity = 'lead' | 'account' | 'contact' | 'deal';

const ENTITY_TABLE: Record<OwnerEntity, string> = {
  lead: 'crm_leads', account: 'crm_accounts', contact: 'crm_contacts', deal: 'crm_deals',
};

export function isOwnerEntity(v: unknown): v is OwnerEntity {
  return v === 'lead' || v === 'account' || v === 'contact' || v === 'deal';
}

export interface OwnerCtx {
  org_id: string;
  client_id?: string | null;
  user_id?: string | null;
}

export interface CoOwner {
  user_id: string;
  name: string | null;
}

/** The record's row (for its primary owner_id + client_id), or null when it isn't in the caller's org. */
async function loadRecord(orgId: string, entity: OwnerEntity, entityId: string): Promise<{ owner_id: string | null; client_id: string | null } | null> {
  const { data, error } = await supabaseAdmin.from(ENTITY_TABLE[entity])
    .select('owner_id, client_id').eq('org_id', orgId).eq('id', entityId).is('deleted_at', null).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data as { owner_id: string | null; client_id: string | null } | null) ?? null;
}

/** The co-owners of one record (primary first? no — primary is not here), each with the user's name. */
export async function listCoOwners(ctx: OwnerCtx, entity: OwnerEntity, entityId: string): Promise<CoOwner[]> {
  const { data, error } = await supabaseAdmin.from('crm_record_owners')
    .select('user_id').eq('org_id', ctx.org_id).eq('entity_type', entity).eq('entity_id', entityId).is('deleted_at', null);
  if (error) return [];
  const ids = Array.from(new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)));
  if (ids.length === 0) return [];
  const { data: users } = await supabaseAdmin.from('users').select('id, name, email').eq('org_id', ctx.org_id).in('id', ids);
  const byId = new Map(((users ?? []) as Array<{ id: string; name?: string | null; email?: string | null }>).map((u) => [u.id, u.name || u.email || null]));
  return ids.map((id) => ({ user_id: id, name: byId.get(id) ?? null }));
}

/**
 * Make `userIds` the record's full co-owner set. Validates every id is a user of the org, drops the
 * record's own primary owner from the set (it is already the owner), soft-deletes the co-owners no
 * longer listed and inserts the new ones. Returns the refreshed list so the caller renders from truth.
 */
export async function setCoOwners(ctx: OwnerCtx, entity: OwnerEntity, entityId: string, userIds: string[]): Promise<CoOwner[]> {
  const record = await loadRecord(ctx.org_id, entity, entityId);
  if (!record) throw new AppError(404, 'Record not found', 'NOT_FOUND');

  // De-dupe, drop blanks, and never store the primary owner as a co-owner.
  const wanted = Array.from(new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
    .filter((id) => id !== record.owner_id);
  await assertAssigneesInOrg(ctx.org_id, wanted);

  const { data: existingRows, error: readErr } = await supabaseAdmin.from('crm_record_owners')
    .select('id, user_id').eq('org_id', ctx.org_id).eq('entity_type', entity).eq('entity_id', entityId).is('deleted_at', null);
  if (readErr) throw new AppError(500, readErr.message, 'DB_ERROR');
  const existing = (existingRows ?? []) as Array<{ id: string; user_id: string }>;
  const have = new Set(existing.map((r) => r.user_id));
  const want = new Set(wanted);

  // Soft-delete the co-owners that are no longer wanted.
  const removeIds = existing.filter((r) => !want.has(r.user_id)).map((r) => r.id);
  if (removeIds.length) {
    const { error } = await supabaseAdmin.from('crm_record_owners').update({ deleted_at: new Date().toISOString() }).in('id', removeIds);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
  }

  // Insert the newly-added co-owners (skip ones already live).
  const toAdd = wanted.filter((id) => !have.has(id));
  if (toAdd.length) {
    const rows = toAdd.map((user_id) => ({
      org_id: ctx.org_id, client_id: record.client_id ?? ctx.client_id ?? null,
      entity_type: entity, entity_id: entityId, user_id, created_by: ctx.user_id ?? null,
    }));
    const { error } = await supabaseAdmin.from('crm_record_owners').insert(rows);
    // A race on the unique index (same co-owner added twice) is harmless — the row already exists.
    if (error && !/duplicate key|unique/i.test(error.message)) throw new AppError(500, error.message, 'DB_ERROR');
  }

  return listCoOwners(ctx, entity, entityId);
}

/**
 * The ids of records of one type that `userId` co-owns, for widening a list read-scope so a co-owner
 * sees the record in their own list. Empty (never throws) when the table is absent or nothing is co-owned.
 */
export async function coOwnedEntityIds(orgId: string, userId: string | null | undefined, entity: OwnerEntity): Promise<string[]> {
  if (!userId) return [];
  try {
    const { data, error } = await supabaseAdmin.from('crm_record_owners')
      .select('entity_id').eq('org_id', orgId).eq('entity_type', entity).eq('user_id', userId).is('deleted_at', null);
    if (error) return [];
    return Array.from(new Set(((data ?? []) as Array<{ entity_id: string }>).map((r) => r.entity_id)));
  } catch {
    return [];
  }
}
