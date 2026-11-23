/**
 * WhatsApp Embedded Signup — lets a client connect their own WhatsApp
 * Business number through Meta's own hosted signup UI (phone verification,
 * WABA creation/selection, the works) instead of hand-typing a Phone Number
 * ID / WABA ID / access token into Settings → WhatsApp.
 *
 * This is a DIFFERENT OAuth shape from Lead Ads (metaOAuth.service.ts):
 * the `code` comes from the Facebook JS SDK's FB.login() popup, not a
 * server-side redirect, so the exchange takes NO redirect_uri — passing one
 * (even reusing Lead Ads' redirect_uri) would mismatch and fail the
 * exchange. Kept as its own small function rather than sharing Lead Ads'
 * exchangeCodeForUserToken for exactly that reason.
 *
 * phone_number_id / waba_id come from the embedded signup flow itself (the
 * dashboard listens for the WA_EMBEDDED_SIGNUP postMessage event and sends
 * them along with the code) — Meta's docs document this as the reliable way
 * to get them, rather than re-deriving them from the token.
 */
import { upsertConnection, getConnection } from '../crm/whatsappConnection.service';
import { GRAPH_VERSION } from '../crm/providers/cloudApiWhatsapp.provider';
import { logger } from '../../lib/logger';

const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function appId(): string {
  const v = process.env.META_APP_ID;
  if (!v) throw new Error('META_APP_ID is not configured');
  return v;
}
function appSecret(): string {
  const v = process.env.META_APP_SECRET;
  if (!v) throw new Error('META_APP_SECRET is not configured');
  return v;
}

export function isConfigured(): boolean {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_WHATSAPP_CONFIG_ID);
}

/** Public (non-secret) config the dashboard needs to call FB.login() —
 *  the App ID and the Embedded Signup Configuration ID. Neither is a
 *  credential (the App Secret never reaches the client), but both still
 *  come from the backend so there's one source of truth instead of a
 *  second NEXT_PUBLIC_ env copy that can drift. */
export function publicConfig(): { app_id: string; config_id: string } | null {
  if (!isConfigured()) return null;
  return { app_id: process.env.META_APP_ID!, config_id: process.env.META_WHATSAPP_CONFIG_ID! };
}

interface FbTokenResponse { access_token: string }
interface FbErrorResponse { error?: { message?: string } }

async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const params = new URLSearchParams({ client_id: appId(), client_secret: appSecret(), code });
  const r = await fetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
  const j = await r.json() as FbTokenResponse & FbErrorResponse;
  if (!r.ok || j.error || !j.access_token) {
    throw new Error(`WhatsApp embedded-signup code exchange failed: ${j.error?.message ?? r.status}`);
  }
  return j.access_token;
}

/** Same long-lived exchange Lead Ads uses — a long-lived USER token here
 *  (unlike a Page token) still expires in ~60 days. Documented limitation,
 *  not fixed in v1: there's no refresh job yet, so a connection made this
 *  way needs reconnecting roughly every 2 months. A future iteration could
 *  exchange for a non-expiring System User token instead (needs the WABA
 *  to be shared into a Business Manager system user, a heavier flow) —
 *  tracked, not blocking this from shipping. */
async function exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId(),
    client_secret: appSecret(),
    fb_exchange_token: shortLivedToken,
  });
  const r = await fetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
  const j = await r.json() as FbTokenResponse & FbErrorResponse;
  if (!r.ok || j.error || !j.access_token) {
    throw new Error(`WhatsApp long-lived token exchange failed: ${j.error?.message ?? r.status}`);
  }
  return j.access_token;
}

/** Turn on inbound message delivery to Kinematic's existing WhatsApp
 *  webhook for this WABA. Idempotent. */
async function subscribeWabaToApp(wabaId: string, accessToken: string): Promise<void> {
  const r = await fetch(`${GRAPH_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = await r.json() as { success?: boolean } & FbErrorResponse;
  if (!r.ok || j.error || j.success !== true) {
    throw new Error(`WABA subscribe failed: ${j.error?.message ?? r.status}`);
  }
}

export interface CompleteEmbeddedSignupResult {
  phone_number_id: string;
  waba_id: string;
  connection: Awaited<ReturnType<typeof getConnection>>;
}

export async function completeEmbeddedSignup(
  org_id: string,
  user_id: string | null,
  code: string,
  phone_number_id: string,
  waba_id: string,
): Promise<CompleteEmbeddedSignupResult> {
  if (!phone_number_id || !waba_id) {
    throw new Error('Missing phone_number_id or waba_id from the signup flow');
  }
  const shortLived = await exchangeEmbeddedSignupCode(code);
  const longLived = await exchangeForLongLivedToken(shortLived);

  await subscribeWabaToApp(waba_id, longLived);

  const connection = await upsertConnection(org_id, {
    connection_type: 'cloud_api',
    phone_number_id,
    waba_id,
    access_token: longLived,
    is_active: true,
    updated_by: user_id,
  });

  logger.info({ org_id, phone_number_id, waba_id }, '[whatsapp] embedded signup completed');
  return { phone_number_id, waba_id, connection };
}
