/**
 * Notifications dispatch service — fans out unsent rows from
 * public.notifications via Firebase Cloud Messaging (mobile push).
 *
 * Called every minute by a pg_cron job → supabase edge function
 * `crm-dispatch-pushes` → /api/v1/cron/dispatch-pushes (this service).
 *
 * Stamps `sent_at` and `fcm_message_id` on success. On a
 * "registration-token-not-registered" failure we also null the user's
 * fcm_token so we stop trying. Other failures still set `sent_at` so
 * the loop doesn't busy-retry the same broken row forever.
 *
 * Source of work: the 5 cron-inserted reminder kinds
 * (crm_lead_stagnant / *_escalation / crm_deal_closing_soon /
 *  crm_deal_overdue / crm_task_overdue) PLUS any other notification
 * created with sent_at=NULL. So broadcast pushes, SOS alerts, etc.
 * funnel through the same delivery path.
 */
import { supabaseAdmin } from '../lib/supabase';
import { messaging } from '../lib/firebase';
import { logger } from '../lib/logger';

export interface DispatchResult {
  scanned: number;
  sent: number;
  failed: number;
  skipped_no_token: number;
  firebase_disabled: boolean;
}

export async function dispatchPendingPushes(opts?: {
  limit?: number;
  max_age_hours?: number;
}): Promise<DispatchResult> {
  const limit = opts?.limit ?? 200;
  const maxAgeHours = opts?.max_age_hours ?? 6;

  // Pull pending rows. We bound by max_age so a broken send doesn't
  // resurrect 30-day-old notifications.
  const { data: rows, error } = await supabaseAdmin
    .from('notifications')
    .select('id, user_id, title, body, data')
    .is('sent_at', null)
    .gte('created_at', new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error(`[push.dispatch] query failed: ${error.message}`);
    return { scanned: 0, sent: 0, failed: 0, skipped_no_token: 0, firebase_disabled: !messaging };
  }
  if (!rows || rows.length === 0) {
    return { scanned: 0, sent: 0, failed: 0, skipped_no_token: 0, firebase_disabled: !messaging };
  }

  // Bulk-fetch fcm_token + name for all unique recipients in one query.
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, fcm_token')
    .in('id', userIds);
  const tokenByUser = new Map<string, string | null>((users ?? []).map((u: any) => [u.id, u.fcm_token]));

  const now = new Date().toISOString();
  let sent = 0;
  let failed = 0;
  let skipped_no_token = 0;

  for (const row of rows) {
    const token = tokenByUser.get(row.user_id) || null;

    if (!token) {
      skipped_no_token++;
      await supabaseAdmin.from('notifications').update({ sent_at: now }).eq('id', row.id);
      continue;
    }
    if (!messaging) {
      // Firebase Admin SDK isn't initialized (FIREBASE_SERVICE_ACCOUNT
      // env var missing). Mark the row sent so we don't loop, log once.
      await supabaseAdmin.from('notifications').update({ sent_at: now }).eq('id', row.id);
      continue;
    }

    try {
      // FCM data payload must be flat string-to-string. Convert each value
      // explicitly so jsonb objects don't choke the SDK.
      const dataPayload: Record<string, string> = { notification_id: row.id };
      if (row.data && typeof row.data === 'object') {
        for (const [k, v] of Object.entries(row.data as Record<string, unknown>)) {
          if (v === null || v === undefined) continue;
          dataPayload[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }

      const messageId = await messaging.send({
        token,
        notification: { title: row.title, body: row.body },
        data: dataPayload,
        // High priority so the device wakes screen for stagnant-lead nudges.
        android: { priority: 'high' },
        // APNs sound so iOS plays the default alert tone.
        apns: { payload: { aps: { sound: 'default' } } },
      });

      await supabaseAdmin
        .from('notifications')
        .update({ sent_at: now, fcm_message_id: messageId })
        .eq('id', row.id);
      sent++;
    } catch (err: any) {
      const msg = String(err?.errorInfo?.code || err?.message || err);
      logger.warn(`[push.dispatch] FCM send failed for ${row.id}: ${msg}`);

      // Invalid / unregistered tokens never become valid again — null
      // them on the user row so subsequent dispatches stop counting the
      // user as reachable. This catches phone resets, app uninstalls,
      // and stale-token cases.
      if (
        msg.includes('registration-token-not-registered') ||
        msg.includes('invalid-argument') ||
        msg.includes('not-found') ||
        msg.includes('mismatched-credential')
      ) {
        await supabaseAdmin.from('users').update({ fcm_token: null }).eq('id', row.user_id);
      }

      // Always stamp sent_at so we don't busy-retry.
      await supabaseAdmin.from('notifications').update({ sent_at: now }).eq('id', row.id);
      failed++;
    }
  }

  return { scanned: rows.length, sent, failed, skipped_no_token, firebase_disabled: !messaging };
}
