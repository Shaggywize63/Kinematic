/**
 * Connected-B2B activity extras (Spark & Ray): several field executives on one activity, and a
 * "form serial" that links the activity to a filled form (e.g. SRPR2627-12).
 *
 * crm_activities.assigned_to stays the PRIMARY assignee, so every existing report, reminder and
 * calendar keeps working; crm_activity_assignees lists everyone assigned (primary included) so the
 * others can see, complete and be notified about the activity. See migration_account_journey.sql.
 *
 * Everything here is gated on isB2bClient (an in-memory check), so a tenant that has not run the
 * migration makes no extra database call and sees no behaviour change.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { isB2bClient } from '../../lib/b2bClients';
import { normalizeFormSerial } from '../../lib/formRef';
import { notifyUsers } from '../notify';

export const MAX_ASSIGNEES = 20;
/** Co-assigned activity ids folded into one PostgREST `.or()` (kept small: it travels in the URL). */
export const MAX_CO_ASSIGNED_IDS = 150;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid, de-duplicated, lower-cased user ids in the order given (the first is the primary assignee). */
export function normalizeAssigneeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const id = x.trim().toLowerCase();
    if (UUID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, MAX_ASSIGNEES);
}

/**
 * Ids of activities these users are assigned to through the assignee list (newest first, capped).
 * [] for any client outside the connected-B2B flow and on any lookup problem — never throws.
 */
export async function coAssignedActivityIds(
  orgId: string,
  clientId: string | null | undefined,
  userIds: string[],
): Promise<string[]> {
  if (!isB2bClient(clientId) || userIds.length === 0) return [];
  try {
    const { data, error } = await supabaseAdmin
      .from('crm_activity_assignees')
      .select('activity_id')
      .eq('org_id', orgId)
      .in('user_id', userIds)
      .order('created_at', { ascending: false })
      .limit(MAX_CO_ASSIGNED_IDS);
    if (error) return [];
    return Array.from(new Set((data ?? []).map((r: { activity_id: string }) => r.activity_id)));
  } catch {
    return [];
  }
}

/** Is one of `userIds` on this activity's assignee list? (Single-row access check.) */
export async function isCoAssignee(
  orgId: string,
  clientId: string | null | undefined,
  activityId: string,
  userIds: string[],
): Promise<boolean> {
  if (!isB2bClient(clientId) || !activityId || userIds.length === 0) return false;
  try {
    const { data } = await supabaseAdmin
      .from('crm_activity_assignees')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('activity_id', activityId)
      .in('user_id', userIds)
      .limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/** Every assignee must be a user of this org. */
export async function assertAssigneesInOrg(orgId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { data, error } = await supabaseAdmin.from('users').select('id').eq('org_id', orgId).in('id', ids);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if ((data ?? []).length !== ids.length) {
    throw new AppError(400, 'One or more assignees are not users of this organisation', 'VALIDATION');
  }
}

/**
 * Make `ids` the activity's full assignee list: add the new ones (and tell them), drop the removed
 * ones. Best-effort on the notification, strict on the data.
 */
export async function replaceActivityAssignees(args: {
  orgId: string;
  clientId: string | null;
  activityId: string;
  ids: string[];
  actorId?: string | null;
  subject?: string | null;
}): Promise<void> {
  const { orgId, clientId, activityId, ids, actorId, subject } = args;
  const { data: cur, error: curErr } = await supabaseAdmin
    .from('crm_activity_assignees').select('user_id').eq('activity_id', activityId);
  if (curErr) throw new AppError(500, curErr.message, 'DB_ERROR');
  const have = new Set((cur ?? []).map((r: { user_id: string }) => r.user_id));
  const want = new Set(ids);
  const toDelete = [...have].filter((u) => !want.has(u));
  const toAdd = ids.filter((u) => !have.has(u));
  if (toDelete.length) {
    const { error } = await supabaseAdmin.from('crm_activity_assignees')
      .delete().eq('activity_id', activityId).in('user_id', toDelete);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
  }
  if (toAdd.length) {
    const { error } = await supabaseAdmin.from('crm_activity_assignees').insert(
      toAdd.map((user_id) => ({ activity_id: activityId, user_id, org_id: orgId, client_id: clientId })),
    );
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    try {
      await notifyUsers(toAdd, {
        orgId,
        title: 'New activity assigned to you',
        body: (subject ?? '').trim() || 'You have been assigned an activity.',
        kind: 'crm_activity_assigned',
        data: { activity_id: activityId },
      }, { exclude: actorId ?? null });
    } catch (e) {
      logger.warn({ err: (e as Error)?.message }, 'activity assignees: notification failed (assignment saved)');
    }
  }
}

/** Adds `assignees: [{id, name}]` (primary first) to activities of connected-B2B clients. Never throws. */
export async function stampAssignees<T extends Record<string, any>>(rows: T[]): Promise<T[]> {
  const ids = rows.filter((r) => r?.id && isB2bClient(r.client_id)).map((r) => r.id as string);
  if (!ids.length) return rows;
  try {
    const { data } = await supabaseAdmin.from('crm_activity_assignees').select('activity_id, user_id').in('activity_id', ids);
    const byActivity = new Map<string, string[]>();
    for (const r of (data ?? []) as Array<{ activity_id: string; user_id: string }>) {
      const list = byActivity.get(r.activity_id) ?? [];
      list.push(r.user_id);
      byActivity.set(r.activity_id, list);
    }
    const primaries = rows.filter((r) => byActivity.has(r.id) && r.assigned_to).map((r) => r.assigned_to as string);
    const userIds = Array.from(new Set([...Array.from(byActivity.values()).flat(), ...primaries]));
    const names = new Map<string, string>();
    if (userIds.length) {
      const { data: us } = await supabaseAdmin.from('users').select('id, name, email').in('id', userIds);
      for (const u of (us ?? []) as Array<{ id: string; name?: string | null; email?: string | null }>) {
        names.set(u.id, u.name || u.email || '');
      }
    }
    return rows.map((r) => {
      const list = byActivity.get(r.id);
      if (!list) return r;
      const primary = r.assigned_to as string | null | undefined;
      // The primary always leads (an older app may have changed assigned_to without touching the list).
      const ordered = primary ? [primary, ...list.filter((u) => u !== primary)] : list;
      return { ...r, assignees: ordered.map((id) => ({ id, name: names.get(id) ?? null })) };
    });
  } catch {
    return rows;
  }
}

/**
 * The filled form a form serial (e.g. "SRPR2627-12") points at, within this org (and client, when known).
 * Throws a 400 the app can show when no such form exists.
 */
export async function resolveFormSerial(
  orgId: string,
  clientId: string | null,
  serial: string,
): Promise<{ id: string; ref_no: string }> {
  const norm = normalizeFormSerial(serial);
  if (!norm) throw new AppError(400, `"${serial}" is not a valid form serial (expected e.g. SRPR2627-12)`, 'VALIDATION');
  let q = supabaseAdmin.from('form_submissions').select('id, ref_no').eq('org_id', orgId).eq('ref_no', norm);
  if (clientId) q = q.eq('client_id', clientId);
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(400, `No filled form with serial ${norm}`, 'VALIDATION');
  return { id: (data as { id: string }).id, ref_no: (data as { ref_no: string }).ref_no };
}

/**
 * Applies the connected-B2B activity extras to a validated create/patch payload (mutating it) and returns the
 * assignee list to store afterwards (undefined = not mentioned). For every other client the extras are dropped,
 * so their insert is byte-identical to before.
 *  - assignee_ids  -> assigned_to (first = primary) + the assignee list
 *  - form_serial   -> form_submission_id ('' / null clears it)
 *  - product_ids   -> kept as a column value
 */
export async function applyActivityExtras(args: {
  orgId: string;
  clientId: string | null;
  payload: Record<string, unknown>;
}): Promise<string[] | undefined> {
  const { orgId, clientId, payload } = args;
  const assigneeRaw = payload.assignee_ids;
  const serialRaw = payload.form_serial;
  delete payload.assignee_ids;
  delete payload.form_serial;
  if (!isB2bClient(clientId)) {
    delete payload.product_ids;
    return undefined;
  }
  if (serialRaw !== undefined) {
    const s = typeof serialRaw === 'string' ? serialRaw.trim() : '';
    payload.form_submission_id = s ? (await resolveFormSerial(orgId, clientId, s)).id : null;
  }
  if (assigneeRaw === undefined) return undefined;
  const ids = normalizeAssigneeIds(assigneeRaw);
  await assertAssigneesInOrg(orgId, ids);
  payload.assigned_to = ids[0] ?? null;
  return ids;
}
