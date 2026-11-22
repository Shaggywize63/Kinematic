'use strict';

// Custom Auth — one field.
//
// Kinematic's Settings → CRM → Integrations → Add integration → Generic
// Webhook flow mints a single URL that already embeds both the integration
// id AND the per-integration secret as `?key=...`
// (see Kinematic/src/controllers/crm/integrations.controller.ts
// createIntegration()). That's deliberately the ONE thing a non-technical
// admin copies, so this app asks for exactly that URL — no separate
// "API key" / "account ID" fields to confuse anyone.
//
// Auth test: a side-effect-free GET to that same URL. Kinematic added GET
// support at this route (verifyChallenge() in integrations.controller.ts)
// specifically so integrations like this one can verify the key without
// creating a throwaway lead on every "Test" click / re-auth. It verifies
// the key and returns `{ ok: true, label, provider }` (200) or 401 on a
// bad/missing key, 403 if the admin disabled the integration, 404 if the
// integration id doesn't exist.
const AUTH_FAILURE_MESSAGE =
  "Couldn't verify this Webhook URL — check Settings → Integrations → " +
  "Generic Webhook in Kinematic and make sure the integration isn't disabled.";

const testAuth = async (z, bundle) => {
  let response;
  try {
    response = await z.request({
      url: bundle.authData.webhookUrl,
      method: 'GET',
    });
  } catch (err) {
    // z.request auto-throws on any 4xx/5xx (ResponseError) unless told not
    // to — that covers bad key (401), disabled integration (403) and
    // unknown integration id (404). Collapse all of those, plus any
    // network-level failure, into one plain-language message.
    throw new Error(AUTH_FAILURE_MESSAGE);
  }

  const data = response.json;
  if (!data || data.ok !== true) {
    throw new Error(AUTH_FAILURE_MESSAGE);
  }

  // `data` (`{ ok, label, provider }`) is what connectionLabel below reads
  // from — Zapier merges a successful test call's JSON response into
  // `bundle.inputData` for templating purposes.
  return data;
};

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'webhookUrl',
      label: 'Kinematic Webhook URL',
      type: 'string',
      required: true,
      helpText:
        'In Kinematic, go to **Settings → CRM → Integrations → Add integration → Generic Webhook** ' +
        'and copy the **Webhook URL** shown in the success screen (it\'s only shown once). ' +
        'Paste the whole URL here — it already contains everything Zapier needs, so there\'s ' +
        'nothing else to configure.',
    },
  ],
  test: testAuth,
  // Shown as the connected account's label in Zapier's UI. `label` comes
  // straight back from the auth-test response above (the integration's
  // own display name, e.g. "Generic Webhook — Typeform").
  connectionLabel: '{{bundle.inputData.label}}',
};
