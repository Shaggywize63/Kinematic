# Pharma Desk-Calling + Customer Intelligence — Maa Mansha Pharma

The net-new pieces of the Maa Mansha Pharma onboarding (Field-Force + CRM
already ship). This doc is the **deploy runbook** — none of these steps run
automatically; apply them in order after review.

All day boundaries are **IST** (`Asia/Kolkata`, UTC+05:30).

## Pieces

| Layer | What |
|---|---|
| DB | `migration_crm_pharma_desk_calling.sql` — `crm_daily_call_tasks` (daily list + 3 dispositions, append-only) + `crm_customer_orders` (lightweight order ledger). |
| Backend | `src/services/crm/desk.service.ts`, `src/services/crm/customerIntel.service.ts`; routes `/crm/desk/*`, `/crm/customer-intel/*`; scans in `alertScans.service.ts` + cron endpoints. |
| Onboarding | `src/tools/onboard-maa-mansha.ts`. |
| Web | `kinematic-dashboard` — Calling Desk, Customer Intelligence, Owner Dashboard. |
| Mobile | iOS + Android calling-desk screens. |

## The 3 call statuses (fixed keys → client labels)

| key | label |
|---|---|
| `order_taken` | Call Connected – Order Taken (captures order value) |
| `order_pending` | Call Connected – Order Pending |
| `no_order` | No Order Today |

(`pending` = not yet called.) Labels live in `crm_settings.config.call_statuses`
so an admin can relabel without code.

## Deploy order

1. **Apply the migration** (kinematic project DB) via the one-off ECS migrate
   task described in `CLAUDE.md` → "Running SQL / migrations":
   pre-check → apply `migration_crm_pharma_desk_calling.sql` with `-1` → verify →
   `NOTIFY pgrst, 'reload schema'`. It is additive + idempotent.

2. **Deploy the backend** (merge to `main` → ECS auto-deploy).

3. **Onboard the client** — one-off ECS task on the backend image, kinematic
   project, service role:
   ```
   ONBOARD_MODE=inspect node dist/tools/onboard-maa-mansha.js   # resolves the client, no writes
   ONBOARD_MODE=dry     node dist/tools/onboard-maa-mansha.js   # logs the plan
   ONBOARD_MODE=commit  node dist/tools/onboard-maa-mansha.js   # applies
   ```
   The client row must already exist (created via Client Management). The script
   resolves org/client by name (`CLIENT_NAME`, default "Maa Mansha Pharma"), or
   pass `ORG_ID` / `CLIENT_ID` explicitly. It creates **no** field staff — load
   the real MR + desk roster afterwards (User Management), assigning each person
   to the **Desk Operator** or **MR** designation. The daily-list generator
   resolves desk operators by the "Desk Operator" designation name.

4. **Set the web client-id flag** — in `kinematic-dashboard`, set
   `NEXT_PUBLIC_MAA_MANSHA_CLIENT_ID` (or fill `MAA_MANSHA_CLIENT_ID` in
   `src/lib/clientFeatures.ts`) to the client id the onboarding printed, so the
   Calling Desk / Customer Intelligence / Owner Dashboard tabs appear for this
   client only. Do the same for the iOS/Android client flag.

5. **Load the customer master** — the daily list is generated from
   `crm_accounts` (the chemist/customer master) for this client. Each account's
   `owner_id` is the assigned MR (customer → MR by territory). Leads can also be
   included via `crm_settings.config.calling_desk.customer_source = 'both'`.

6. **Register the cron schedules** (edge-secret, same mechanism as
   `missed-visit-scan`; drive both tenants with `{ "all_projects": true }`):
   | endpoint | cadence |
   |---|---|
   | `POST /api/v1/cron/desk-uncontacted-scan` | late afternoon IST |
   | `POST /api/v1/cron/desk-pending-order-scan` | daily |
   | `POST /api/v1/cron/customer-dormant-scan` | daily |
   | `POST /api/v1/cron/customer-declining-scan` | daily / weekly |

## Daily flow

- A generator (manual **Generate Today's List** button, or wire
  `POST /crm/desk/generate` to a morning cron) builds today's list from the
  customer master — **idempotent**, only adding customers not already on today's
  list, so re-running never loses dispositions.
- Desk operators disposition each customer; **Order Taken** writes a
  `crm_customer_orders` row (source `desk`). MR field visits write the same
  ledger (source `field`) — one order history per customer.
- Reports + customer intelligence + alerts all read that ledger.

## Data retention

History is owned by `org_id` / `client_id`, not by the employee (`captured_by`
is provenance only), and both tables are append-only — so calling records,
orders and reports stay with the company even when staff leave.
