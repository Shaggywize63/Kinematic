/**
 * Meta (Facebook) connect flows for the Kinematic app:
 *   - WhatsApp Embedded Signup: the dashboard runs FB.login with the Embedded
 *     Signup config, then posts the returned `code` + waba_id + phone_number_id
 *     here. We exchange the code for a business token, subscribe the app to the
 *     WABA and save the org's Cloud API connection.
 *   - Lead Ads: Facebook Login for Business `code` -> long-lived user token ->
 *     the Pages the user manages -> subscribe a chosen Page to `leadgen` and
 *     create a `meta_lead_ads` integration with the Page token in the vault.
 *
 * Secrets: META_APP_ID / META_APP_SECRET come from the environment (inject them
 * into the ECS task definition by reference to AWS Secrets Manager — never log
 * or return them).
 */
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils';
import { GRAPH_VERSION } from '../crm/providers/cloudApiWhatsapp.provider';
import { upsertConnection, testConnection, syncTemplates } from '../crm/whatsappConnection.service';
import { storeCredentials } from '../crm/integrations/credentialsVault';

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function metaConfig() {
  return {
    app_id: process.env.META_APP_ID || null,
    graph_version: GRAPH_VERSION,
    whatsapp_config_id: process.env.META_WA_CONFIG_ID || null,
    lead_ads_config_id: process.env.META_LEAD_CONFIG_ID || null,
    configured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
  };
}

function creds(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new AppError(500, 'Meta app is not configured on the server', 'META_NOT_CONFIGURED');
  return { appId, appSecret };
}

async function graph<T = any>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, { ...init, headers });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    // Meta error bodies never contain our secret, but keep the log to code+message only.
    logger.warn({ status: res.status, code: json?.error?.code, msg: json?.error?.message }, 'meta graph call failed');
    throw new AppError(502, json?.error?.message || `Meta API error (${res.status})`, 'META_GRAPH_ERROR');
  }
  return json as T;
}

/** Exchange an OAuth / Embedded Signup `code` for an access token. */
async function exchangeCode(code: string): Promise<string> {
  const { appId, appSecret } = creds();
  const qs = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  const j = await graph<{ access_token: string }>(`/oauth/access_token?${qs.toString()}`);
  if (!j.access_token) throw new AppError(502, 'Meta did not return an access token', 'META_NO_TOKEN');
  return j.access_token;
}

/** Swap a short-lived user token for a ~60-day one. */
async function longLived(token: string): Promise<string> {
  const { appId, appSecret } = creds();
  const qs = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token });
  const j = await graph<{ access_token: string }>(`/oauth/access_token?${qs.toString()}`);
  return j.access_token || token;
}

// ── WhatsApp Embedded Signup ────────────────────────────────────────────────
export async function completeWhatsappSignup(org_id: string, user_id: string, input: { code: string; waba_id: string; phone_number_id: string }) {
  const { code, waba_id, phone_number_id } = input;
  if (!code || !waba_id || !phone_number_id) throw new AppError(400, 'code, waba_id and phone_number_id are required', 'BAD_INPUT');

  const token = await exchangeCode(code);

  // Subscribe our app to the customer's WABA so message/status webhooks reach us.
  await graph(`/${encodeURIComponent(waba_id)}/subscribed_apps`, { method: 'POST', token });

  const phone = await graph<{ verified_name?: string; display_phone_number?: string }>(
    `/${encodeURIComponent(phone_number_id)}?fields=verified_name,display_phone_number`, { token });

  await upsertConnection(org_id, {
    connection_type: 'cloud_api',
    phone_number_id,
    waba_id,
    from_phone: phone.display_phone_number ?? null,
    display_name: phone.verified_name ?? null,
    access_token: token,
    is_active: true,
    updated_by: user_id,
  });

  const test = await testConnection(org_id);
  let templates: number | null = null;
  try { templates = (await syncTemplates(org_id)).synced; } catch (e: any) { logger.warn(`[meta] template sync skipped: ${e?.message || e}`); }
  return { connected: test.ok, detail: test.detail, display_phone_number: phone.display_phone_number ?? null, verified_name: phone.verified_name ?? null, templates_synced: templates };
}

// ── Lead Ads ────────────────────────────────────────────────────────────────
export async function listLeadAdPages(code: string) {
  const user = await longLived(await exchangeCode(code));
  const j = await graph<{ data: Array<{ id: string; name: string; access_token: string }> }>('/me/accounts?fields=id,name,access_token&limit=100', { token: user });
  // Page tokens stay server-side: hand the client a short-lived signed handle instead.
  const { appSecret } = creds();
  const payload = Buffer.from(JSON.stringify({ t: user, exp: Date.now() + 10 * 60_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', appSecret).update(payload).digest('base64url');
  return { pages: (j.data || []).map((p) => ({ id: p.id, name: p.name })), handle: `${payload}.${sig}` };
}

function openHandle(handle: string): string {
  const [payload, sig] = String(handle || '').split('.');
  const { appSecret } = creds();
  const want = crypto.createHmac('sha256', appSecret).update(payload || '').digest('base64url');
  const a = Buffer.from(sig || ''), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AppError(400, 'Invalid or expired handle', 'BAD_HANDLE');
  const { t, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (!t || Date.now() > exp) throw new AppError(400, 'Invalid or expired handle', 'BAD_HANDLE');
  return t as string;
}

export async function connectLeadAdPage(org_id: string, user_id: string, client_id: string | null, input: { handle: string; page_id: string; label?: string }) {
  const { appSecret } = creds();
  const userToken = openHandle(input.handle);
  const pages = await graph<{ data: Array<{ id: string; name: string; access_token: string }> }>('/me/accounts?fields=id,name,access_token&limit=100', { token: userToken });
  const page = (pages.data || []).find((p) => p.id === input.page_id);
  if (!page) throw new AppError(404, 'Page not found for this Facebook user', 'PAGE_NOT_FOUND');

  await graph(`/${encodeURIComponent(page.id)}/subscribed_apps?subscribed_fields=leadgen`, { method: 'POST', token: page.access_token });

  const label = input.label?.trim() || page.name;
  const { data: source, error: sErr } = await supabaseAdmin.from('crm_lead_sources')
    .insert({ org_id, name: `Meta Lead Ads — ${label}`, created_by: user_id, client_id }).select('id').single();
  if (sErr || !source) throw new AppError(400, `Failed to create lead source: ${sErr?.message}`, 'SOURCE_FAILED');

  const { data: integ, error: iErr } = await supabaseAdmin.from('crm_lead_source_integrations')
    .insert({
      org_id, provider: 'meta_lead_ads', label, source_id: (source as any).id, status: 'active',
      config: { page_id: page.id, page_name: page.name, verify_token: crypto.randomBytes(16).toString('hex'), connected_via: 'oauth' },
      webhook_secret: crypto.randomBytes(24).toString('base64url'), created_by: user_id, client_id,
    }).select('id').single();
  if (iErr || !integ) {
    await supabaseAdmin.from('crm_lead_sources').delete().eq('id', (source as any).id);
    throw new AppError(400, `Failed to create integration: ${iErr?.message}`, 'INTEGRATION_FAILED');
  }
  await storeCredentials((integ as any).id, { app_secret: appSecret, page_access_token: page.access_token });
  return { integration_id: (integ as any).id, page: { id: page.id, name: page.name } };
}
