/**
 * Meta (Facebook) OAuth for Lead Ads — "Connect with Facebook" instead of
 * the manual flow in providers/metaLeadAds.ts, where an admin has to own a
 * Meta Developer App, mint a Page Access Token in Graph API Explorer, and
 * hand-wire the App Dashboard webhook subscription.
 *
 * With OAuth, Kinematic owns ONE Meta App (shared across every tenant) and
 * every client authenticates through it, picking their own Page(s) via the
 * standard Facebook Login for Business consent screen — same shape as
 * HubSpot/Zapier/etc's Meta integrations.
 *
 * Token lifetime: unlike Google, a Page Access Token derived from a
 * long-lived User Access Token does NOT expire on its own — it's valid
 * until the user revokes access, changes their password, or the app's
 * permissions are removed. So there's no refresh-token dance needed here;
 * we mint it once at connect time and store it in the credentials vault
 * exactly like the manual flow already does, just skipping the "paste it
 * into a form" step.
 *
 * Page-level webhook delivery: Meta's "leadgen" webhook subscription is
 * APP-LEVEL — one callback URL per App, shared by every Page subscribed to
 * it, regardless of which Kinematic tenant owns the Page. connectPage()
 * below turns delivery ON for a specific Page via the Graph API
 * (POST /{page-id}/subscribed_apps) — no manual Meta App Dashboard step.
 * The App-level subscription itself (callback URL + verify token) is a
 * one-time setup — see scripts/registerMetaAppWebhook.ts — done once by an
 * operator, not per-tenant.
 */
import crypto from 'crypto';
import { storeCredentials } from '../crm/integrations/credentialsVault';
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const FB_DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

// pages_show_list       — list the Pages this user manages
// pages_manage_metadata — required to call /{page-id}/subscribed_apps
// pages_read_engagement — required alongside leads_retrieval by Meta's
//                         Lead Ads product docs
// leads_retrieval       — required to call /{leadgen-id} (the actual lead
//                         field data, fetched by providers/metaLeadAds.ts)
const SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'leads_retrieval',
].join(',');

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
function redirectUri(): string {
  const v = process.env.META_OAUTH_REDIRECT_URI;
  if (!v) throw new Error('META_OAUTH_REDIRECT_URI is not configured');
  return v;
}

export function isConfigured(): boolean {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_OAUTH_REDIRECT_URI);
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES,
    response_type: 'code',
  });
  return `${FB_DIALOG_URL}?${params.toString()}`;
}

interface FbTokenResponse { access_token: string; token_type?: string; expires_in?: number }
interface FbErrorResponse { error?: { message?: string; type?: string; code?: number } }

async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${GRAPH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const r = await fetch(url);
  const j = await r.json() as T & FbErrorResponse;
  if (!r.ok || j.error) {
    throw new Error(`Meta Graph API ${path} failed: ${j.error?.message ?? r.status}`);
  }
  return j;
}

async function exchangeCodeForUserToken(code: string): Promise<string> {
  const j = await graphGet<FbTokenResponse>('/oauth/access_token', {
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: redirectUri(),
    code,
  });
  return j.access_token;
}

/** Short-lived (~1-2h) user token → long-lived (~60d) user token. The Page
 *  tokens we derive from THIS one inherit its long-lived, non-expiring
 *  (for Pages) behaviour. */
async function exchangeForLongLivedUserToken(shortLivedToken: string): Promise<string> {
  const j = await graphGet<FbTokenResponse>('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId(),
    client_secret: appSecret(),
    fb_exchange_token: shortLivedToken,
  });
  return j.access_token;
}

export interface ConnectablePage { id: string; name: string; access_token: string }

async function listPages(longLivedUserToken: string): Promise<ConnectablePage[]> {
  const j = await graphGet<{ data?: ConnectablePage[] }>('/me/accounts', {
    access_token: longLivedUserToken,
    fields: 'id,name,access_token',
  });
  return j.data ?? [];
}

/** Turn on leadgen delivery for a Page against Kinematic's shared App.
 *  Idempotent — Meta no-ops a repeat subscribe. */
async function subscribePageToApp(page: ConnectablePage): Promise<void> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(page.id)}/subscribed_apps`
    + `?subscribed_fields=leadgen&access_token=${encodeURIComponent(page.access_token)}`;
  const r = await fetch(url, { method: 'POST' });
  const j = await r.json() as { success?: boolean } & FbErrorResponse;
  if (!r.ok || j.error || j.success !== true) {
    throw new Error(`Meta page subscribe failed for ${page.name} (${page.id}): ${j.error?.message ?? r.status}`);
  }
}

export interface ConnectedPageResult { page_id: string; page_name: string; integration_id: string; was_new: boolean }

const PROVIDER_LABEL_META = 'Meta Lead Ads';

/** Create (or re-link) one crm_lead_source_integrations row per connected
 *  Page, store its Page Access Token in the credentials vault, subscribe it
 *  to the app's leadgen webhook, and auto-create a matching lead source —
 *  same bookkeeping createIntegration() already does for the manual flow.
 *  Marks config.connected_via = 'oauth' so the app-level webhook handler
 *  (verified with the shared META_APP_SECRET) knows these rows don't carry
 *  their own per-integration app_secret, unlike manually-configured ones. */
async function connectOnePage(
  orgId: string, userId: string, clientId: string | null, page: ConnectablePage,
): Promise<ConnectedPageResult> {
  await subscribePageToApp(page);

  const { data: existing } = await supabaseAdmin
    .from('crm_lead_source_integrations')
    .select('id')
    .eq('org_id', orgId)
    .eq('provider', 'meta_lead_ads')
    .filter('config->>page_id', 'eq', page.id)
    .maybeSingle();

  if (existing?.id) {
    await storeCredentials(existing.id, { page_access_token: page.access_token });
    await supabaseAdmin.from('crm_lead_source_integrations').update({
      status: 'active',
      label: `${PROVIDER_LABEL_META} — ${page.name}`,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id);
    return { page_id: page.id, page_name: page.name, integration_id: existing.id, was_new: false };
  }

  const sourceName = `${PROVIDER_LABEL_META} — ${page.name}`;
  const { data: source, error: srcErr } = await supabaseAdmin.from('crm_lead_sources')
    .insert({ org_id: orgId, name: sourceName, created_by: userId, client_id: clientId })
    .select('id').single();
  if (srcErr) throw new Error(`Failed to create lead source for ${page.name}: ${srcErr.message}`);

  const { data: integration, error: intErr } = await supabaseAdmin.from('crm_lead_source_integrations')
    .insert({
      org_id: orgId,
      provider: 'meta_lead_ads',
      label: sourceName,
      source_id: source.id,
      status: 'active',
      config: { page_id: page.id, connected_via: 'oauth' },
      webhook_secret: null,
      created_by: userId,
      client_id: clientId,
    })
    .select('id').single();
  if (intErr || !integration) {
    await supabaseAdmin.from('crm_lead_sources').delete().eq('id', source.id);
    throw new Error(`Failed to create integration for ${page.name}: ${intErr?.message ?? 'unknown error'}`);
  }

  await storeCredentials(integration.id, { page_access_token: page.access_token });
  return { page_id: page.id, page_name: page.name, integration_id: integration.id, was_new: true };
}

/** Full post-consent flow: code → long-lived user token → list Pages →
 *  connect every Page returned. v1 auto-connects all Pages the user picked
 *  "Continue as" for on Meta's own Page-selector step of the consent
 *  dialog (not a second picker of our own) — see the PR description for why
 *  that's a deliberate simplification, not an oversight. */
export async function completeOAuth(
  orgId: string, userId: string, clientId: string | null, code: string,
): Promise<ConnectedPageResult[]> {
  const shortLived = await exchangeCodeForUserToken(code);
  const longLived = await exchangeForLongLivedUserToken(shortLived);
  const pages = await listPages(longLived);
  if (pages.length === 0) {
    throw new Error('No Facebook Pages were returned — make sure you selected at least one Page during consent.');
  }
  const results: ConnectedPageResult[] = [];
  for (const page of pages) {
    try {
      results.push(await connectOnePage(orgId, userId, clientId, page));
    } catch (e) {
      logger.error({ org_id: orgId, page_id: page.id, err: (e as Error).message }, 'metaOAuth: connectOnePage failed');
    }
  }
  if (results.length === 0) {
    throw new Error('Connected to Facebook, but every Page failed to subscribe — check the server log for details.');
  }
  return results;
}

/** HMAC-SHA256 verification for the APP-LEVEL webhook (shared across every
 *  OAuth-connected tenant), using Kinematic's own META_APP_SECRET — distinct
 *  from providers/metaLeadAds.ts's verifyWebhook, which reads a
 *  PER-INTEGRATION app_secret for manually-configured (bring-your-own-app)
 *  customers. Exported so the controller can constant-time-compare without
 *  duplicating the HMAC logic. */
export function verifyAppWebhookSignature(signatureHeader: string | undefined, rawBody: Buffer | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=') || !rawBody) return false;
  const expected = signatureHeader.slice('sha256='.length);
  const computed = crypto.createHmac('sha256', appSecret()).update(rawBody).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function appWebhookVerifyToken(): string {
  const v = process.env.META_APP_WEBHOOK_VERIFY_TOKEN;
  if (!v) throw new Error('META_APP_WEBHOOK_VERIFY_TOKEN is not configured');
  return v;
}
