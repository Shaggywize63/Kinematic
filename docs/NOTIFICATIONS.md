# Kinematic — Notification Catalog

Every notification in the platform, across **Lead Management (CRM)**, **Field
Force**, and **Supply Chain / Distribution**, plus the cross-cutting system
alerts. This is the single reference for "what fires, to whom, and how".

## How a notification is delivered (the pipeline)

There is exactly **one** delivery path, and everything funnels through it:

1. A row is inserted into `public.notifications` with `sent_at = NULL`.
2. The **`dispatch-pushes`** cron (every minute) fans unsent rows out to
   **FCM** (Android) and **APNs** (iOS) push, then stamps `sent_at`.
3. The **in-app bell** (dashboard + mobile) reads the same table directly.

So *creating the row is the whole job* — if a row lands, it is delivered on all
channels the recipient has a token for, plus the bell.

### Reliability rules (why notifications now actually arrive)

- **`type` is mostly `'general'`.** `notification_type` is a Postgres ENUM;
  inserting an unknown value fails **silently** and the notification vanishes.
  (This is what previously dropped `security_alert` / `daily_briefing` and the
  `automation` action.) Prefer `'general'` plus **`data.kind`** for anything
  new — no schema change ever needed for a new notification kind. See
  `src/services/notify.ts`. (Some older writers use their own row `type`: `leave`,
  `attendance`, `route_deviation`, `sos`, `security_alert`, `mention`, `message`,
  `broadcast`, `daily_briefing`, `crm_activity_due`, `crm_conversation`,
  `finance_invoice_due` — each must exist in the enum of every tenant database.)
- **`data.kind` is the routing key** the mobile apps open a screen from. Older
  writers used other conventions (`data.type`, `data.nudge_kind`, or nothing but
  the row `type`), so the server **normalises** it where a row leaves the server —
  in the push payload and in `GET /notifications` — see "Tap routing" below. A
  kind with no dedicated screen still shows the push and the bell entry;
  delivery never depends on the client knowing the kind.
- **Best-effort**: a failed insert is logged, never thrown, so a notification
  can never break the business action (or scan) that triggered it.
- **Deduped**: scan-driven alerts de-dupe so a re-run never double-notifies —
  either via a per-row `*_alerted_at` column or by checking the notifications
  table itself (keyed on `data.kind` + the entity id).

### Tap routing — one `kind` per notification

`src/lib/notificationRoute.ts` resolves a row's discriminator, in this order:
`data.kind` → `data.type` (leave, attendance regularization, route deviation,
call analysis) → `data.nudge_kind` (as `kini_<nudge>`) → the row `type`
(sos, security_alert, mention, message, broadcast) → `general`. The result is
always present as `data.kind` in **both** the FCM/APNs payload and the rows
returned by `GET /notifications`, so a tap on a push and a tap in the in-app list
route identically. Stored rows are not modified and older app builds simply see
one extra key.

The apps map `kind` plus the entity ids below to a screen. When a kind is unknown
or its id is missing they fall back to the in-app notification list.

| `kind` | Entity keys in the payload | Opens |
|--------|----------------------------|-------|
| `lead_assigned`, `new_lead`, `lead_pending_approval`, `lead_approval_decided`, `lead_from_google_ads`, `conversation_ready`, `crm_lead_stagnant`, `crm_lead_*escalation` | `lead_id` | Lead detail |
| `deal_assigned`, `deal_won`, `deal_lost`, `deal_stage_changed`, `crm_deal_closing_soon`, `crm_deal_overdue` | `deal_id` | Deal detail |
| `activity_assigned`, `crm_task_overdue` | `activity_id`, and `lead_id` / `deal_id` when linked | The linked lead (else deal), else Activities |
| `automation` | `entity` (`lead`/`deal`/`contact`/`account`) + `entity_id` | That record |
| `expense_submitted`, `expense_decision`, `expense_escalated`, `expense_reimbursed`, `expense_cancelled` | `claim_id` | Expense claim |
| `leave_request`, `leave_cancelled` (both go to the approver) | `request_id` | Leave approvals |
| `leave_decision` | `request_id`, `decision` | My leave |
| `att_reg_request` / `att_reg_decision` | `request_id` | Regularizations |
| `missed_visits` | `plan_id`, `plan_date` | Route plan |
| `sos` | `sos_id`, `exec_id`, `lat`, `lng` | SOS |
| `message` | `thread_id` | Chat thread |
| `mention` | `source_kind`, `source_id`; `thread_id` (chat) or `lead_id` (lead update) | The chat thread, or the lead; else the notification list |
| `broadcast` | `broadcast_id` | Broadcasts |
| `crm_home` | — | CRM Home |
| `kini_cold_deals` | `count` | Deals |
| `kini_no_checkin` | — | Attendance / check-in |
| `low_stock`, `stock_expiry` | — (`batch_id`, `sku_id` for expiry) | Stock |
| anything else (`route_deviation`, `security_alert`, `location_off`, `kini_reminder`, `finance_invoice_due`, …) | — | The notification list |

Keep ids under these key names when adding a notification, and prefer
`data.kind` over `data.type` / `data.nudge_kind` for anything new.

### Shared helper — `src/services/notify.ts`

- `notify({ orgId, userId, title, body, kind, data?, type? })` — one recipient.
- `notifyUsers(userIds, { orgId, title, body, kind, data? }, { exclude })` — many.
- `resolveManagers(orgId, { supervisorId?, clientId?, roles? })` — resolves the
  supervisor + org admins/managers for team-level alerts.

---

## 1. Lead Management (CRM)

| # | Event / trigger | `data.kind` | Recipient | Fires via |
|---|-----------------|-------------|-----------|-----------|
| 1 | **New lead assigned** to an owner (create) | `lead_assigned` | Lead owner | inline — `createLead` **(new)** |
| 2 | **Lead reassigned** to a new owner (edit) | `lead_assigned` | New owner | inline — `updateLead` **(new)** |
| 3 | Lead captured, **awaiting approval** | `lead_pending_approval` | Rep's supervisor / an admin | inline — `notifyLeadApprover` |
| 4 | Lead approval **approved / rejected** | `lead_approval_decided` | Lead creator | inline — `decideLeadApproval` |
| 5 | **Inbound Google-Ads lead** | `lead_from_google_ads` | Owner / managers | inline — dedup orchestrator |
| 6 | **New deal assigned** to an owner | `deal_assigned` | Deal owner | inline — `createDeal` **(new)** |
| 7 | Deal moved to a **Won** stage | `deal_won` | Deal owner | inline — `updateDeal` **(new)** |
| 8 | Deal moved to a **Lost** stage | `deal_lost` | Deal owner | inline — `updateDeal` **(new)** |
| 9 | Deal **stage changed** (other) | `deal_stage_changed` | Deal owner | inline — `updateDeal` **(new)** |
| 10 | **Activity assigned** (call / meeting / task) | `activity_assigned` | Assignee | inline — `createActivity` **(new)** |
| 11 | **Activity reminder** — scheduled activity now due | `crm_task_overdue` (+ related) | Assignee / owner | scan — `dispatch-activity-reminders` |
| 12 | Stagnant-lead / escalation / deal-closing / deal-overdue nudges | `crm_lead_stagnant`, `crm_lead_escalation`, `crm_deal_closing_soon`, `crm_deal_overdue` | Owner | cron reminders |
| 13 | **Automation** "send notification" action | `automation` | Configured recipient | inline — automation engine **(fixed: was writing `metadata`, silently undelivered)** |
| 14 | **Daily home summary** @ 09:00 IST — new leads today, open/at-risk leads, activities due/overdue; a tap opens lead-management **Home** | `crm_home` | Every active rep with leads **or** activity | scheduled — daily-briefing tick / `dispatch-daily-briefings` |
| 15 | **KINI scheduled reminder** (user-set from chat) | `nudge_kind:reminder` | The user | scheduled — `kini-scheduled` |
| 16 | **KINI proactive**: cold deals / no check-in today | `nudge_kind:cold_deals`, `no_checkin` | Owner / rep | scheduled — `kini-proactive` |
| 17 | **Team / DM message** | (messaging) | Thread members | inline — messaging service |

## 2. Field Force

| # | Event / trigger | `data.kind` | Recipient | Fires via |
|---|-----------------|-------------|-----------|-----------|
| 18 | **Location tracking turned off / denied / restricted** | `location_off` | Rep's supervisor + managers | inline — `updateLocationStatus` **(new)** |
| 19 | **Missed planned visits** (outlet on a past-dated beat never checked into) | `missed_visits` | Rep (self) **and** supervisor + managers | scan — `missed-visit-scan` **(new)** |
| 20 | **Off-route visit** (check-in beyond the outlet geofence) | `route_deviation` | Rep's supervisor | scan — `route-deviation-scan` |
| 21 | **SOS / panic** raised | (sos) | Managers / safety contacts | inline — SOS controller |
| 22 | **Attendance regularization** request / decision | (attendance) | Rep / approver | inline — attendance service |
| 23 | **Leave** request / decision | (leave) | Rep / approver | inline — leave service |
| 24 | **Expense** submitted / decided | (expense) | Rep / approver | inline — expenses service |

## 3. Supply Chain / Distribution

| # | Event / trigger | `data.kind` | Recipient | Fires via |
|---|-----------------|-------------|-----------|-----------|
| 25 | **Stock nearing expiry** — open batch within its SKU's alert window (`expiry_alert_days`, else 30 days) | `stock_expiry` | Org managers | scan — `stock-expiry-scan` **(new)** |
| 26 | **Low stock / reorder needed** — SKUs running low vs. projected demand (reuses the replenishment velocity engine) | `low_stock` | Org managers | scan — `low-stock-scan` **(new)** |
| 27 | **Auto-replenishment** draft order created | *(no notification today — draft appears in the replenishment UI)* | — | `auto-replenishment` |

## 4. System / cross-cutting

| # | Event / trigger | Recipient | Fires via |
|---|-----------------|-----------|-----------|
| 28 | **Broadcast push** (WhatsApp/push campaign) | Targeted audience | scheduled — broadcast pacing |
| 29 | **Security alert** (suspicious sign-in etc.) | The user / admins | inline — security service |

---

## Scheduling — how the scans actually run

Every scan is available two ways, so it fires reliably regardless of external
cron wiring:

1. **In-process schedulers** (`src/server.ts`) — the primary, self-contained
   path. Each runs across **all tenant projects**, is idempotent, and is
   toggle/tunable by env var:

   | Scheduler | Default cadence | Toggle | Interval / hour env |
   |-----------|-----------------|--------|---------------------|
   | **Push dispatch** (delivers unsent rows → FCM/APNs, all tenants) | every 60 s | `CRM_PUSH_DISPATCH_ENABLED` | `CRM_PUSH_DISPATCH_INTERVAL_SEC` |
   | Daily home summary | daily @ 03:30 UTC (09:00 IST) | `CRM_DAILY_BRIEFING_ENABLED` | `CRM_DAILY_BRIEFING_HOUR_UTC` / `CRM_DAILY_BRIEFING_MINUTE_UTC` |
   | Activity reminders | every 5 min | `CRM_ACTIVITY_REMINDER_ENABLED` | `CRM_ACTIVITY_REMINDER_INTERVAL_SEC` |
   | Route-deviation scan | every 30 min | `FF_DEVIATION_SCAN_ENABLED` | `FF_DEVIATION_SCAN_INTERVAL_SEC` |
   | Missed-visit scan | daily @ 16:00 UTC (21:30 IST) | `ALERT_SCANS_ENABLED` | `MISSED_VISIT_SCAN_HOUR_UTC` |
   | Stock-expiry scan | daily @ 04:00 UTC (09:30 IST) | `ALERT_SCANS_ENABLED` | `STOCK_EXPIRY_SCAN_HOUR_UTC` |
   | Low-stock scan | daily @ 04:00 UTC (09:30 IST) | `ALERT_SCANS_ENABLED` | `LOW_STOCK_SCAN_HOUR_UTC` |

   (Pre-existing in-process schedulers: automations, report digests, daily
   briefing, broadcast/email pacing, auto-replenishment.)

2. **Cron endpoints** (`src/routes/cron.routes.ts`, gated by
   `KINEMATIC_EDGE_SECRET`) — the same jobs, callable by pg_cron / an edge
   function / a manual `POST`. Each takes `{ all_projects: true }` to fan out
   across every tenant:

   - `POST /api/v1/cron/dispatch-pushes` — the delivery fan-out (every minute).
   - `POST /api/v1/cron/dispatch-activity-reminders`
   - `POST /api/v1/cron/route-deviation-scan`
   - `POST /api/v1/cron/missed-visit-scan` **(new)**
   - `POST /api/v1/cron/stock-expiry-scan` **(new)**
   - `POST /api/v1/cron/low-stock-scan` **(new)**
   - plus the existing digest / briefing / kini / replenishment jobs.

## Self-gating & tenant safety

The new scans change nothing for tenants that don't use the feature:

- **Missed-visit**: no route plans → zero rows → no-op.
- **Stock-expiry**: no `distribution_stock_batches` → no-op.
- **Low-stock**: no distributors / no sell-out history → no suggestions → no-op.
- **Location-off**: only fires on a real transition into a problem state, and is
  suppressed entirely for clients with `disable_live_tracking`.

All follow the default-tenant rule: no explicit project → production fallback
(Tata `default`); the `all_projects` fan-out covers Kinematic + Tata + any
runtime client projects.
