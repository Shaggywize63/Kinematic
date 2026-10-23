# eFocus — GPS travel + expenses on check-out, 6:30 PM check-out reminder, customer name on the travel report

Everything here is **opt-in per client** (same convention as `AGRISYNX.md`). A client that has none of it
configured behaves exactly as before. eFocus lives in the **Kinematic** Supabase project
(`clldjlojtmrrpozydqxk`); scope every change to eFocus's own `clients` row (its `client_id`) so Tata and
every other client is untouched.

## 1. Travel + expenses on check-out (GPS-distance model)

After the final check-out the app offers **"Add today's travel to expenses?"**, reads the day's GPS
distance (`GET /api/v1/attendance/travel`) and drafts a mileage claim priced per km; the rep can also log
other out-of-pocket expenses on the **Expenses** tab. This is existing app code
(`TravelPrompt` / `HomePrompts` on iOS, `TravelPromptLogic` on Android) gated purely by data:

```
app gate: expensesEnabled (app_ui.tabs.expenses) && policy.rules.gps_distance === true && vehicle_rates.length > 0
```

Turn it on for eFocus with the setup tool (idempotent; `--dry-run` shows the plan without writing):

```
TOKEN=<admin access token> CLIENT_ID=<efocus client uuid> \
  VEHICLE_RATES='[{"label":"Two-wheeler","rate_per_km":4},{"label":"Car","rate_per_km":10}]' \
  npx tsx src/tools/efocus-app-config.ts --dry-run
```

It makes two data changes against eFocus's own rows:

| Part | Endpoint | What it sets |
| --- | --- | --- |
| Expense policy | `PUT`/`POST /api/v1/expenses/policies` | `rules.gps_distance = true`, `rules.vehicle_rates` (seeded from `VEHICLE_RATES` only when the policy has none — an admin's dashboard rates are never overwritten), mileage labelled **"Travel"**, the out-of-pocket categories enabled. Only the client's own policy is edited; an org-wide (`client_id` null) policy is refused as shared. |
| Expenses tab | `PATCH /api/v1/clients/:id` | `clients.settings.app_ui.tabs.expenses = true` (merged into the existing `app_ui`). |

`VEHICLE_RATES` is only required when eFocus has no expense policy / no vehicle rates yet — `gps_distance`
cannot price travel without at least one vehicle, and the tool refuses rather than invent a rate. No
schema migration is needed: a GPS claim stores only `distance_km` + `vehicle_type` on the existing
`expense_claim_items` columns.

## 2. Fixed-time check-out reminder (6:30 PM IST)

Opt eFocus in to a **clock-time** check-out reminder (default 6:30 PM IST) instead of the default
"10 hours after check-in" one. Set it on eFocus's `clients.settings`:

```json
{ "attendance_checkout_reminder_time": "18:30" }
```

Also accepts `true` (⇒ default 18:30) or `{ "enabled": true, "time": "18:30" }`. The attendance sweep
(`src/services/attendanceSweep.service.ts`, runs every ~5 min across all projects) then, once the IST
clock has passed that time, reminds every eFocus rep still on an open shift that **started before** that
time today — once per shift per day. The relative 10-hour reminder is **suppressed** for a client that
configured a fixed time, so a rep gets exactly one nudge. The push reuses the `checkout_reminder` kind
(so the tap still deep-links to Attendance) and is marked `data.scheduled: true`. See
`docs/NOTIFICATIONS.md` row 22b.

## 3. Customer name on the Daily Travel Report

A customer-visit row on the Daily Travel Report now carries the **customer / outlet name** the rep
checked the form in at (`form_submissions` / `builder_submissions` `outlet_name`, else `store_name`),
alongside the form title. This is a global, additive change (backend `travel.service.ts` →
`dailyReport.service.ts`; dashboard `DayReport` row + map marker + the CSV "Customer" column) — it only
surfaces data already on the submission, so every client simply gains the column; nothing is gated on
eFocus. Visits are form check-ins, which carry no CRM lead link; the customer identity is the outlet.

## What to confirm / supply before flipping it on

- eFocus's **`clients.id`** (UUID) in the Kinematic project, and an **admin token** for the org that owns it.
- eFocus's **per-km vehicle rates** for part 1 (`VEHICLE_RATES`) — unless a policy with rates already exists.
- That eFocus reps' JWT is pinned to eFocus's `client_id` (or admins pick eFocus via `X-Client-Id`), so the
  per-client policy / app_ui / reminder actually resolve to them.
