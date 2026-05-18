/**
 * Distribution integrations controller.
 *
 * Two halves:
 *   - Admin CRUD on distribution_integrations (auth required, mounted at
 *     /api/v1/distribution/integrations).
 *   - Public agent endpoints (no JWT; per-integration agent_secret verifies
 *     the bridge agent's identity) mounted at
 *     /api/v1/integrations/tally/* BEFORE the auth catch-all in app.ts.
 *
 * On create, the controller:
 *   - Generates an agent_secret (32 url-safe bytes) the Windows bridge
 *     agent uses for both polling and result-reporting.
 *   - Returns the secret + bridge-agent config blob ONCE in the create
 *     response — admin must save it before closing the modal.
 *
 * Agent endpoints always 200 to acknowledge receipt; failures are
 * persisted to distribution_integration_events.error for surfacing in
 * the admin UI.
 */
import { Request, Response } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';
import { storeCredentials } from '../../services/distribution/integrations/credentialsVault';
import { renderTallyXml, type EventKind } from '../../services/distribution/integrations/tally.mapper';
import { logger } from '../../lib/logger';

type Provider = 'tally' | 'quickbooks' | 'zoho_books' | 'busy' | 'marg';

const PROVIDER_LABEL: Record<Provider, string> = {
  tally:       'Tally',
  quickbooks:  'QuickBooks',
  zoho_books:  'Zoho Books',
  busy:        'Busy Infotech',
  marg:        'Marg ERP',
};

function sanitiseIntegration<T extends Record<string, unknown>>(row: T): Omit<T, 'credentials_encrypted'> {
  const { credentials_encrypted, ...rest } = row as T & { credentials_encrypted?: unknown };
  return rest as Omit<T, 'credentials_encrypted'>;
}

// ── Admin CRUD ─────────────────────────────────────────────────────────

export const listIntegrations = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('distribution_integrations')
    .select('id, org_id, provider, label, status, config, last_seen_at, last_sync_at, last_error, last_event_count, created_at, updated_at')
    .eq('org_id', org_id)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data ?? []);
});

export const getIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('distribution_integrations')
    .select('id, org_id, provider, label, status, config, last_seen_at, last_sync_at, last_error, last_event_count, agent_secret, created_at, updated_at')
    .eq('org_id', org_id).eq('id', req.params.id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Integration not found');
  return ok(res, sanitiseIntegration(data));
});

export const createIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id, id: user_id } = req.user!;
  const { provider, label, config, credentials } = req.body as {
    provider: Provider;
    label?: string;
    config?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  };

  if (!provider || !PROVIDER_LABEL[provider]) {
    return badRequest(res, `Invalid provider. Must be one of: ${Object.keys(PROVIDER_LABEL).join(', ')}`);
  }

  const agent_secret = crypto.randomBytes(24).toString('base64url');

  const { data: integration, error: intErr } = await supabaseAdmin.from('distribution_integrations')
    .insert({
      org_id,
      provider,
      label: label?.trim() || PROVIDER_LABEL[provider],
      status: 'pending',
      config: config ?? {},
      agent_secret,
      created_by: user_id,
    })
    .select('*')
    .single();
  if (intErr) return badRequest(res, `Failed to create integration: ${intErr.message}`);

  if (credentials && Object.keys(credentials).length > 0) {
    try { await storeCredentials(integration.id, credentials); }
    catch (e) {
      // Roll back the integration row on vault failure so we don't leak orphans.
      await supabaseAdmin.from('distribution_integrations').delete().eq('id', integration.id);
      logger.error({ integration_id: integration.id, err: (e as Error).message }, 'createIntegration: credential vault write failed');
      return badRequest(res, `Failed to store credentials: ${(e as Error).message}`);
    }
  }

  // Flip to active immediately — the bridge agent will start receiving
  // jobs as soon as it polls. Status flips back to 'error' on the first
  // failed agent report.
  await supabaseAdmin.from('distribution_integrations')
    .update({ status: 'active' }).eq('id', integration.id);
  integration.status = 'active';

  // Bridge-agent setup payload, shown ONCE in the create response.
  const base = process.env.API_PUBLIC_URL ?? '';
  const agent_config = {
    integration_id: integration.id,
    agent_secret,
    polling_endpoint: `${base}/api/v1/integrations/tally/jobs/${integration.id}?key=${agent_secret}`,
    report_endpoint: `${base}/api/v1/integrations/tally/jobs/${integration.id}/result?key=${agent_secret}`,
    tally_url: 'http://localhost:9000',  // default; admin overrides in the bridge agent's local config
    poll_interval_seconds: 30,
  };

  return created(res, {
    ...sanitiseIntegration(integration),
    agent_secret,
    agent_config,
  });
});

export const updateIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const updates: Record<string, unknown> = {};
  for (const k of ['label', 'status', 'config'] as const) {
    if (k in req.body) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) {
    return badRequest(res, 'No updatable fields supplied (allowed: label, status, config)');
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin.from('distribution_integrations')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id)
    .select('*').single();
  if (error) return badRequest(res, error.message);
  if (!data)  return notFound(res, 'Integration not found');

  if (req.body.credentials && typeof req.body.credentials === 'object') {
    try { await storeCredentials(data.id, req.body.credentials); }
    catch (e) { return badRequest(res, `Failed to update credentials: ${(e as Error).message}`); }
  }

  return ok(res, sanitiseIntegration(data));
});

export const deleteIntegration = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('distribution_integrations')
    .delete().eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

export const listIntegrationEvents = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const { data, error } = await supabaseAdmin.from('distribution_integration_events')
    .select('id, kind, ref_table, ref_id, status, attempts, last_attempt_at, tally_voucher_id, error, created_at, synced_at')
    .eq('integration_id', req.params.id).eq('org_id', org_id)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) return badRequest(res, error.message);
  return ok(res, data ?? []);
});

/** On-demand XML render for a single event — powers the "Download XML"
 *  manual-fallback button in the admin UI. Always renders fresh from
 *  source rows so post-create amendments are reflected. */
export const getEventXml = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data: event } = await supabaseAdmin.from('distribution_integration_events')
    .select('id, integration_id, kind, ref_id')
    .eq('id', req.params.eventId).eq('org_id', org_id).maybeSingle();
  if (!event) return notFound(res, 'Event not found');

  const { data: integration } = await supabaseAdmin.from('distribution_integrations')
    .select('id, org_id, config').eq('id', event.integration_id as string).maybeSingle();
  if (!integration) return notFound(res, 'Integration not found');

  try {
    const xml = await renderTallyXml(
      integration as { id: string; org_id: string; config: Record<string, unknown> },
      event.kind as EventKind,
      event.ref_id as string,
    );
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${event.kind}-${event.ref_id}.tally.xml"`);
    res.status(200).send(xml);
  } catch (e) {
    return badRequest(res, `XML render failed: ${(e as Error).message}`);
  }
});

// ── Public agent endpoints ──────────────────────────────────────────────────────────────
//
// Mounted at /api/v1/integrations/tally/* BEFORE the auth catch-all so
// the bridge agent (running on the distributor's Windows PC) can hit
// them without a JWT. Per-integration secret in ?key= verifies identity.
//
// The agent's contract:
//   GET  /jobs/:integrationId?key=...
//     → [{ event_id, kind, ref_id, xml_payload }]   (up to 25 per poll)
//        Marks returned events as status='in_flight'.
//   POST /jobs/:integrationId/result?key=...
//        body: { event_id, ok, tally_voucher_id?, error? }
//     → marks event as 'synced' (with tally_voucher_id) or 'failed' (with
//        error + exponential backoff next_attempt_at).

function verifyAgentSecret(req: Request, integrationSecret: string | null): boolean {
  const provided = (req.query.key as string | undefined) ?? '';
  if (!provided || !integrationSecret) return false;
  if (provided.length !== integrationSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ integrationSecret.charCodeAt(i);
  }
  return diff === 0;
}

export const agentFetchJobs = asyncHandler<Request>(async (req, res) => {
  const integration_id = req.params.id;
  const { data: integration } = await supabaseAdmin.from('distribution_integrations')
    .select('id, org_id, provider, status, config, agent_secret').eq('id', integration_id).maybeSingle();

  if (!integration) { res.status(200).json({ ok: true, jobs: [] }); return; }
  if (integration.provider !== 'tally') { res.status(200).json({ ok: true, jobs: [], message: 'wrong provider' }); return; }
  if (integration.status === 'disabled')  { res.status(200).json({ ok: true, jobs: [], message: 'disabled' }); return; }
  if (!verifyAgentSecret(req, integration.agent_secret as string | null)) {
    res.status(403).json({ ok: false, error: 'bad agent key' }); return;
  }

  // Stamp last_seen_at so admins can see the agent is alive.
  await supabaseAdmin.from('distribution_integrations')
    .update({ last_seen_at: new Date().toISOString() }).eq('id', integration_id);

  // Pull next 25 eligible events. "Eligible" = status pending OR
  // retry_scheduled past its next_attempt_at.
  const nowIso = new Date().toISOString();
  const { data: events } = await supabaseAdmin.from('distribution_integration_events')
    .select('id, kind, ref_id, attempts')
    .eq('integration_id', integration_id)
    .in('status', ['pending', 'retry_scheduled'])
    .lte('next_attempt_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(25);

  if (!events || events.length === 0) { res.status(200).json({ ok: true, jobs: [] }); return; }

  // Render XML lazily, mark in_flight as we go.
  const jobs: Array<{ event_id: string; kind: string; ref_id: string; xml_payload: string; attempts: number }> = [];
  for (const ev of events) {
    try {
      const xml = await renderTallyXml(
        integration as { id: string; org_id: string; config: Record<string, unknown> },
        ev.kind as EventKind,
        ev.ref_id as string,
      );
      jobs.push({
        event_id: ev.id as string,
        kind: ev.kind as string,
        ref_id: ev.ref_id as string,
        xml_payload: xml,
        attempts: (ev.attempts as number) ?? 0,
      });
      await supabaseAdmin.from('distribution_integration_events').update({
        status: 'in_flight',
        last_attempt_at: nowIso,
        attempts: ((ev.attempts as number) ?? 0) + 1,
      }).eq('id', ev.id);
    } catch (e) {
      // Render failure — source row may have been deleted. Mark failed,
      // skip from this batch, log so the admin sees it in the events log.
      const msg = (e as Error).message?.slice(0, 500) ?? 'render failed';
      logger.error({ event_id: ev.id, err: msg }, 'tally agent fetch: render failed');
      await supabaseAdmin.from('distribution_integration_events').update({
        status: 'failed',
        last_attempt_at: nowIso,
        error: msg,
      }).eq('id', ev.id);
    }
  }

  res.status(200).json({ ok: true, jobs });
});

export const agentReportResult = asyncHandler<Request>(async (req, res) => {
  const integration_id = req.params.id;
  const { data: integration } = await supabaseAdmin.from('distribution_integrations')
    .select('id, agent_secret').eq('id', integration_id).maybeSingle();
  if (!integration) { res.status(200).json({ ok: true, message: 'unknown integration' }); return; }
  if (!verifyAgentSecret(req, integration.agent_secret as string | null)) {
    res.status(403).json({ ok: false, error: 'bad agent key' }); return;
  }

  const { event_id, ok: success, tally_voucher_id, error } = req.body as {
    event_id?: string;
    ok?: boolean;
    tally_voucher_id?: string;
    error?: string;
  };
  if (!event_id) { res.status(400).json({ ok: false, error: 'event_id required' }); return; }

  const { data: ev } = await supabaseAdmin.from('distribution_integration_events')
    .select('id, attempts').eq('id', event_id).eq('integration_id', integration_id).maybeSingle();
  if (!ev) { res.status(200).json({ ok: true, message: 'event not found' }); return; }

  if (success) {
    await supabaseAdmin.from('distribution_integration_events').update({
      status: 'synced',
      tally_voucher_id: tally_voucher_id ?? null,
      synced_at: new Date().toISOString(),
      error: null,
    }).eq('id', event_id);
    res.status(200).json({ ok: true });
    return;
  }

  // Failure — schedule next retry with exponential backoff (capped at
  // 30 min). 1m, 2m, 4m, 8m, 16m, 30m, 30m, 30m…
  const attempts = (ev.attempts as number) ?? 1;
  const backoffMin = Math.min(2 ** (attempts - 1), 30);
  const nextAttempt = new Date(Date.now() + backoffMin * 60_000).toISOString();

  // After 8 failed attempts, give up and mark as failed.
  const giveUp = attempts >= 8;
  await supabaseAdmin.from('distribution_integration_events').update({
    status: giveUp ? 'failed' : 'retry_scheduled',
    next_attempt_at: giveUp ? null : nextAttempt,
    error: error?.slice(0, 500) ?? 'unknown',
  }).eq('id', event_id);

  // Bump integration last_error so the admin UI surfaces it.
  await supabaseAdmin.from('distribution_integrations').update({
    last_error: error?.slice(0, 500) ?? 'unknown',
    updated_at: new Date().toISOString(),
  }).eq('id', integration_id);

  res.status(200).json({ ok: true, retry_at: giveUp ? null : nextAttempt });
});
