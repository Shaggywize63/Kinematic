/**
 * Google Ads Lead Form Extensions provider.
 *
 * Auth model: shared secret in the payload. When admins create a Lead
 * Form Extension in Google Ads, they paste our webhook URL plus a key.
 * Google then posts every lead to that URL with the key in the body —
 * the integration's `webhook_secret` is the same key.
 *
 * No OAuth, no signature header, no Graph API roundtrip — the entire
 * lead lives in the webhook body's `user_column_data` array.
 *
 * Payload shape (per Google docs):
 *   {
 *     "lead_id": "...",
 *     "api_version": "1.0",
 *     "form_id": "...",
 *     "campaign_id": "...",
 *     "google_key": "<our webhook_secret>",
 *     "is_test": false,
 *     "gcl_id": "...",
 *     "user_column_data": [
 *       { "column_name": "Full Name",     "string_value": "Jane Doe",     "column_id": "FULL_NAME" },
 *       { "column_name": "Phone Number",  "string_value": "+919876543210", "column_id": "PHONE_NUMBER" }
 *     ]
 *   }
 */
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow } from './types';
import type { NormalizedLead } from '../dedup.orchestrator';

const COLUMN_ID_TO_FIELD: Record<string, keyof NormalizedLead> = {
  FULL_NAME:     'first_name',  // split on space below
  FIRST_NAME:    'first_name',
  LAST_NAME:     'last_name',
  EMAIL:         'email',
  PHONE_NUMBER:  'phone',
  COMPANY_NAME:  'company',
  JOB_TITLE:     'title',
  CITY:          'city',
  REGION:        'state',
  COUNTRY:       'country',
  POSTAL_CODE:   'state', // closest we have today; admins can map via custom_fields later
};

interface GoogleColumn {
  column_id?: string;
  column_name?: string;
  string_value?: string;
}

interface GoogleAdsBody {
  lead_id?: string;
  form_id?: string;
  campaign_id?: string;
  google_key?: string;
  is_test?: boolean;
  user_column_data?: GoogleColumn[];
}

function splitName(full: string): { first: string | null; last: string | null } {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export const googleAdsProvider: IntegrationProvider = {
  id: 'google_ads',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    const body = (req.body ?? {}) as GoogleAdsBody;
    const provided = body.google_key ?? '';
    if (!provided || !integration.webhook_secret) return false;
    if (provided.length !== integration.webhook_secret.length) return false;
    // Constant-time compare.
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ integration.webhook_secret.charCodeAt(i);
    }
    return diff === 0;
  },

  normalize(raw: unknown): NormalizedLead {
    const body = (raw ?? {}) as GoogleAdsBody;

    const out: NormalizedLead = {
      external_id: body.lead_id ?? null,
      custom_fields: {},
      utm_source:   'google_ads',
      utm_medium:   'paid_search',
      utm_campaign: body.campaign_id ?? null,
    };

    for (const col of body.user_column_data ?? []) {
      const id    = (col.column_id ?? '').toUpperCase().trim();
      const value = (col.string_value ?? '').trim();
      if (!value) continue;

      const target = COLUMN_ID_TO_FIELD[id];
      if (id === 'FULL_NAME') {
        const { first, last } = splitName(value);
        if (first && !out.first_name) out.first_name = first;
        if (last  && !out.last_name)  out.last_name  = last;
        continue;
      }
      if (target) {
        // @ts-expect-error — narrowed to NormalizedLead string fields above
        if (!out[target]) out[target] = value;
        continue;
      }
      // Unknown column_id — keep the human-readable name as the custom_fields key.
      const key = col.column_name?.toLowerCase().replace(/\s+/g, '_') ?? id.toLowerCase();
      (out.custom_fields as Record<string, unknown>)[key] = value;
    }
    return out;
  },
};
