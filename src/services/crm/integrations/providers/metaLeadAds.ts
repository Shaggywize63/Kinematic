/**
 * Meta Lead Ads provider — Facebook + Instagram lead-form ingestion.
 *
 * Two-phase flow:
 *   1. Meta posts a minimal webhook with `entry[].changes[].value.leadgen_id`.
 *      We verify the HMAC-SHA256 over the RAW request body (captured by the
 *      `verify` hook on express.json in app.ts) using the App Secret stored
 *      in encrypted credentials.
 *   2. For each leadgen_id, we hit the Graph API with the Page Access Token
 *      to fetch the actual lead's field_data array. That's what populates
 *      the NormalizedLead.
 *
 * Required credentials (encrypted via crm_integration_store_credentials):
 *   - app_secret          — for HMAC signature verification
 *   - page_access_token   — for Graph API roundtrip to fetch lead details
 *
 * Required config (plaintext JSONB):
 *   - verify_token   — admin-defined string Meta echoes back during subscription
 *   - page_id?       — optional, lets us reject events from other Pages on
 *                      multi-Page apps
 *
 * Verify challenge (`GET /webhook/meta-lead-ads/:id?hub.mode=...`) is
 * handled by the controller's `verifyChallenge` handler, not here — this
 * file is the POST normalisation path.
 */
import crypto from 'crypto';
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow } from './types';
import type { NormalizedLead } from '../dedup.orchestrator';
import { readCredentials } from '../credentialsVault';
import { logger } from '../../../../lib/logger';

const GRAPH_VERSION = 'v19.0';

// Common Meta Lead Ad form-field names → our canonical NormalizedLead keys.
// Meta normalises these to snake_case during form creation but admins can
// (and do) override; we match on lowercased contains as a safety net.
const FIELD_ALIASES: Record<string, (keyof NormalizedLead) | string> = {
  first_name: 'first_name',
  last_name:  'last_name',
  full_name:  'first_name', // split on space in the mapping below
  email:      'email',
  phone_number: 'phone',
  phone:      'phone',
  company_name: 'company',
  job_title:  'title',
  city:       'city',
  state:      'state',
  country:    'country',
};

interface MetaWebhookValue {
  leadgen_id?: string;
  form_id?: string;
  page_id?: string;
  ad_id?: string;
  campaign_id?: string;
  adgroup_id?: string;
  created_time?: number;
}

interface MetaWebhookEntry {
  id?: string;
  time?: number;
  changes?: Array<{ field?: string; value?: MetaWebhookValue }>;
}

interface MetaWebhookBody {
  object?: string;
  entry?: MetaWebhookEntry[];
}

interface MetaGraphLead {
  id: string;
  created_time?: string;
  field_data?: Array<{ name: string; values: string[] }>;
  campaign_id?: string;
  ad_id?: string;
}

function splitName(full: string): { first: string | null; last: string | null } {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function metaLeadToNormalized(
  lead: MetaGraphLead,
  webhookValue: MetaWebhookValue,
): NormalizedLead {
  const out: NormalizedLead = {
    external_id: lead.id,
    custom_fields: {},
    utm_source:   'meta_lead_ads',
    utm_medium:   'paid_social',
    utm_campaign: lead.campaign_id ?? webhookValue.campaign_id ?? null,
  };
  const fields = lead.field_data ?? [];
  for (const f of fields) {
    const name = (f.name || '').toLowerCase().trim();
    const value = (f.values?.[0] ?? '').trim();
    if (!value) continue;

    const target = FIELD_ALIASES[name];
    if (name === 'full_name' && value) {
      const { first, last } = splitName(value);
      if (first && !out.first_name) out.first_name = first;
      if (last  && !out.last_name)  out.last_name  = last;
      continue;
    }
    if (target) {
      // @ts-expect-error — target is one of NormalizedLead's string fields
      if (!out[target]) out[target] = value;
      continue;
    }
    // Anything we don't recognise becomes a custom field — the rep can see
    // it on the lead detail screen.
    (out.custom_fields as Record<string, unknown>)[name] = value;
  }
  return out;
}

export const metaLeadAdsProvider: IntegrationProvider = {
  id: 'meta_lead_ads',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    const sig = (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
    if (!sig.startsWith('sha256=')) return false;
    const expected = sig.slice('sha256='.length);

    // Raw body captured by express.json verify hook in app.ts.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      logger.warn({ integration_id: integration.id }, 'Meta verifyWebhook: rawBody missing — ensure express.json verify hook is wired');
      return false;
    }

    try {
      const creds = await readCredentials<{ app_secret?: string }>(integration.id);
      const appSecret = creds?.app_secret;
      if (!appSecret) return false;

      const computed = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
      const a = Buffer.from(computed, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) {
      logger.error({ integration_id: integration.id, err: (e as Error).message }, 'Meta verifyWebhook failed');
      return false;
    }
  },

  async normalize(raw: unknown, integration: IntegrationRow): Promise<NormalizedLead[]> {
    const body = (raw ?? {}) as MetaWebhookBody;
    if (body.object !== 'page') return [];

    // Optional page_id filter — on multi-Page apps we may receive events
    // for Pages not bound to this integration. Drop them silently.
    const configuredPageId = (integration.config?.page_id as string | undefined)?.trim();

    type Item = { leadgenId: string; value: MetaWebhookValue };
    const items: Item[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen') continue;
        const value = change.value;
        if (!value?.leadgen_id) continue;
        if (configuredPageId && value.page_id && value.page_id !== configuredPageId) continue;
        items.push({ leadgenId: value.leadgen_id, value });
      }
    }
    if (items.length === 0) return [];

    // Fetch credentials once — used for every Graph API call below.
    const creds = await readCredentials<{ page_access_token?: string }>(integration.id);
    const accessToken = creds?.page_access_token;
    if (!accessToken) {
      throw new Error('Meta integration missing page_access_token in credentials');
    }

    const leads: NormalizedLead[] = [];
    for (const item of items) {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(item.leadgenId)}`
        + `?access_token=${encodeURIComponent(accessToken)}`
        + `&fields=id,created_time,field_data,campaign_id,ad_id`;
      try {
        const res = await fetch(url);
        const data = await res.json() as MetaGraphLead | { error?: { message?: string } };
        if (!res.ok || 'error' in data) {
          const msg = ('error' in data ? data.error?.message : null) ?? `Graph API ${res.status}`;
          logger.error({ integration_id: integration.id, leadgen_id: item.leadgenId, msg }, 'Meta Graph fetch failed');
          continue; // Skip this lead, keep processing siblings.
        }
        leads.push(metaLeadToNormalized(data as MetaGraphLead, item.value));
      } catch (e) {
        logger.error({ integration_id: integration.id, leadgen_id: item.leadgenId, err: (e as Error).message }, 'Meta Graph fetch threw');
      }
    }
    return leads;
  },
};
