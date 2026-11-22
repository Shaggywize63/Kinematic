# Kinematic CRM — Zapier integration

A [Zapier Platform CLI](https://platform.zapier.com/) app that lets a
non-technical Kinematic client connect any of Zapier's ~7000 supported apps
(Typeform, Google Sheets, Calendly, Mailchimp, etc.) and push new leads
straight into their Kinematic CRM — without hand-configuring "Webhooks by
Zapier" or knowing anything about REST APIs.

It is a thin wrapper around a backend endpoint that already exists and is
already deployed: Kinematic's **Generic Webhook** lead-source integration
(`POST /api/v1/integrations/webhook/generic-webhook/:id?key=...`, see
`../src/services/crm/integrations/providers/genericWebhook.ts` and
`../src/controllers/crm/integrations.controller.ts` in this repo). This app
adds no new backend behavior — it just gives that endpoint a proper Zapier
UI (typed fields, help text, auth test, sample data) instead of making the
client paste raw field names into a generic webhook Zap action.

## What's in here

```
zapier-app/
├── authentication.js      Custom Auth: one "Kinematic Webhook URL" field
├── creates/
│   └── lead.js             "Create Lead" action
├── index.js                 App definition (wires auth + creates together)
├── package.json
├── test/
│   ├── authentication.test.js
│   └── creates.lead.test.js
├── .gitignore
└── README.md                you are here
```

## How a Kinematic admin gets a Webhook URL

1. In Kinematic, go to **Settings → CRM → Integrations → Add integration**.
2. Choose **Generic Webhook**, give it a label (e.g. "Typeform — Contact
   Form"), and save.
3. The success screen shows a **Webhook URL** exactly once. It already
   contains the integration's id and its secret key as a `?key=...` query
   parameter — it's the one and only string the admin needs.
4. That's the value they paste into this Zapier app's "Kinematic Webhook
   URL" field when connecting their account in Zapier.

If they lose the URL, they need to delete and re-create the integration
(the key is never shown again) — same as any webhook-secret-in-URL design.

## How the app works

- **Authentication** (`authentication.js`) — Custom Auth with a single
  field, `webhookUrl`. The auth test does a side-effect-free `GET` on that
  exact URL (no id/key are parsed out or reconstructed — the URL is used
  verbatim). Kinematic's `verifyChallenge()` handler answers that GET with
  `{ ok: true, label, provider }` on success, or 401/403/404 on a bad key,
  a disabled integration, or an unknown id. Any failure is surfaced to the
  user as one plain-language message. The connected account is labeled
  with the integration's own `label` in Zapier's UI.
- **Create Lead** (`creates/lead.js`, key `create_lead`) — input fields
  mirror the backend's accepted keys exactly (snake_case): `first_name`,
  `last_name`, `email`, `phone`, `company`, `title`, `industry`, `city`,
  `state`, `country`, `notes`, the UTM attribution fields, `referrer_url`,
  `landing_page`, `marketing_consent`, `whatsapp_consent`, plus one
  freeform `custom_fields_json` field for anything else (parsed into the
  backend's nested `custom_fields` object; invalid JSON is silently
  dropped rather than failing the whole create). None of these are
  required at the Zapier layer — different Zap sources populate different
  fields — but the field help text tells the user that Kinematic's own
  duplicate-matching works best with at least a name, email or phone.
  Empty/unset fields are dropped before the POST rather than sent as `""`
  or `null`.

## Known limitations / possible follow-ups

**No returned lead id.** Kinematic's generic-webhook POST endpoint always
responds `HTTP 200` with `{ ok, created, merged }` — by design, so that a
transient bug doesn't make Zapier/Meta/etc. retry and amplify into a
thundering herd (see the comment above `inboundWebhook()` in
`integrations.controller.ts`). It does **not** return a `lead_id` in that
response, even for the common single-lead-per-request case (the id is only
attached to the `crm_lead_inbound_events` log row, server-side).

Zapier's own docs ask create actions to return a durable `id` for the
resource they created (used for "View it in [App]" links and for later Zap
steps to key off). This app deliberately does **not** fabricate one — a
made-up id (e.g. `Date.now().toString()`) would misrepresent what the API
actually guarantees and could be mistaken for a real lead id downstream.
Instead, `create_lead` returns the real `created`/`merged` counts plus an
echo of the submitted fields, which is enough for Zapier's "Test" step to
show something meaningful, but the create's output has no `id` field.

**Suggested backend follow-up** (not made here — out of scope for this
app, and this repo's backend was explicitly described as needing no
changes for v1): have the single-event path of `inboundWebhook()` include
`lead_id` in its `200` response (it already computes `r.lead_id` per
normalized lead in the loop — see `integrations.controller.ts`). That
would let this app return a genuine `id` and be a small, additive, no-risk
change — worth doing before/soon after this app ships, but a product
decision for whoever owns the backend contract.

**UTM fields**: the backend's `genericWebhookProvider.normalize()` accepts
five UTM fields (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`). All five are exposed here as optional attribution fields,
even though they're one more than originally scoped, since the backend
already reads them and leaving two out would silently lose data for any
Zap that happens to send them.

## Local development

```bash
cd zapier-app
npm install
npm test        # mocha + nock — mocks every HTTP call, no live credentials or network needed
```

`npm test` runs the full suite against a mocked Kinematic backend (via
[`nock`](https://github.com/nock/nock)) — no Zapier account, no real
Webhook URL, and no outbound network calls are needed or made.

As an extra structural check (not part of `npm test`), the Zapier CLI's
own local schema validator can be run without logging in or registering
anything:

```bash
npx zapier-platform-cli validate
```

This only checks the app definition's shape against
`zapier-platform-schema` locally; it does not create or need a Zapier
account. (Validate also attempts a secondary network "integration check"
against Zapier's servers, which will fail/timeout with no account — that's
expected and unrelated to the structural check passing.)

## Publishing (not done yet — no Zapier account exists)

This app has **not** been registered or pushed anywhere. To actually
publish it once a Zapier account/team exists:

```bash
npm install -g zapier-platform-cli   # or use npx for one-off commands
zapier login
zapier register "Kinematic CRM"      # creates the app on Zapier's platform
zapier push                          # uploads this version as a private/draft app
```

After `zapier push`, the app is visible only to the account that pushed it
(as an invite-only integration) until it's submitted for Zapier's public
app review. See [platform.zapier.com/publish](https://platform.zapier.com/)
for the current review requirements.
