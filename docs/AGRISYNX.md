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
* a policy with **exactly one** vehicle rate needs no choice: a mileage line that arrives without a `vehicle_type`
  is priced and stored with that vehicle (section 7.3);
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

Everything in 5.1, 5.5, 5.6 and section 6 (targets config) is expressible through existing endpoints, so there is a
ready-to-run, idempotent tool (an unchanged part is detected and not written again):

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
4. **Targets** (same `PATCH /crm/settings` as step 3) — enables `config.targets.types` = sales + collection (a type
   already listed keeps its label). Section 6 explains the table migration this needs.
5. **Lead owners** (same `PATCH /crm/settings` as step 3) — sets `config.lead_form.owner_assignment = "admin_only"`,
   keeping the other `lead_form` keys (the endpoint replaces `lead_form` as a whole, so the tool reads and merges).
   Section 7.

The token must be an admin who can edit the client in Client Management (`PATCH /clients/:id` needs an admin of the org
that owns it) and manage expense policies and CRM settings. If you'd rather apply the data directly in the database,
the values are exactly the JSON above.

## 6. Sales and Collection rupee targets

Reps log the orders they closed and the payments they collected, in rupees, in the app; a manager sets a **monthly**
rupee target per person / role / default; progress is the **running total for the current calendar month in IST**.
Opt-in per client; a client without the config (Tata included) has none of it and the lead targets behave exactly as before.

### 6.1 Config, migration

```json
{ "config": { "targets": { "types": [ { "key": "sales" }, { "key": "collection", "label": "Recovery target" } ] } } }
```

`PATCH /api/v1/crm/settings` (shallow-merged, so send the whole `targets` object). `key` is `sales` or `collection`; `label`
is optional (1–40 chars, default "Sales target" / "Collection target"); each key once. Absent or `types: []` = feature off.
The schema is `.strict()`: an unknown key or type is a 400. A target is an ordinary `crm_targets` row with metric
`sales_amount` / `collection_amount` and period `monthly` (`target_value` is a whole-rupee integer: the value is floored).
`crm_targets` itself is unchanged.

Entries live in a new table. **Apply the migration before reps log anything** — as the table owner, with psql, from a task
inside the VPC (like `expense_odometer.sql`; `npm run db:migrate` needs an `exec_migration` RPC the self-hosted projects lack):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f migrations/crm_target_entries.sql
```

It is additive (`CREATE TABLE / INDEX IF NOT EXISTS`, RLS on with no policies, the service role bypasses it). Until it has
run the API degrades instead of failing: `POST /entries` answers **409 `TARGET_ENTRIES_NOT_ENABLED`**, `/progress` reports
`achieved: 0`, and the entry history is `[]` (the check is cached, a negative answer for 30 s). Agrisynx's database only; the Tata
database does not need it.

### 6.2 Endpoints (`/api/v1/crm/targets/…`, CRM module)

Every new endpoint answers an empty / disabled result — not an error — for a client with no `config.targets`; only writes 400.

| Endpoint | Who | Response `data` |
| --- | --- | --- |
| `GET /types` | any CRM user | `{ types: [ { key, label, metric, period: "monthly", unit: "INR" } ] }` (`[]` when off) |
| `GET /progress` | any CRM user, for themself | `{ period_start, period_end, types: [ { key, label, target, achieved, pct, source } ] }` |
| `POST /entries` | any CRM user, for themself | 201, the entry (shape below) |
| `GET /entries` | own; approvers may pass `user_id` / `all=1` | `[ entry … ]`, newest first |
| `DELETE /entries/:id` | the owner within 24 h of logging it, an approver any time | `{ id }` |

* **`/progress`**: `period_start` / `period_end` are the first and last day of the current IST month (`YYYY-MM-DD`). `target` is
  resolved **user → role → level → default** (the client's own row beats an org-wide one), `null` when there is none (a `0` on a
  person clears the role's target for them); `source` is `user | role | level | default | null`; `achieved` is the sum of the caller's
  non-deleted entries of that kind dated inside the month (exact to the paisa); `pct = round(achieved / target × 100)` or `null`.
  The month is the **IST** calendar month: an entry dated the 31st counts to that month, and at 00:30 IST on the 1st (still the 31st in
  UTC) progress has already rolled over to the new month.
* **`POST /entries`** body `{ kind: "sales" | "collection", amount, lead_id?, note?, entry_date? }`. `amount` is a number above 0
  and up to 1,000,000,000, rounded to 2 decimals; `note` up to 500 chars; `lead_id` a uuid of a live lead **in the same org and
  client** (else 400); `entry_date` `YYYY-MM-DD`, default today in IST, **not in the future and not older than 31 days** (else 400).
  `kind` must be an enabled type (else **400 `TARGET_TYPE_NOT_ENABLED`**). The entry always belongs to the caller.
* **An entry** (also what `POST` returns): `{ id, kind, amount, entry_date, lead_id, lead_name, note, user_id, user_name, created_at }`.
* **`GET /entries`** `?kind=&from=&to=&limit=50[&user_id=][&all=1]` — `limit` defaults to 50, max 200; `from` / `to` bound
  `entry_date`; only enabled kinds are returned. `user_id` (someone else) and `all=1` are for approvers (`isApprover`: admin-class
  roles, never an own-scope field exec) → **403** otherwise, and are scoped to the caller's org **and client**. Naming yourself is allowed.
* **`DELETE /entries/:id`** soft-deletes (`deleted_at`; the entry stops counting). 404 when it does not exist or is not in the
  caller's org and client; 403 for the owner after 24 h or for anyone else who is not an approver.

### 6.3 The existing admin endpoints take `type`

`GET /targets`, `PUT /targets`, `GET /targets/levels`, `GET /targets/leaderboard` and `GET /targets/leaderboard-role` accept an
optional `type` (`sales` | `collection`; query on GET, body on PUT). **Without it they are exactly the lead target** (`leads_created`,
daily) — same queries, same responses. With it: it must be an enabled type, else **400 `TARGET_TYPE_NOT_ENABLED`**, and then

* `GET /targets?type=sales` and `PUT /targets {type, …}` work on the `sales_amount` / `monthly` rows, same shapes and the same
  manager-only / no-frontline-champion guards. `target_value` is validated as a number from 0 to 1,000,000,000 (a negative, a
  larger number or a non-number is a 400 `VALIDATION`) and floored to whole rupees; `user_id` / `org_role_id` /
  `hierarchy_level_id` must be uuids.
* `GET /targets/levels` and `/leaderboard-role` return what they always do (the org roles, and the one role the board is scoped to);
  there is nothing per type, so `type` is only validated.
* `GET /targets/leaderboard?type=sales` is the rupee board for the current IST month (`period` is ignored; same people as the
  lead board — the configured role, a non-manager pinned to their own):

```json
{ "type": "sales", "label": "Sales target", "metric": "sales_amount", "period": "monthly",
  "period_start": "2026-10-01", "period_end": "2026-10-31", "generated_at": "…",
  "stats": { "participants": 12, "total_target": 1200000, "total_achieved": 640000, "meeting_target": 3, "target_participants": 12,
             "top_performer": { "name": "Asha", "achieved": 120000 }, "lowest_performer": { "name": "Bala", "achieved": 0 } },
  "entries": [ { "user_id": "…", "name": "Asha", "role": "Dealer Rep", "target": 100000, "achieved": 120000, "pct": 120 } ],
  "role_id": null }
```

`target` / `pct` are `null` for someone with no target. As on the lead board, anyone with an org role, a target or an entry is listed.

## 7. Admin-only lead owners, and the sole-vehicle default (contract H)

Both are **opt-in by data** and default to today's behaviour; nothing hard-codes a client. The web dashboard and the
Android / iOS apps implement against exactly this.

### 7.1 `config.lead_form.owner_assignment`

```json
{ "config": { "lead_form": { "segment_labels": { "b2b": "Dealer", "b2c": "Farmers" }, "owner_assignment": "admin_only" } } }
```

* Optional, in the same `lead_form` object as section 1 (`PATCH /crm/settings` replaces `lead_form` as a whole, so send
  the whole object). The only value is `"admin_only"`; `null` or leaving it out clears it; anything else is a **400**.
  `GET /crm/settings` returns it inside `config.lead_form`. Absent / `null` = today's behaviour: whoever can assign
  leads today still can.
* **Admin** = the expenses notion, `isApprover` in `src/services/expenses/access.ts`: role `admin`, `super_admin`,
  `main_admin`, `org_admin`, `sub_admin` or `client`, **and** an org-role data scope that is not `own`. So a rep on a flat
  tenant (role `sub_admin`, scope `own`), a supervisor and a city manager are not admins here. (The CRM's older
  `OWNER_ASSIGN_ROLES` list in `crm.routes.ts`, which still runs afterwards, is a mass-assignment guard with no notion of
  data scope; this switch can only restrict on top of it.)
* Apps: when `owner_assignment === "admin_only"` and the signed-in user is not an admin, hide the owner picker (create and
  edit), bulk-assign and the import owner column. The server enforces it regardless.

What the server does for a client with the switch, when the caller is **not** an admin:

| Path | Result |
| --- | --- |
| `POST /crm/leads` | Any `owner_id` is **ignored**, the lead takes the normal default (see below). `schedule_visit` is unaffected: its activity goes to the lead's owner, which is now the creator. |
| `PATCH /crm/leads/:id` (there is no PUT) | An `owner_id` different from the lead's current owner (including `null`) is **403** `OWNER_ASSIGN_FORBIDDEN`, message `Only an admin can assign leads`. The unchanged owner (apps resend the whole object, case-insensitively equal) is accepted and not rewritten. |
| `POST /crm/leads/bulk-assign` | **403** `OWNER_ASSIGN_FORBIDDEN`. |
| `POST /crm/import/commit` (CSV with an owner / owner email column) | The owner columns are **ignored**: every row takes the default owner, and a row that matches an existing lead does not reassign it. |
| `POST /crm/marketing-visits/start` with a new `lead` | `lead.owner_id` is **ignored**, as on create. |
| KINI `crm_update_lead` (owner change) and `crm_bulk_reassign_leads`; MCP `update_lead` (owner change) | Refused with the same message (the assistant acts as the user). The unchanged owner is accepted. |
| `POST /crm/leads/:id/convert`, `/won`, `/reopen`, the Google Contacts sync | Nothing to enforce: they take no owner choice (convert's contact / account / deal inherit the lead's owner; the sync passes no owner, so imports take the default owner). |

The error body is the CRM envelope: `{ "success": false, "error": { "code": "OWNER_ASSIGN_FORBIDDEN", "message": "Only an admin can assign leads" } }`.

Never blocked, because no person is choosing: assignment rules and round-robin, automations / workflows, inbound
webhooks (web forms, Meta, Google Ads), the chatbot inbox and consumer registrations. They call the lead service directly.

**The default owner** when `owner_id` is omitted or ignored is: the first matching active assignment rule (a fixed user or
a round-robin pool) → the creator → `config.default_owner_id`. So with an assignment rule configured, a rep's lead can
still land on the rule's assignee (that is automation, left alone); with none, the rep owns what they create.
If the settings row cannot be read the switch is treated as off (and a warning logged), so a settings hiccup never
takes lead edits down for other clients.

Not covered (not leads): the owner of a deal, contact, account or activity.

### 7.2 Agrisynx's value

`src/tools/agrisynx-app-config.ts` writes `lead_form.owner_assignment = "admin_only"` (merged into the existing
`lead_form`; run before or after `agrisynx-lead-forms.ts`, which now also keeps it). `--dry-run` prints
`[dry-run] update settings: only an admin may choose a lead's owner (config.lead_form.owner_assignment=admin_only)`; a
second run prints `lead owners: already admin-only` and writes nothing.

### 7.3 Sole-vehicle default (expenses)

When a policy has **exactly one** `vehicle_rates` entry, a mileage line that arrives without a vehicle (`vehicle_type`
absent, `null`, `""` or blank) is priced at, and **stored with**, that vehicle. This applies in create, update, the
pre-submit check and submit (a draft saved without a vehicle gets it filled in at submit), so an older app build that
cannot pre-select the vehicle still produces a priced line and does not hit `vehicle_missing`. With two or more rates
nothing changes (the rep must pick), and a `vehicle_type` that is not in the policy is still an error as before.
Code: `soleVehicle` / `withSoleVehicle` in `src/services/expenses/vehicleAllowance.ts`.
