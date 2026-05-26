/**
 * Integrations controller.
 *
 * Two halves:
 *   - Admin CRUD on crm_lead_source_integrations (auth required, mounted
 *     at /api/v1/integrations).
 *   - Public webhook handler for inbound leads (no auth, rate-limited,
 *     mounted at /api/v1/integrations/webhook/<provider>/:id).
 *
 * On create, the controller:
 *   - Generates a webhook_secret (32 url-safe bytes) for push providers.
 *   - Auto-creates a matching crm_lead_sources row (e.g. "Web Form —
 *     Acme Contact Page") and links it via source_id, so every inbound
 *     lead from this integration is correctly attributed without any
 *     admin follow-up.
 *
 * The webhook handler always returns 200 (best-effort, like the
 * WhatsApp webhook) — errors are logged to crm_lead_inbound_events.
 * Returning non-200 to Meta / Google / Zapier triggers immediate retries
 * which would amplify any bug into a thundering herd.
 */
import { Request, Response } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';
import { storeCredentials } from '../../services/crm/integrations/credentialsVault';
import { findOrCreateLead, type NormalizedLead } from '../../services/crm/integrations/dedup.orchestrator';
import { webFormProvider } from '../../services/crm/integrations/providers/webForm';
import { genericWebhookProvider } from '../../services/crm/integrations/providers/genericWebhook';
import { metaLeadAdsProvider } from '../../services/crm/integrations/providers/metaLeadAds';
import { googleAdsProvider } from '../../services/crm/integrations/providers/googleAds';
import type { ProviderId, IntegrationRow } from '../../services/crm/integrations/providers/types';
import { logger } from '../../lib/logger';

const PROVIDER_LABEL: Record<ProviderId, string> = {
  web_form:        'Web Form',
  generic_webhook: 'Generic Webhook',
  meta_lead_ads:   'Meta Lead Ads',
  google_ads:      'Google Ads',
  zoho:            'Zoho CRM',
};

// Providers that need a webhook secret (push-mode). Pull providers (zoho)
// authenticate via stored OAuth tokens, no shared secret needed.
const PUSH_PROVIDERS: ProviderId[] = ['web_form', 'generic_webhook', 'meta_lead_ads', 'google_ads'];

/** Provider dispatch — Zoho returns a 200 "not implemented" from
 *  the webhook handler until its OAuth + pull-sync provider lands. */
function getProvider(id: ProviderId) {
  if (id === 'web_form')        return webFormProvider;
  if (id === 'generic_webhook') return genericWebhookProvider;
  if (id === 'meta_lead_ads')   return metaLeadAdsProvider;
  if (id === 'google_ads')      return googleAdsProvider;
  return null;
}

function sanitiseIntegration(row: any): IntegrationRow & { webhook_url?: string } {
  // Strip ciphertext from outbound payloads. webhook_secret is only
  // included on the immediate-after-create response (see createIntegration).
  const { credentials_encrypted, ...rest } = row;
  return rest;
}

// ── Admin CRUD ─────────────────────────────────────────────────────────

export const listIntegrations = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_lead_source_integrations')
    .select('id, org_id, provider, label, source_id, status, config, last_synced_at, last_error, last_event_count, created_at, updated_at')
    .eq('org_id', org_id)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data ?? []);
});

export const getIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_lead_source_integrations')
    .select('id, org_id, provider, label, source_id, status, config, last_synced_at, last_error, last_event_count, webhook_secret, created_at, updated_at')
    .eq('org_id', org_id).eq('id', req.params.id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Integration not found');
  return ok(res, sanitiseIntegration(data));
});

export const createIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id, id: user_id } = req.user!;
  const { provider, label, config, credentials } = req.body as {
    provider: ProviderId;
    label?: string;
    config?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  };

  if (!provider || !PROVIDER_LABEL[provider]) {
    return badRequest(res, `Invalid provider. Must be one of: ${Object.keys(PROVIDER_LABEL).join(', ')}`);
  }

  // 1. Auto-create the matching crm_lead_sources row so reports +
  //    assignment rules can target this provider without further setup.
  const sourceName = label?.trim()
    ? `${PROVIDER_LABEL[provider]} — ${label.trim()}`
    : PROVIDER_LABEL[provider];
  const { data: source, error: srcErr } = await supabaseAdmin.from('crm_lead_sources')
    .insert({ org_id, name: sourceName, created_by: user_id })
    .select('id, name')
    .single();
  if (srcErr) {
    logger.error({ org_id, provider, err: srcErr.message }, 'createIntegration: source insert failed');
    return badRequest(res, `Failed to create lead source: ${srcErr.message}`);
  }

  // 2. Generate webhook_secret for push providers (32 url-safe bytes).
  //    Pull providers (zoho) authenticate via OAuth tokens stored in
  //    credentials_encrypted, no shared secret needed.
  const webhook_secret = PUSH_PROVIDERS.includes(provider)
    ? crypto.randomBytes(24).toString('base64url')
    : null;

  // 3. Insert the integration row.
  const { data: integration, error: intErr } = await supabaseAdmin.from('crm_lead_source_integrations')
    .insert({
      org_id,
      provider,
      label: label?.trim() || PROVIDER_LABEL[provider],
      source_id: source.id,
      status: 'pending',
      config: config ?? {},
      webhook_secret,
      created_by: user_id,
    })
    .select('*')
    .single();
  if (intErr) {
    // Roll back the source we just created so we don't leak orphans.
    await supabaseAdmin.from('crm_lead_sources').delete().eq('id', source.id);
    return badRequest(res, `Failed to create integration: ${intErr.message}`);
  }

  // 4. Optionally store provider credentials (encrypted at rest).
  if (credentials && Object.keys(credentials).length > 0) {
    try {
      await storeCredentials(integration.id, credentials);
    } catch (e) {
      logger.error({ integration_id: integration.id, err: (e as Error).message }, 'createIntegration: credential vault write failed');
      return badRequest(res, `Failed to store credentials: ${(e as Error).message}`);
    }
  }

  // 5. For push providers, flip to 'active' immediately — the integration
  //    is ready to receive leads. Pull providers stay 'pending' until the
  //    OAuth flow completes (zoho) or first successful sync.
  if (PUSH_PROVIDERS.includes(provider)) {
    await supabaseAdmin.from('crm_lead_source_integrations')
      .update({ status: 'active' }).eq('id', integration.id);
    integration.status = 'active';
  }

  // Webhook URL is shown ONCE on creation — admin must copy/paste it now.
  // GET responses strip webhook_secret to keep it out of casual UI logs.
  // Fall back to req.protocol + host if API_PUBLIC_URL isn't set on the
  // host, so the URL we hand back is always reachable.
  const envBase = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
  const reqBase = `${req.protocol}://${req.get('host')}`;
  const base = envBase || reqBase;
  const webhook_url = webhook_secret
    ? `${base}/api/v1/integrations/webhook/${provider.replace('_', '-')}/${integration.id}?key=${webhook_secret}`
    : null;

  return created(res, {
    ...sanitiseIntegration(integration),
    webhook_secret,
    webhook_url,
    source: { id: source.id, name: source.name },
  });
});

export const updateIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id, id: user_id } = req.user!;
  const updates: Record<string, unknown> = {};
  for (const k of ['label', 'status', 'config'] as const) {
    if (k in req.body) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) {
    return badRequest(res, 'No updatable fields supplied (allowed: label, status, config)');
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin.from('crm_lead_source_integrations')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id)
    .select('*').single();
  if (error) return badRequest(res, error.message);
  if (!data)  return notFound(res, 'Integration not found');

  // If credentials supplied, re-encrypt.
  if (req.body.credentials && typeof req.body.credentials === 'object') {
    try { await storeCredentials(data.id, req.body.credentials); }
    catch (e) { return badRequest(res, `Failed to update credentials: ${(e as Error).message}`); }
  }

  return ok(res, sanitiseIntegration(data));
});

export const deleteIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_lead_source_integrations')
    .delete().eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

export const listIntegrationEvents = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const { data, error } = await supabaseAdmin.from('crm_lead_inbound_events')
    .select('id, received_at, provider, signature_ok, processed_at, lead_id, was_dedup, error')
    .eq('integration_id', req.params.id).eq('org_id', org_id)
    .order('received_at', { ascending: false }).limit(limit);
  if (error) return badRequest(res, error.message);
  return ok(res, data ?? []);
});

export const testIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  // v1: just confirm the integration row is reachable. v2 will ping the
  // provider's API for pull integrations and verify the webhook URL is
  // resolvable for push integrations.
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_lead_source_integrations')
    .select('id, status').eq('id', req.params.id).eq('org_id', org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data)  return notFound(res, 'Integration not found');
  return ok(res, { ok: true, status: data.status });
});

// ── Public webhook handler ──────────────────────────────────────────────

async function logInboundEvent(
  integration_id: string,
  org_id: string,
  provider: string,
  payload: unknown,
  signature_ok: boolean,
): Promise<string> {
  const { data } = await supabaseAdmin.from('crm_lead_inbound_events').insert({
    integration_id, org_id, provider,
    payload: (payload && typeof payload === 'object') ? payload : { raw: String(payload) },
    signature_ok,
  }).select('id').single();
  return data?.id ?? '';
}

async function finishEvent(
  event_id: string,
  result: { lead_id?: string; was_dedup?: boolean; error?: string },
) {
  if (!event_id) return;
  await supabaseAdmin.from('crm_lead_inbound_events').update({
    processed_at: new Date().toISOString(),
    lead_id: result.lead_id ?? null,
    was_dedup: result.was_dedup ?? null,
    error: result.error ?? null,
  }).eq('id', event_id);
}

async function bumpIntegrationCounters(integration_id: string, errored: boolean, errorMsg?: string) {
  // Single-row increment via RPC would be cleaner; for v1 we read-modify-write
  // because the counter is informational, not a constraint.
  const { data } = await supabaseAdmin.from('crm_lead_source_integrations')
    .select('last_event_count').eq('id', integration_id).maybeSingle();
  const next = (data?.last_event_count ?? 0) + 1;
  await supabaseAdmin.from('crm_lead_source_integrations').update({
    last_event_count: next,
    last_synced_at: new Date().toISOString(),
    last_error: errored ? (errorMsg?.slice(0, 500) ?? 'unknown') : null,
    status: errored ? 'error' : 'active',
    updated_at: new Date().toISOString(),
  }).eq('id', integration_id);
}

export const inboundWebhook = asyncHandler<Request>(async (req, res) => {
  // ALWAYS return 200 to the caller. Errors are recorded to the inbound
  // event log and surfaced in the admin UI. Returning non-200 makes Meta /
  // Google / Zapier retry which would amplify any bug.
  const integration_id = req.params.id;
  const providerSlug = req.params.provider; // 'web-form' from URL
  const providerId = providerSlug.replace('-', '_') as ProviderId;

  // 1. Load integration.
  const { data: integration } = await supabaseAdmin.from('crm_lead_source_integrations')
    .select('*').eq('id', integration_id).maybeSingle();

  if (!integration) {
    res.status(200).json({ ok: true, message: 'unknown integration' });
    return;
  }
  if (integration.provider !== providerId) {
    res.status(200).json({ ok: true, message: 'provider mismatch' });
    return;
  }
  if (integration.status === 'disabled') {
    res.status(200).json({ ok: true, message: 'integration disabled' });
    return;
  }

  // 2. Resolve provider implementation.
  const provider = getProvider(providerId);
  if (!provider) {
    res.status(200).json({ ok: true, message: `provider ${providerId} not implemented yet` });
    return;
  }

  // 3. Verify signature/secret.
  const signature_ok = provider.verifyWebhook
    ? await provider.verifyWebhook(req, integration as IntegrationRow)
    : true;

  // 4. Log raw event (even when signature fails — we want to see attacks).
  const event_id = await logInboundEvent(
    integration_id, integration.org_id, providerId, req.body, signature_ok
  );

  if (!signature_ok) {
    await finishEvent(event_id, { error: 'signature verification failed' });
    res.status(200).json({ ok: true });
    return;
  }

  // 5. Normalise + dedup.
  try {
    const normalised = await provider.normalize(req.body, integration as IntegrationRow);
    const batch = Array.isArray(normalised) ? normalised : [normalised];

    let merged = 0, created = 0;
    for (const n of batch) {
      const r = await findOrCreateLead({
        org_id: integration.org_id,
        source_id: integration.source_id!,
        normalized: n,
        integration_id,
        raw_event_id: event_id,
      });
      if (r.was_new) created++; else merged++;
      // For single-event payloads, attach lead_id to the event row.
      if (batch.length === 1) {
        await finishEvent(event_id, { lead_id: r.lead_id, was_dedup: !r.was_new });
      }
    }
    await bumpIntegrationCounters(integration_id, false);
    res.status(200).json({ ok: true, created, merged });
  } catch (e) {
    const err = (e as Error).message;
    logger.error({ integration_id, err }, 'inboundWebhook: processing failed');
    await finishEvent(event_id, { error: err });
    await bumpIntegrationCounters(integration_id, true, err);
    // Still 200 — the error is recorded; we don't want retries.
    res.status(200).json({ ok: true });
  }
});

// ── Meta-style verify challenge (GET) ──────────────────────────────────────────
// Meta App Dashboard → Webhooks subscription does a one-time GET to the
// callback URL with hub.mode=subscribe + hub.verify_token + hub.challenge.
// We must echo `challenge` back as the response body if the verify token
// matches what the admin stored in integration.config.verify_token.
// Only meta_lead_ads uses this today; other providers return 405.

export const verifyChallenge = asyncHandler<Request>(async (req, res) => {
  const providerSlug = req.params.provider;
  const providerId = providerSlug.replace('-', '_') as ProviderId;
  if (providerId !== 'meta_lead_ads') {
    res.status(405).json({ ok: false, error: 'GET not supported for this provider' });
    return;
  }

  const mode      = (req.query['hub.mode']         as string | undefined) ?? '';
  const verifyTok = (req.query['hub.verify_token'] as string | undefined) ?? '';
  const challenge = (req.query['hub.challenge']    as string | undefined) ?? '';

  if (mode !== 'subscribe' || !challenge || !verifyTok) {
    res.status(400).json({ ok: false, error: 'missing hub.mode/verify_token/challenge' });
    return;
  }

  const { data: integration } = await supabaseAdmin.from('crm_lead_source_integrations')
    .select('id, provider, config').eq('id', req.params.id).maybeSingle();
  if (!integration || integration.provider !== providerId) {
    res.status(404).json({ ok: false, error: 'integration not found' });
    return;
  }

  const configured = (integration.config as Record<string, unknown> | null)?.verify_token;
  if (typeof configured !== 'string' || configured !== verifyTok) {
    res.status(403).json({ ok: false, error: 'verify_token mismatch' });
    return;
  }

  // Meta wants the raw challenge string, NOT JSON.
  res.status(200).type('text/plain').send(challenge);
});
