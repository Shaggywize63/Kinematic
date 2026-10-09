/**
 * Notifications dispatch service — fans out unsent rows from
 * public.notifications via Firebase Cloud Messaging (mobile push).
 *
 * Android pushes are DATA-ONLY (title/body inside `data`; the app builds the alert). iOS goes over APNs.
 *
 * Called every minute by a pg_cron job → supabase edge function
 * `crm-dispatch-pushes` → /api/v1/cron/dispatch-pushes (this service).
 *
 * Stamps `sent_at` and `fcm_message_id` on success. When Firebase says the
 * token itself is dead ("registration-token-not-registered") we also null the
 * user's fcm_token so we stop trying; any other failure keeps the token (see
 * lib/fcmErrors) but still sets `sent_at` so the loop doesn't busy-retry the
 * same broken row forever.
 *
 * Source of work: the 5 cron-inserted reminder kinds
 * (crm_lead_stagnant / *_escalation / crm_deal_closing_soon /
 *  crm_deal_overdue / crm_task_overdue) PLUS any other notification
 * created with sent_at=NULL. So broadcast pushes, SOS alerts, etc.
 * funnel through the same delivery path.
 */
import { supabaseAdmin } from '../lib/supabase';
import { messaging } from '../lib/firebase';
import { sendApns, apnsEnabled } from '../lib/apns';
import { logger } from '../lib/logger';
import { routedData } from '../lib/notificationRoute';
import { classifyFcmError } from '../lib/fcmErrors';

export interface DispatchResult {
  scanned: number;
  sent: number;
  failed: number;
  skipped_no_token: number;
  firebase_disabled: boolean;
  /** True when Google rejected OUR service-account credential (not a user's token) for at least one send. */
  credential_error: boolean;
}

// FCM caps a message at 4 KB and rejects an oversized one with `invalid-argument`. That no longer clears the
// user's token (see lib/fcmErrors) but the push is still lost, so cap the text we copy into `data`.
const clip = (v: unknown, max: number): string => {
  const t = String(v ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

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
    .select('id, user_id, title, body, type, data')
    .is('sent_at', null)
    .gte('created_at', new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error(`[push.dispatch] query failed: ${error.message}`);
    return { scanned: 0, sent: 0, failed: 0, skipped_no_token: 0, firebase_disabled: !messaging, credential_error: false };
  }
  if (!rows || rows.length === 0) {
    return { scanned: 0, sent: 0, failed: 0, skipped_no_token: 0, firebase_disabled: !messaging, credential_error: false };
  }

  // Bulk-fetch the push tokens for all unique recipients in one query. A user
  // has either an Android FCM token or an iOS APNs token (cleared on the other
  // when they register — see updateFcmToken), so we route per row.
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, fcm_token, apns_token')
    .in('id', userIds);
  const tokenByUser = new Map<string, { fcm: string | null; apns: string | null }>(
    (users ?? []).map((u: any) => [u.id, { fcm: u.fcm_token, apns: u.apns_token }])
  );

  const now = new Date().toISOString();
  let sent = 0;
  let failed = 0;
  let skipped_no_token = 0;
  let credentialFailures = 0;

  for (const row of rows) {
    const tokens = tokenByUser.get(row.user_id) || { fcm: null, apns: null };

    // No usable transport (neither configured, or user has no token).
    const canFcm = !!tokens.fcm && !!messaging;
    const canApns = !!tokens.apns && apnsEnabled;
    if (!canFcm && !canApns) {
      skipped_no_token++;
      await supabaseAdmin.from('notifications').update({ sent_at: now }).eq('id', row.id);
      continue;
    }

    // Flat string-to-string data payload — shared by both transports. `kind` is
    // always present (see lib/notificationRoute.ts) so the app can route the tap.
    const dataPayload: Record<string, string> = { notification_id: row.id };
    for (const [k, v] of Object.entries(routedData(row))) {
      if (v === null || v === undefined) continue;
      dataPayload[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }

    try {
      if (canFcm) {
        // DATA-ONLY on purpose: no `notification` block. Android then always calls the app's
        // onMessageReceived, which builds the alert itself (its own channel, sound and tap routing)
        // whether the app is open, in the background or closed - instead of the system tray showing a
        // generic notification the app can't control. title/body ride in `data` for that. This FCM path
        // is Android-only (iOS goes direct over APNs, below). `priority: high` is what lets a data
        // message wake a dozing device.
        const messageId = await messaging!.send({
          token: tokens.fcm as string,
          data: { ...dataPayload, title: clip(row.title, 200), body: clip(row.body, 1000) },
          android: { priority: 'high' },
        });
        await supabaseAdmin
          .from('notifications')
          .update({ sent_at: now, fcm_message_id: messageId })
          .eq('id', row.id);
        sent++;
      } else {
        // iOS — direct APNs over HTTP/2.
        const r = await sendApns(tokens.apns as string, {
          title: row.title,
          body: row.body,
          data: dataPayload,
        });
        if (!r.ok && r.unregistered) {
          await supabaseAdmin.from('users').update({ apns_token: null }).eq('id', row.user_id);
        }
        if (!r.ok) {
          logger.warn(`[push.dispatch] APNs send failed for ${row.id}: ${r.status} ${r.reason || ''}`);
          failed++;
        } else {
          sent++;
        }
        await supabaseAdmin.from('notifications').update({ sent_at: now }).eq('id', row.id);
      }
    } catch (err: any) {
      const msg = String(err?.errorInfo?.code || err?.message || err);
      logger.warn(`[push.dispatch] FCM send failed for ${row.id}: ${msg}`);
      const failure = classifyFcmError(err);
      if (failure === 'credential') credentialFailures++;

      // Only a token Firebase says is dead is cleared (phone reset, app uninstalled, token replaced): it never
      // becomes valid again, so the user should stop counting as reachable. A rejected message, a rejected
      // server credential or an outage says nothing about the token — clearing it there silences the phone
      // until the app is next cold-started (see lib/fcmErrors).
      if (failure === 'dead-token') {
        await supabaseAdmin.from('users').update({ fcm_token: null }).eq('id', row.user_id);
      }

      // Always stamp sent_at so we don't busy-retry.
      await supabaseAdmin.from('notifications').update({ sent_at: now }).eq('id', row.id);
      failed++;
    }
  }

  if (credentialFailures > 0) {
    // One loud line per run (the per-row warnings above are easy to miss). The rows are still stamped
    // sent_at so a broken credential can't make the loop busy-retry, which means these pushes are lost.
    logger.error(
      `[push.dispatch] ${credentialFailures} push(es) NOT delivered: Google rejected the Firebase service-account credential ` +
      '(revoked, rotated, or for a different Firebase project than the Android app). Update FIREBASE_SERVICE_ACCOUNT.',
    );
  }

  return { scanned: rows.length, sent, failed, skipped_no_token, firebase_disabled: !messaging, credential_error: credentialFailures > 0 };
}
