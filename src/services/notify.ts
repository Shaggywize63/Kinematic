/**
 * Shared notification creator.
 *
 * The whole system works by INSERTING a row into public.notifications with
 * sent_at = NULL; the per-minute `dispatch-pushes` cron then fans unsent rows
 * out to FCM (Android) / APNs (iOS) and the in-app bell reads the same table.
 * This helper is the single, safe way to create one.
 *
 * Reliability choices (deliberate):
 *  - `type` defaults to 'general', a value guaranteed to exist in the
 *    `notification_type` enum on every tenant DB. Adding a brand-new enum value
 *    makes inserts fail SILENTLY on any DB that hasn't had the ALTER TYPE
 *    applied (this previously dropped `security_alert` / `daily_briefing`
 *    notifications). We categorise via `data.kind` instead, which the mobile
 *    clients already switch on for deep-linking — so a new notification kind
 *    never needs a schema change and never silently drops.
 *  - Best-effort: a failed insert is logged, never thrown, so a notification
 *    can never break the business action that triggered it.
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';

export interface NotifyInput {
  orgId: string | null | undefined;
  userId: string | null | undefined;
  title: string;
  body: string;
  /** Routing key stored at data.kind — the mobile clients deep-link on this. */
  kind: string;
  /** Extra deep-link ids merged into data (e.g. { lead_id, deal_id }). */
  data?: Record<string, unknown>;
  /** notification_type enum value; keep 'general' unless the value is known-present. */
  type?: string;
}

function rowFor(orgId: string, userId: string, n: Omit<NotifyInput, 'orgId' | 'userId'>) {
  return {
    org_id: orgId,
    user_id: userId,
    title: n.title,
    body: n.body,
    type: n.type ?? 'general',
    data: { kind: n.kind, ...(n.data || {}) },
    is_read: false,
    sent_at: null,
  };
}

/** Create one notification for one recipient. No-op on missing ids. */
export async function notify(n: NotifyInput): Promise<void> {
  if (!n.orgId || !n.userId) return;
  try {
    await supabaseAdmin.from('notifications').insert(rowFor(n.orgId, n.userId, n));
  } catch (e: any) {
    logger.error(`[notify] insert failed (kind=${n.kind}): ${e?.message || e}`);
  }
}

/** Create the same notification for many recipients (deduped, self-excluded optional). */
export async function notifyUsers(
  userIds: Array<string | null | undefined>,
  n: Omit<NotifyInput, 'userId'>,
  opts?: { exclude?: string | null },
): Promise<void> {
  if (!n.orgId) return;
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== opts?.exclude))];
  if (!ids.length) return;
  try {
    await supabaseAdmin.from('notifications').insert(ids.map((uid) => rowFor(n.orgId as string, uid, n)));
  } catch (e: any) {
    logger.error(`[notify] bulk insert failed (kind=${n.kind}): ${e?.message || e}`);
  }
}

/**
 * Resolve the org's supervisor/admin recipients for team-level alerts (missed
 * visit, location-off, stock/expiry, etc.). Prefers a specific supervisor id,
 * else falls back to active admins/managers in the org. Best-effort.
 */
export async function resolveManagers(
  orgId: string,
  opts?: { supervisorId?: string | null; clientId?: string | null; roles?: string[] },
): Promise<string[]> {
  const out = new Set<string>();
  if (opts?.supervisorId) out.add(opts.supervisorId);
  const roles = (opts?.roles ?? ['admin', 'super_admin', 'main_admin', 'sub_admin', 'client', 'manager', 'city_manager', 'supervisor'])
    .map((r) => r.toLowerCase());
  try {
    let q = supabaseAdmin.from('users').select('id, role, client_id').eq('org_id', orgId).eq('is_active', true).limit(200);
    if (opts?.clientId) q = q.or(`client_id.eq.${opts.clientId},client_id.is.null`);
    const { data } = await q;
    for (const u of (data ?? []) as any[]) {
      if (roles.includes((u.role ?? '').toLowerCase())) out.add(u.id);
    }
  } catch (e: any) {
    logger.error(`[notify] resolveManagers failed: ${e?.message || e}`);
  }
  return [...out];
}
