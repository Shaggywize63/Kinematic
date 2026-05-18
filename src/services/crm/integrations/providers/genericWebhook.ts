/**
 * Generic webhook provider — superset of web_form, intended for Zapier /
 * Make / custom backends posting arbitrary JSON.
 *
 * Auth model: same per-integration `webhook_secret` shipped as `?key=...`
 * on the URL. Constant-time compared.
 *
 * Payload model: pass-through with an optional `config.field_map` that the
 * admin defines per integration (e.g. `{ "subscriber_email": "email",
 * "phone_number": "phone" }` for a Mailchimp → Kinematic Zap). When
 * field_map is empty, falls back to the same common-sense field name
 * recognition as web_form so vanilla Zap "webhook by Zapier" templates
 * (which post the user's lead-form column names verbatim) still work
 * out of the box.
 */
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow } from './types';
import type { NormalizedLead } from '../dedup.orchestrator';

// Same recognition set as web_form — let "Zapier with no mapping" work.
const NAME_KEYS:    string[] = ['first_name', 'firstName', 'fname', 'name', 'full_name', 'fullName'];
const LAST_KEYS:    string[] = ['last_name', 'lastName', 'lname'];
const EMAIL_KEYS:   string[] = ['email', 'email_address'];
const PHONE_KEYS:   string[] = ['phone', 'mobile', 'phone_number', 'whatsapp'];
const COMPANY_KEYS: string[] = ['company', 'organization', 'organisation'];
const TITLE_KEYS:   string[] = ['title', 'designation', 'role'];
const NOTES_KEYS:   string[] = ['notes', 'message', 'comments', 'requirements'];

const KNOWN_KEYS = new Set<string>([
  ...NAME_KEYS, ...LAST_KEYS, ...EMAIL_KEYS, ...PHONE_KEYS,
  ...COMPANY_KEYS, ...TITLE_KEYS, ...NOTES_KEYS,
  'industry', 'sector', 'country', 'city', 'state',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'referrer', 'referrer_url', 'landing_page', 'page_url',
]);

function splitName(full: string): { first?: string; last?: string } {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export const genericWebhookProvider: IntegrationProvider = {
  id: 'generic_webhook',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    const provided =
      (req.query.key as string | undefined) ??
      (req.headers['x-webhook-key'] as string | undefined);
    if (!provided || !integration.webhook_secret) return false;
    if (provided.length !== integration.webhook_secret.length) return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ integration.webhook_secret.charCodeAt(i);
    }
    return diff === 0;
  },

  normalize(raw: unknown, integration: IntegrationRow): NormalizedLead {
    const body = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};

    // Admin-defined mapping wins. Shape: `{ <inbound_key>: <our_key> }`.
    // Build a reverse lookup of our_key -> inbound_key so we know which
    // source field to read.
    const fieldMap = (integration.config?.field_map as Record<string, string> | undefined) ?? {};
    const reverseMap: Record<string, string[]> = {};
    for (const [inbound, ourKey] of Object.entries(fieldMap)) {
      (reverseMap[ourKey] ??= []).push(inbound);
    }

    const pick = (ourKey: string, fallbacks: string[]): string | null => {
      // 1. Try admin-defined mapped keys first.
      for (const k of reverseMap[ourKey] ?? []) {
        const v = body[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
      // 2. Fall back to convention-named keys.
      for (const k of fallbacks) {
        const v = body[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
      return null;
    };

    // Name handling — same split-on-space logic as web_form.
    let first_name = pick('first_name', ['first_name', 'firstName', 'fname']);
    let last_name  = pick('last_name',  LAST_KEYS);
    if (!first_name && !last_name) {
      const full = pick('name', ['name', 'full_name', 'fullName']);
      if (full) {
        const { first, last } = splitName(full);
        first_name = first ?? null;
        last_name  = last  ?? null;
      }
    }

    // Stash unmapped keys + admin-mapped fields we didn't already pluck.
    const mappedSourceKeys = new Set(Object.keys(fieldMap));
    const custom_fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (KNOWN_KEYS.has(k)) continue;
      if (mappedSourceKeys.has(k)) continue;
      if (k === 'custom_fields' && v && typeof v === 'object') {
        Object.assign(custom_fields, v as Record<string, unknown>);
        continue;
      }
      if (v != null && typeof v !== 'object') custom_fields[k] = v;
    }

    return {
      first_name,
      last_name,
      email:   pick('email',   EMAIL_KEYS),
      phone:   pick('phone',   PHONE_KEYS),
      company: pick('company', COMPANY_KEYS),
      title:   pick('title',   TITLE_KEYS),
      industry: pick('industry', ['industry', 'sector']),
      country: pick('country', ['country']),
      city:    pick('city',    ['city']),
      state:   pick('state',   ['state']),
      notes:   pick('notes',   NOTES_KEYS),
      utm_source:   pick('utm_source',   ['utm_source']),
      utm_medium:   pick('utm_medium',   ['utm_medium']),
      utm_campaign: pick('utm_campaign', ['utm_campaign']),
      utm_term:     pick('utm_term',     ['utm_term']),
      utm_content:  pick('utm_content',  ['utm_content']),
      referrer_url: pick('referrer_url', ['referrer_url', 'referrer']),
      landing_page: pick('landing_page', ['landing_page', 'page_url']),
      custom_fields,
    };
  },
};
