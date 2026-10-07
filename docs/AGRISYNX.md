# Agrisynx — Dealer / Farmer lead forms, scheduled visits, vehicle allowance

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

`src/tools/agrisynx-lead-forms.ts` writes the `lead_form` config, the field overrides and the custom fields
(Description, Shop Image, Crop, Suggested Product, Photo). It is idempotent.

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
