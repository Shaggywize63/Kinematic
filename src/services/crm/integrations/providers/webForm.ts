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

// Ad click-ids. gclid/gbraid/wbraid are Google Ads variants of the same signal
// (a sender normally has at most one); fbclid/msclkid are Meta/Microsoft's.
const GOOGLE_CLICK_ID_ALIASES = ['gclid', 'gbraid', 'wbraid'];
const META_CLICK_ID_ALIASES = ['fbclid'];
const MS_CLICK_ID_ALIASES = ['msclkid'];

const KNOWN_KEYS = new Set<string>([
  ...FIRST_ALIASES, ...LAST_ALIASES, ...NAME_ALIASES, ...EMAIL_ALIASES, ...PHONE_ALIASES,
  ...COMPANY_ALIASES, ...TITLE_ALIASES, ...NOTES_ALIASES,
  ...CITY_ALIASES, ...STATE_ALIASES, ...COUNTRY_ALIASES, ...INDUSTRY_ALIASES,
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'referrer', 'referrer_url', 'landing_page', 'page_url',
  ...GOOGLE_CLICK_ID_ALIASES, ...META_CLICK_ID_ALIASES, ...MS_CLICK_ID_ALIASES,
  // Consent flags (DPDP opt-in) — captured as booleans, not custom fields.
  'consent', 'opt_in', 'optin', 'communications_consent', 'comms_consent',
  'whatsapp_consent', 'consent_whatsapp', 'wa_consent',
  'marketing_consent', 'consent_marketing',
]);

// Only the hostname of a referrer, lower-cased, no leading www. Mirrors
// kinematic_website/assets/attribution.js's refHost().
function refHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'paidsocial', 'paid-social']);

// Explicit utm_source -> human channel. Unmapped values fall through to a
// title-cased version of the raw utm_source so a sender's own custom tags
// still show up as something readable instead of disappearing.
const UTM_SOURCE_CHANNEL: Record<string, string> = {
  whatsapp: 'WhatsApp', wa: 'WhatsApp', whatsapp_bot: 'WhatsApp Bot', wa_bot: 'WhatsApp Bot', whatsappbot: 'WhatsApp Bot',
  chatgpt: 'ChatGPT', openai: 'ChatGPT',
  claude: 'Claude', anthropic: 'Claude',
  perplexity: 'Perplexity', gemini: 'Gemini', bard: 'Gemini', copilot: 'Copilot',
  google: 'Organic Search', bing: 'Organic Search', duckduckgo: 'Organic Search', yahoo: 'Organic Search',
  facebook: 'Social Media', instagram: 'Social Media', linkedin: 'Social Media', twitter: 'Social Media',
  x: 'Social Media', youtube: 'Social Media', reddit: 'Social Media', meta: 'Social Media', fb: 'Social Media',
  email: 'Email', newsletter: 'Email', mailer: 'Email',
};

// Referrer host -> human channel, for senders that forward only a bare
// referrer with no UTM tags (e.g. an organic click-through from a search
// engine or an AI assistant). Unmapped external hosts become "Referral (host)".
const REFERRER_CHANNEL_RULES: Array<[RegExp, string]> = [
  [/(^|\.)google\./, 'Organic Search'], [/(^|\.)bing\.com$/, 'Organic Search'], [/(^|\.)duckduckgo\.com$/, 'Organic Search'],
  [/search\.yahoo\./, 'Organic Search'], [/(^|\.)ecosia\.org$/, 'Organic Search'], [/search\.brave\.com$/, 'Organic Search'],
  [/(^|\.)chatgpt\.com$/, 'ChatGPT'], [/(^|\.)chat\.openai\.com$/, 'ChatGPT'], [/(^|\.)openai\.com$/, 'ChatGPT'],
  [/(^|\.)claude\.ai$/, 'Claude'], [/(^|\.)anthropic\.com$/, 'Claude'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity'], [/(^|\.)gemini\.google\.com$/, 'Gemini'], [/(^|\.)bard\.google\.com$/, 'Gemini'], [/copilot\.microsoft\.com$/, 'Copilot'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'WhatsApp'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Social Media'], [/(^|\.)instagram\.com$/, 'Social Media'],
  [/(^|\.)linkedin\.com$/, 'Social Media'], [/(^|\.)lnkd\.in$/, 'Social Media'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'Social Media'], [/(^|\.)youtube\.com$/, 'Social Media'], [/(^|\.)youtu\.be$/, 'Social Media'], [/(^|\.)reddit\.com$/, 'Social Media'],
  [/(^|\.)t\.me$/, 'Telegram'], [/(^|\.)telegram\.org$/, 'Telegram'],
];

/**
 * Classify a web-form submission's acquisition channel from whatever
 * attribution signal the sender forwarded (UTM tags, an ad click-id, or a
 * bare external referrer). Used to fan leads out across per-channel
 * crm_lead_sources rows instead of one flat "Web Form" bucket — see
 * getOrCreateChannelSource() in integrations.controller.ts.
 *
 * Mirrors kinematic_website's assets/attribution.js + submit.php classifier
 * (km_classify) so any sender gets the same breakdown, not just our own
 * site. Always returns a label — "Direct" means no signal at all arrived.
 */
export function classifyChannel(input: {
  utm_source?: string | null;
  utm_medium?: string | null;
  google_click_id?: string | null;
  meta_click_id?: string | null;
  ms_click_id?: string | null;
  referrer_url?: string | null;
}): string {
  const s = (input.utm_source || '').trim().toLowerCase();
  const m = (input.utm_medium || '').trim().toLowerCase();
  const paid = PAID_MEDIUMS.has(m);

  // 1) Ads — most reliable via click-ids, then source+paid medium.
  if (input.google_click_id || (['google', 'googleads', 'google-ads', 'google_ads'].includes(s) && paid)) return 'Google Ads';
  if (input.ms_click_id || (s === 'bing' && paid)) return 'Microsoft Ads';
  if (input.meta_click_id || (['facebook', 'instagram', 'meta', 'fb'].includes(s) && paid)) return 'Meta Ads';

  // 2) Explicit utm_source.
  if (s) {
    if (UTM_SOURCE_CHANNEL[s]) return UTM_SOURCE_CHANNEL[s];
    return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
  }

  // 3) Referrer host.
  const rh = refHost(input.referrer_url || '');
  if (rh) {
    for (const [re, label] of REFERRER_CHANNEL_RULES) {
      if (re.test(rh)) return label;
    }
    return `Referral (${rh})`.slice(0, 60);
  }

  return 'Direct';
}

// Parse a boolean-ish consent flag. Returns undefined when absent so the
// downstream lead write leaves the column untouched unless a value was sent.
function boolField(body: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = body[k];
    if (v != null && String(v).trim() !== '') {
      return ['true', '1', 'yes', 'y', 'on', 'checked'].includes(String(v).trim().toLowerCase());
    }
  }
  return undefined;
}

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

    // Consent (DPDP opt-in). An explicit whatsapp/marketing flag wins; else a
    // single generic `consent`/`opt_in` covers both channels.
    const genConsent = boolField(body, 'consent', 'opt_in', 'optin', 'communications_consent', 'comms_consent');
    const waConsent  = boolField(body, 'whatsapp_consent', 'consent_whatsapp', 'wa_consent');
    const mkConsent  = boolField(body, 'marketing_consent', 'consent_marketing');

    const utm_source = pick('utm_source');
    const utm_medium = pick('utm_medium');
    const referrer_url = pick('referrer_url', 'referrer');
    const channel = classifyChannel({
      utm_source,
      utm_medium,
      google_click_id: pick(...GOOGLE_CLICK_ID_ALIASES),
      meta_click_id:   pick(...META_CLICK_ID_ALIASES),
      ms_click_id:     pick(...MS_CLICK_ID_ALIASES),
      referrer_url,
    });

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
      whatsapp_consent:  waConsent !== undefined ? waConsent : genConsent,
      marketing_consent: mkConsent !== undefined ? mkConsent : genConsent,
      utm_source,
      utm_medium,
      utm_campaign: pick('utm_campaign'),
      utm_term:     pick('utm_term'),
      utm_content:  pick('utm_content'),
      referrer_url,
      landing_page: pick('landing_page', 'page_url'),
      channel,
      custom_fields,
    };
  },
};
