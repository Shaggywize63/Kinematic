# Agrisynx — Dealer / Farmer lead forms, scheduled visits, vehicle allowance, Travel-only expenses

Everything here is **opt-in per client**. A client that has none of this configured behaves exactly as
before (B2B / B2C, flat per-km mileage, no schedule-visit control).

## 1. Lead types: "Dealer" and "Farmers"

Stored in `crm_settings.config.lead_form` (per org + client), written with `PATCH /api/v1/crm/settings`:

```json
{
  "config": {
    "lead_form": {
      "segment_labels": { "b2b": "Dealer", "b2c": "Farmers" },
      "address_on_b2b": true,
      "schedule_visit": { "segments": ["b2b"] }
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `segment_labels` | Replaces the words "B2B" / "B2C" on every lead surface (web, Android, iOS). 1–40 chars each. |
| `address_on_b2b` | Show the Location (address search + GPS pin) block on B2B leads too. Default: B2C only. |
| `schedule_visit.segments` | Which lead types get the *Schedule Visit* date-time control on create. |

`PATCH /crm/settings` shallow-merges top-level `config` keys, so `lead_form` replaces the previous
`lead_form` object as a whole. The server validates it (`leadFormConfigSchema`).

Field labels / visibility / required-ness come from the existing `config.field_overrides`
(`lead.<key>@b2b`, `lead.<key>@b2c`) — see the built-in field-override contract in each app's `CLAUDE.md`.

### Custom-field option tokens

Select-type custom fields (`crm_custom_field_defs.options: string[]`) accept two reserved tokens. They are
never shown to users; every client strips them with `visibleOptions()` (`src/lib/customFieldOptions.ts`).

| Token | Effect |
| --- | --- |
| `__searchable__` | Render the select as a type-ahead search list (used for **Crop**). |
| `__source:products__` | Options are the product names from the Products section (name only — no price). Also searchable. |

## 2. Schedule Visit

`POST /api/v1/crm/leads` accepts an optional, **create-only** block:

```json
{ "schedule_visit": { "due_at": "2026-10-12T10:30:00+05:30", "subject": "Dealer Visit — Sharma Agro", "type": "meeting" } }
```

The server creates a `planned` activity (default type `meeting`) assigned to the lead owner (or the creator)
in the same request, so it also works for offline-queued creates. The existing activity-reminder job
notifies the assignee ~30 minutes before `due_at`. If the activity cannot be created the lead is still saved
and the response carries `scheduled_visit_error` instead of `scheduled_visit`.

## 3. Daily allowance by vehicle + odometer

An admin sets the vehicle types and their per-km cost in the expense policy
(`rules.vehicle_rates`, in the expense policy editor):

```json
{ "vehicle_rates": [ { "label": "Two-wheeler", "rate_per_km": 4 }, { "label": "Car", "rate_per_km": 9 } ],
  "odometer_photos_required": true }
```

When a policy has at least one vehicle rate, a **mileage** line is no longer a typed distance:

* the rep picks the vehicle and enters the odometer **before** and **after** (plus a photo of each);
* the **server** computes `distance_km = after − before` and `amount = distance_km × rate`;
* saving a draft is lenient (only *after < before* is refused); **submitting** is blocked until vehicle,
  both readings and (unless `odometer_photos_required: false`) both photos are present;
* submit re-prices every vehicle line at the *current* rates;
* policies without `vehicle_rates` are untouched.

### One-time database migration (required before odometer data can be saved)

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f migrations/expense_odometer.sql
```

It is additive (`ADD COLUMN IF NOT EXISTS` on `expense_claim_items`). Until it has run, a claim line that
carries odometer data is refused with HTTP 409 `ODOMETER_NOT_ENABLED`; everything else keeps working.
Run it against the database the **Agrisynx** project uses, connecting as the table owner.

> Status: applied to the **Kinematic** project (Agrisynx's database) on 2026-10-07; the Tata project has
> not had it and does not need it unless it starts using vehicle allowances.
>
> `npm run db:migrate` calls an `exec_migration` RPC that the self-hosted AWS Postgres projects do not
> have, so use `psql` as above (from a task inside the VPC — the database is not publicly reachable).

## 4. Seeding the two lead forms

`src/tools/agrisynx-lead-forms.ts` writes the `lead_form` config, the field overrides (including the hidden
consent block, see 5.5) and the custom fields (Description, Shop Image, Crop, Suggested Product, Photo). It is idempotent.

```bash
TOKEN=<admin access token> CLIENT_ID=<agrisynx client uuid> \
  npx tsx src/tools/agrisynx-lead-forms.ts --dry-run   # preview
TOKEN=… CLIENT_ID=… npx tsx src/tools/agrisynx-lead-forms.ts
```

Optional: `API_URL` (default `https://api.kinematicapp.com`), `PROJECT` (`X-Kinematic-Project`, default
`kinematic`). Afterwards everything — labels, required flags, the crop list — can be edited in
Settings → Custom Fields. The crop list is a starting list.

| Dealer (B2B) | Farmers (B2C) |
| --- | --- |
| Shop Name (`company`) | Farmer Name (`first_name`) |
| Dealer Name (`first_name`) | Mobile Number (10-digit) |
| Location (`address_line1`, address search + GPS pin) | Location (address search + GPS pin) |
| Mobile Number (10-digit) | Crop (searchable dropdown) |
| Description: Dealer Visit / First Time Visit / Dealer Appoint / Order/Collection | Suggested Product (product name from Products) |
| Schedule Visit (date + time → activity + reminder) | Photo |
| Shop Image | |

## 5. Travel-only expenses, odometer scan & history, dashboard split, consent block

Everything below is **opt-in per client and defaults to today's behaviour**. A client that has none of it
configured (Tata included) gets byte-identical responses. Nothing here hard-codes the Agrisynx client: it
is all driven by the data in sections 5.1, 5.5 and 5.6.

### 5.1 Expense policy: presentation rules (`expense_policies.rules`)

Four optional keys on the policy rules. `GET /api/v1/expenses/policy` returns them in `data.rules`
(always present, with the defaults below, so an app can rely on them).

| Key | Type | Default | Meaning for the apps |
| --- | --- | --- | --- |
| `category_labels` | `{ <category>: string }` | `{}` | What to call a category, e.g. `{ "mileage": "Travel" }`. Trimmed, 1–30 chars; a blank label means "use the default name"; only the known categories (`mileage travel food lodging fuel toll misc`) are kept. Display only — the stored category and every rule keep the canonical key. |
| `route_fields` | boolean | `true` | `false` = no From / To on a mileage line. |
| `single_line` | boolean | `false` | `true` = a claim holds one line. |
| `odometer_camera_only` | boolean | `false` | `true` = odometer photos come from the camera only, never the gallery. |

* **UI only.** The server enforces none of `single_line`, `route_fields` or `odometer_camera_only`, so existing
  multi-line claims stay editable and an older app build keeps working.
* **Single-category mode is derived by the client**: exactly one `categories[c].enabled !== false`.
  A disabled category is still refused by the server as before (`category_not_allowed`, always blocking).
* **Saving from an editor that doesn't know these keys keeps them.** `PUT /expenses/policies/:id` replaces
  `rules` as a whole, but for these four keys only, a key the request leaves out keeps its stored value
  (a key that is sent — even `{}` or `false` — wins; omit `rules` entirely and nothing changes). So an older
  dashboard build re-saving a policy can no longer reset a configured client.
* Validation (`PUT/POST /expenses/policies`): a category name over 30 characters, or a non-boolean switch, is a 400.

Agrisynx's values:

```json
{
  "categories": { "mileage": { "enabled": true }, "travel": { "enabled": false }, "food": { "enabled": false },
                  "lodging": { "enabled": false }, "fuel": { "enabled": false }, "toll": { "enabled": false }, "misc": { "enabled": false } },
  "category_labels": { "mileage": "Travel" },
  "route_fields": false,
  "single_line": true,
  "odometer_camera_only": true
}
```

(merged into the policy's existing rules — its vehicle rates, limits and assignment are untouched.)

### 5.2 Odometer photo scan — `POST /api/v1/expenses/receipts?scan=odometer`

Same multipart upload as a receipt (field `file`), but the photo is read as an odometer instead of a receipt.

```json
{ "success": true, "data": {
    "url": "…", "path": "…", "bucket": "kinematic-receipts", "content_type": "image/jpeg", "size": 183422, "signed_url": "…",
    "scan": null,
    "odometer": { "reading": 45210, "confidence": "high" } } }
```

* `reading` is the **total-distance odometer (ODO) in whole kilometres**, digits only; `null` when the model is
  unsure, the photo isn't an odometer, a digit is unreadable, or the display is in miles. It never reads a trip
  meter (A/B), the clock, the fuel gauge or the speed. Separators are stripped, a tenths digit is dropped, and a
  reading outside 0–10,000,000 is treated as a misread (`null`). `confidence` is `high | medium | low | null`
  (`null` whenever `reading` is `null`).
* It is a **suggestion** the rep confirms on screen. A failed or timed-out scan never loses the upload: you still
  get 201 with the stored photo and `odometer: { reading: null, confidence: null }`. A file the model can't read
  (PDF, HEIC) is stored with an empty reading.
* `?scan=0` (store only) and the default (receipt scan, no `odometer` key) are unchanged.
* Model: `ODOMETER_SCAN_MODEL`, falling back to `RECEIPT_SCAN_MODEL` / `CARD_SCAN_MODEL` / `claude-haiku-4-5`
  (code: `src/services/expenses/odometerScan.service.ts`).

### 5.3 Odometer history — `GET /api/v1/expenses/odometer-history`

`?limit=50&from=YYYY-MM-DD&to=YYYY-MM-DD[&user_id=<uuid>][&all=1]` → `{ success: true, data: [ … ] }`, newest first
(`item_date` desc, then `created_at` desc). `limit` defaults to 50 and is capped at 200; `from`/`to` bound the line date.

```json
{ "id": "…", "claim_id": "…", "claim_no": "EXP-202610-1234", "claim_status": "draft", "user_id": "…", "user_name": "Asha",
  "item_date": "2026-10-06", "vehicle_type": "bike", "vehicle_label": "Two-wheeler",
  "odometer_start": 1000, "odometer_end": 1042.5, "distance_km": 42.5, "amount": 170,
  "start_photo_url": "https://…signed…", "end_photo_url": "https://…signed…", "created_at": "2026-10-06T10:00:00Z" }
```

* Default = **your own** lines. `user_id` (someone else) or `all=1` are for approvers only (`isApprover` in
  `access.ts`, i.e. admin-class roles; a field exec on a flat tenant is never one) → **403** otherwise, and they are
  scoped to the caller's org **and client**. (Asking for your own `user_id` is allowed.)
* Only lines with an odometer reading; cancelled claims are excluded (drafts are included).
* `vehicle_label` comes from the claimant's governing policy's `vehicle_rates`, falling back to `vehicle_type`.
  Photo links are short-lived signed URLs (`null` when absent).
* `[]` on a database that hasn't run `migrations/expense_odometer.sql`. Bad dates / ids are a 400.

### 5.4 CRM dashboard: `leads_by_segment`

`GET /api/v1/crm/analytics/dashboard-summary` and `/dashboard-complete` add

```json
"leads_by_segment": { "b2b": 120, "b2c": 340 }
```

— the **total** leads per lead type (`crm_leads.is_b2c` false = b2b, true = b2c), counted on exactly the same basis
as `total_leads` (same org / client / visibility scope, no date window). It appears **only** when the client's
`crm_settings.config.lead_form.segment_labels` is set (section 1); every other client gets the same response as
before. The CRM router wraps replies as `{ success, data }`, so read `data.leads_by_segment`, and for
`/dashboard-complete` `data.summary.leads_by_segment`. The 60 s cache is keyed per client, so one client's payload is
never served to another (changing `segment_labels` can take up to a minute to show).

### 5.5 Consent block: built-in field `data_consent`

The DPDP "Data Collection & Consent" block on the lead / contact create forms is the built-in field override
`lead.data_consent` (plus `lead.data_consent@b2b` / `@b2c`). Override keys are free-form, so nothing needed
whitelisting. Agrisynx hides it, and the dealer marketing / WhatsApp boxes, on both lead types
(`agrisynx-lead-forms.ts` and `agrisynx-app-config.ts` both write this):

```json
{ "lead.data_consent@b2b": { "hidden": true, "required": false }, "lead.data_consent@b2c": { "hidden": true, "required": false },
  "lead.marketing_consent@b2b": { "hidden": true, "required": false }, "lead.whatsapp_consent@b2b": { "hidden": true, "required": false } }
```

* **Not required** (the default): `POST /crm/leads` and `/crm/contacts` work without `_consent`, hidden or not.
* **Required** (`config.consent.lead_pii.required = true`): a lead create without `_consent.consented = true` is
  refused with `CONSENT_REQUIRED` **even if the block is hidden**. Hiding the block for a client that requires
  consent is the admin's responsibility — Agrisynx doesn't require it.

### 5.6 App tabs and home tiles (`clients.settings.app_ui`)

Pure data, nothing to build: `PATCH /api/v1/clients/:id` with `{ "app_ui": { … } }` writes it, and `GET /auth/me`
(and login) return it as `app_ui_config`. Checked: there is **no validator** on `app_ui`, so arbitrary keys under
`tabs` / `home` (e.g. `tabs.expenses`, `home.open_volume`) round-trip untouched. One caveat: the PATCH **replaces
`app_ui` as a whole** (it is not deep-merged), so always send the full object. Agrisynx:

```json
{ "tabs": { "expenses": true, "new_form": false }, "home": { "open_volume": false } }
```

(merged into whatever `tabs` / `home` / other groups are already there.)

### 5.7 Applying it: `src/tools/agrisynx-app-config.ts`

Everything in 5.1, 5.5 and 5.6 is expressible through existing endpoints, so there is a ready-to-run, idempotent tool
(an unchanged part is detected and not written again):

```bash
TOKEN=<admin access token> CLIENT_ID=<agrisynx client uuid> \
  npx tsx src/tools/agrisynx-app-config.ts --dry-run     # preview
TOKEN=… CLIENT_ID=… npx tsx src/tools/agrisynx-app-config.ts
```

Optional: `API_URL` (default `https://api.kinematicapp.com`), `PROJECT` (`X-Kinematic-Project`, default `kinematic`),
`POLICY_ID`. It:

1. **Expense policy** (`GET`, then `PUT`/`POST /expenses/policies`) — edits the client's own active policy in place
   (or the one named "Agrisynx field policy"); creates that policy (everyone, priority 10) if the client has none. It
   stops and asks for `POLICY_ID` when the client has several active policies, and **never edits an org-wide policy**
   (one shared with other clients).
2. **App UI** (`GET /clients`, then `PATCH /clients/:id`) — reads the current `app_ui`, merges the three keys, writes it back.
3. **Consent block** (`GET`, then `PATCH /crm/settings`) — merges the four hidden overrides into `field_overrides`
   (which the endpoint also replaces as a whole). A client with no settings row of its own yet inherits the org-level
   default config in the same write, so nothing it was being served is lost.

The token must be an admin who can edit the client in Client Management (`PATCH /clients/:id` needs an admin of the org
that owns it) and manage expense policies and CRM settings. If you'd rather apply the data directly in the database,
the values are exactly the JSON above.
