/**
 * Web-form provider — the simplest of the v1 integrations.
 *
 * Auth model: per-integration `webhook_secret` shipped as `?key=<secret>`
 * on the public POST URL. The secret is the form's identity; whoever
 * has the URL can post leads. (HMAC isn't appropriate here — the script
 * tag the customer pastes is public, can't carry a server-side secret.)
 *
 * Payload: any flat JSON object. We map common-sense field names to the
 * NormalizedLead shape, plus a few Indian-form variants (mobile,
 * organization, designation). Anything we don't recognise lands in
 * `custom_fields` so reps can still see it.
 */
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow } from './types';
import type { NormalizedLead } from '../dedup.orchestrator';

const NAME_ALIASES = ['name', 'full_name', 'fullName', 'fullname', 'lead_name', 'customer_name', 'contact_name', 'your_name', 'subscriber_name'];
const FIRST_ALIASES = ['first_name', 'firstName', 'fname', 'f_name'];
const LAST_ALIASES  = ['last_name', 'lastName', 'lname', 'l_name', 'surname', 'family_name'];
const EMAIL_ALIASES = ['email', 'email_address', 'emailAddress', 'e_mail', 'subscriber_email'];
const PHONE_ALIASES = ['phone', 'mobile', 'mobile_number', 'mobileNumber', 'mobile_no', 'phone_number', 'phoneNumber', 'phone_no', 'whatsapp', 'whatsapp_number', 'contact_number', 'tel', 'telephone'];
const COMPANY_ALIASES = ['company', 'organization', 'organisation', 'company_name', 'companyName', 'org_name', 'business_name'];
const TITLE_ALIASES = ['title', 'job_title', 'jobTitle', 'designation', 'role', 'position'];
const NOTES_ALIASES = ['notes', 'message', 'comments', 'requirements', 'enquiry', 'inquiry', 'description', 'remarks'];
const CITY_ALIASES  = ['city', 'town', 'location'];
const STATE_ALIASES = ['state', 'region', 'province'];
const COUNTRY_ALIASES = ['country', 'country_code'];
const INDUSTRY_ALIASES = ['industry', 'sector', 'vertical'];

const KNOWN_KEYS = new Set<string>([
  ...FIRST_ALIASES, ...LAST_ALIASES, ...NAME_ALIASES, ...EMAIL_ALIASES, ...PHONE_ALIASES,
  ...COMPANY_ALIASES, ...TITLE_ALIASES, ...NOTES_ALIASES,
  ...CITY_ALIASES, ...STATE_ALIASES, ...COUNTRY_ALIASES, ...INDUSTRY_ALIASES,
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'referrer', 'referrer_url', 'landing_page', 'page_url',
]);

function splitName(full: string): { first?: string; last?: string } {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export const webFormProvider: IntegrationProvider = {
  id: 'web_form',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    const provided =
      (req.query.key as string | undefined) ??
      (req.headers['x-webhook-key'] as string | undefined);
    if (!provided || !integration.webhook_secret) return false;
    // Constant-time compare to defeat timing oracles on the secret.
    if (provided.length !== integration.webhook_secret.length) return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ integration.webhook_secret.charCodeAt(i);
    }
    return diff === 0;
  },

  normalize(raw: unknown): NormalizedLead {
    const body = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = body[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
      return null;
    };

    // Name handling — prefer explicit first/last, else split a single `name`.
    let first_name = pick(...FIRST_ALIASES);
    let last_name  = pick(...LAST_ALIASES);
    if (!first_name && !last_name) {
      const full = pick(...NAME_ALIASES);
      if (full) {
        const { first, last } = splitName(full);
        first_name = first ?? null;
        last_name  = last ?? null;
      }
    }

    // Stash anything we didn't recognise into custom_fields so the rep
    // can see it on the lead detail screen.
    const custom_fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (KNOWN_KEYS.has(k)) continue;
      if (k === 'custom_fields' && v && typeof v === 'object') {
        Object.assign(custom_fields, v as Record<string, unknown>);
        continue;
      }
      if (v != null && typeof v !== 'object') custom_fields[k] = v;
    }

    return {
      first_name,
      last_name,
      email:   pick(...EMAIL_ALIASES),
      phone:   pick(...PHONE_ALIASES),
      company: pick(...COMPANY_ALIASES),
      title:   pick(...TITLE_ALIASES),
      industry: pick(...INDUSTRY_ALIASES),
      country: pick(...COUNTRY_ALIASES),
      city:    pick(...CITY_ALIASES),
      state:   pick(...STATE_ALIASES),
      notes:   pick(...NOTES_ALIASES),
      utm_source:   pick('utm_source'),
      utm_medium:   pick('utm_medium'),
      utm_campaign: pick('utm_campaign'),
      utm_term:     pick('utm_term'),
      utm_content:  pick('utm_content'),
      referrer_url: pick('referrer_url', 'referrer'),
      landing_page: pick('landing_page', 'page_url'),
      custom_fields,
    };
  },
};
