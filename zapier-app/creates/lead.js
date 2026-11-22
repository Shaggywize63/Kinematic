'use strict';

// "Create Lead" — posts straight to the Generic Webhook ingestion endpoint
// (Kinematic/src/services/crm/integrations/providers/genericWebhook.ts,
// mounted at POST /api/v1/integrations/webhook/generic-webhook/:id?key=...).
// That endpoint accepts a flat JSON body of typed fields plus a nested
// `custom_fields` object, and normalizes/dedups into a lead — see
// genericWebhookProvider.normalize() for exactly which keys it reads.

// Fields the backend reads straight off the body (everything except the
// boolean consent flags and the custom_fields escape hatch, which get
// their own handling below).
const PASSTHROUGH_KEYS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'company',
  'title',
  'industry',
  'city',
  'state',
  'country',
  'notes',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'referrer_url',
  'landing_page',
];

const BOOLEAN_KEYS = ['marketing_consent', 'whatsapp_consent'];

const isEmpty = (value) => value === undefined || value === null || value === '';

// Zap input fields come through as strings for checkbox/boolean fields in
// some trigger apps (e.g. "true"/"1") as well as actual booleans, so coerce
// loosely rather than assuming bundle.inputData already gives us a boolean.
const toBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on', 'checked'].includes(normalized);
};

const perform = async (z, bundle) => {
  const input = bundle.inputData;
  const body = {};

  for (const key of PASSTHROUGH_KEYS) {
    const value = input[key];
    // Drop anything empty/undefined rather than sending "" or null — an
    // unset optional field should be left alone, not overwrite existing
    // lead data with a blank (see genericWebhook.ts's pick()/boolField(),
    // which already treat "" the same as absent).
    if (!isEmpty(value)) body[key] = value;
  }

  for (const key of BOOLEAN_KEYS) {
    const value = input[key];
    if (!isEmpty(value)) body[key] = toBoolean(value);
  }

  if (!isEmpty(input.custom_fields_json)) {
    try {
      const parsed = JSON.parse(input.custom_fields_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body.custom_fields = parsed;
      } else {
        z.console.log(
          'custom_fields_json parsed but was not a JSON object (got ' +
            (Array.isArray(parsed) ? 'an array' : typeof parsed) +
            ') — omitting custom_fields.',
        );
      }
    } catch (err) {
      // Malformed JSON from the user. Per spec: don't fail the whole
      // create over this — just drop custom_fields and submit the rest.
      z.console.log('custom_fields_json failed to parse, omitting custom_fields:', err.message);
    }
  }

  const response = await z.request({
    url: bundle.authData.webhookUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const responseBody = response.json || {};

  // KNOWN LIMITATION (see README.md "Known limitations"): Kinematic's
  // generic-webhook endpoint always answers HTTP 200 by design (so a bug
  // doesn't trigger Zapier/Meta/etc. retry storms — see the big comment
  // above inboundWebhook() in integrations.controller.ts) and its response
  // body is only `{ ok, created, merged }` — created/merged COUNTS, not a
  // lead id. The controller does attach `lead_id` to the inbound-event log
  // row (crm_lead_inbound_events) for the single-lead case, but never
  // returns it to the caller synchronously.
  //
  // Zapier's own docs ask create actions to return a durable `id` for the
  // resource they created, for its "View it in [App]" UI and for other
  // Zaps keying off that id. We deliberately do NOT fabricate one here
  // (e.g. `Date.now().toString()`) — a made-up id would silently misrepresent
  // what the API actually guarantees and could be mistaken for a real lead
  // id by someone chaining another step off it. Instead we surface exactly
  // what the backend told us (created/merged counts) plus an echo of what
  // was submitted, so the Zapier "Test" step still shows something
  // meaningful to map from.
  return {
    ok: responseBody.ok,
    created: responseBody.created,
    merged: responseBody.merged,
    ...body,
  };
};

module.exports = {
  key: 'create_lead',
  noun: 'Lead',
  display: {
    label: 'Create Lead',
    description:
      'Creates (or updates, if Kinematic recognizes a matching email/phone) a lead in your ' +
      'Kinematic CRM. Kinematic\'s own duplicate-matching looks at name, email and phone, so ' +
      'filling in at least one of those gives the best results — but nothing below is required ' +
      'here, since different sources care about different fields.',
  },
  operation: {
    inputFields: [
      { key: 'first_name', label: 'First Name', type: 'string', helpText: 'The lead\'s first name.' },
      { key: 'last_name', label: 'Last Name', type: 'string', helpText: 'The lead\'s last name.' },
      { key: 'email', label: 'Email', type: 'string', helpText: 'The lead\'s email address.' },
      { key: 'phone', label: 'Phone', type: 'string', helpText: 'The lead\'s phone number, with country code if you have it (e.g. +91...).' },
      { key: 'company', label: 'Company', type: 'string', helpText: 'The company or organization the lead belongs to.' },
      { key: 'title', label: 'Job Title', type: 'string', helpText: 'The lead\'s job title or role.' },
      { key: 'industry', label: 'Industry', type: 'string', helpText: 'The lead\'s industry or business vertical.' },
      { key: 'city', label: 'City', type: 'string', helpText: 'City the lead is based in.' },
      { key: 'state', label: 'State', type: 'string', helpText: 'State or region the lead is based in.' },
      { key: 'country', label: 'Country', type: 'string', helpText: 'Country the lead is based in.' },
      { key: 'notes', label: 'Notes', type: 'text', helpText: 'Any free-text details about this lead — a message, enquiry or requirement.' },
      {
        key: 'utm_source',
        label: 'UTM Source',
        type: 'string',
        helpText: 'Optional marketing-attribution field — where this lead came from (e.g. "google", "facebook"). Leave blank if you don\'t track this.',
      },
      {
        key: 'utm_medium',
        label: 'UTM Medium',
        type: 'string',
        helpText: 'Optional marketing-attribution field — the marketing medium (e.g. "cpc", "email"). Leave blank if you don\'t track this.',
      },
      {
        key: 'utm_campaign',
        label: 'UTM Campaign',
        type: 'string',
        helpText: 'Optional marketing-attribution field — the campaign name. Leave blank if you don\'t track this.',
      },
      {
        key: 'utm_term',
        label: 'UTM Term',
        type: 'string',
        helpText: 'Optional marketing-attribution field — the paid search term, if any. Leave blank if you don\'t track this.',
      },
      {
        key: 'utm_content',
        label: 'UTM Content',
        type: 'string',
        helpText: 'Optional marketing-attribution field — distinguishes similar content/ads in the same campaign. Leave blank if you don\'t track this.',
      },
      { key: 'referrer_url', label: 'Referrer URL', type: 'string', helpText: 'Optional — the page the lead was referred from.' },
      { key: 'landing_page', label: 'Landing Page URL', type: 'string', helpText: 'Optional — the page the lead submitted the form from.' },
      {
        key: 'marketing_consent',
        label: 'Marketing Consent',
        type: 'boolean',
        helpText: 'Did the lead agree to receive marketing communications? Leave blank/unset if this source doesn\'t capture consent — Kinematic will leave its existing consent record untouched rather than treating a blank as "no".',
      },
      {
        key: 'whatsapp_consent',
        label: 'WhatsApp Consent',
        type: 'boolean',
        helpText: 'Did the lead agree to be contacted on WhatsApp? Leave blank/unset if this source doesn\'t capture consent.',
      },
      {
        key: 'custom_fields_json',
        label: 'Other Fields (raw JSON)',
        type: 'string',
        helpText:
          'Optional — raw JSON object for anything not covered above, e.g. a Typeform question ' +
          'Kinematic doesn\'t have a built-in field for. Example: {"preferred_contact_time": "evening"}. ' +
          'If this isn\'t valid JSON, it\'s simply skipped — the rest of the lead is still created.',
      },
    ],
    perform,
    sample: {
      ok: true,
      created: 1,
      merged: 0,
      first_name: 'Asha',
      last_name: 'Verma',
      email: 'asha.verma@example.com',
      phone: '+919812345678',
      company: 'Verma Constructions Pvt Ltd',
      title: 'Procurement Manager',
      industry: 'Construction',
      city: 'Pune',
      state: 'Maharashtra',
      country: 'India',
      notes: 'Asked for bulk TMT bar pricing for a new site.',
      utm_source: 'typeform',
      utm_medium: 'form',
      utm_campaign: 'q4-construction-leads',
      referrer_url: 'https://example-landing.com/contact',
      landing_page: 'https://example-landing.com/contact',
      marketing_consent: true,
      whatsapp_consent: true,
    },
    outputFields: [
      { key: 'ok', label: 'Success', type: 'boolean' },
      { key: 'created', label: 'Leads Created', type: 'number' },
      { key: 'merged', label: 'Leads Merged (Duplicate Matches)', type: 'number' },
      { key: 'first_name', label: 'First Name' },
      { key: 'last_name', label: 'Last Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
    ],
  },
};
