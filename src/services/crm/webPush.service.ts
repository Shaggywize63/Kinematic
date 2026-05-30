/**
 * Web Push fan-out using VAPID + the `web-push` library.
 *
 * Subscriptions live in public.web_push_subscriptions; we insert/upsert
 * on browser opt-in and prune dead endpoints when web-push returns a
 * 404/410 (the subscription was revoked by the browser).
 *
 * VAPID keys must be in the env as VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY.
 * If they aren't set, sendPushToUsers becomes a no-op (so dev environments
 * without keys don't crash on every mention).
 */
import webpush from 'web-push';
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const prv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@kinematicapp.com';
  if (!pub || !prv) return false;
  try {
    webpush.setVapidDetails(subject, pub, prv);
    configured = true;
    return true;
  } catch (e) {
    logger.warn(`VAPID configure failed: ${(e as Error).message}`);
    return false;
  }
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  if (userIds.length === 0) return;
  if (!configure()) return; // VAPID not set → silently skip in dev

  const { data: subs } = await supabaseAdmin
    .from('web_push_subscriptions')
    .select('id, endpoint, p256dh, auth, user_id')
    .in('user_id', userIds);
  if (!subs || subs.length === 0) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url || '/dashboard',
    tag: payload.tag,
  });

  // Track dead subscriptions for cleanup so we don't keep retrying
  // endpoints the browser has already revoked.
  const dead: string[] = [];
  await Promise.all(
    subs.map(async (s: any) => {
      const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(subscription, body);
        // Touch last_used_at so we can later prune zombie subscriptions.
        void supabaseAdmin.from('web_push_subscriptions').update({ last_used_at: new Date().toISOString() }).eq('id', s.id);
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          dead.push(s.id);
        } else {
          logger.warn(`web-push send failed [${code}]: ${e?.message || e}`);
        }
      }
    }),
  );
  if (dead.length > 0) {
    await supabaseAdmin.from('web_push_subscriptions').delete().in('id', dead);
  }
}

export async function registerSubscription(
  user_id: string,
  org_id: string,
  endpoint: string,
  p256dh: string,
  auth: string,
  user_agent?: string,
): Promise<void> {
  // Upsert on endpoint — browsers re-issue the same endpoint for the same
  // device/profile, so a re-grant should refresh keys not create dupes.
  const { error } = await supabaseAdmin
    .from('web_push_subscriptions')
    .upsert(
      { user_id, org_id, endpoint, p256dh, auth, user_agent: user_agent || null, last_used_at: new Date().toISOString() },
      { onConflict: 'endpoint' },
    );
  if (error) throw new Error(error.message);
}

export async function unregisterSubscription(user_id: string, endpoint: string): Promise<void> {
  await supabaseAdmin.from('web_push_subscriptions').delete().eq('user_id', user_id).eq('endpoint', endpoint);
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}
