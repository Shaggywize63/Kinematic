# Support tickets

Customers raise tickets; the Kinematic team works them in one inbox; the customer hears back on WhatsApp and in the app.

Code: `src/services/support/supportTickets.service.ts`, `src/controllers/support.controller.ts`,
`src/routes/support.routes.ts` (dashboard), `src/routes/support-public.routes.ts` (KINI WhatsApp bot).
Tables: `support_tickets`, `support_ticket_events` (`migration_support_tickets.sql` then
`migration_support_tickets_v2.sql`, `migration_support_tickets_feedback.sql` then
`migration_support_tickets_attachments.sql`, all applied on boot — add any new one to
`src/scripts/gen_embedded_migrations.ts` and regenerate, or a fresh tenant boots on the old schema).

## Where tickets live

Always in the **Kinematic project**, whatever project the customer's data is in (Tata included), so there is one queue.
Each ticket keeps `project_key` + `org_id` of the customer so it can be shown back to them and so in-app notifications
land in the right project. Refs are `KM-5001` upwards (the old bot-only tickets used lower numbers).

## Ways in

| Channel | Who | How |
| --- | --- | --- |
| Dashboard → Help & Support | any logged-in user | `POST /api/v1/support/tickets`; the user is the contact (their mobile gets WhatsApp updates) |
| WhatsApp (Kinematic's number) | anyone; matched to a user by mobile in any project when possible | KINI bot → `POST /api/v1/support/public/tickets` (x-kini-key) |

## What a ticket says about itself

Three fields, all on the row (never custom-field jsonb), set by the customer and re-settable by the team:

| Field | Values | Who sets it |
| --- | --- | --- |
| `category` (the **type**) | `issue`, `bug`, `how_to`, `change_request`, `new_module`, `data_correction`, `access_request`, `billing`, `training`, `other` | customer picks, team retriages |
| `platforms` (text[]) | any of `web`, `android`, `ios`, `whatsapp`, `other` | customer picks; defaults from the channel (dashboard → `web`, WhatsApp → `whatsapp`) |
| `area` | `crm`, `attendance`, `distribution`, `orders`, `hrms`, `payroll`, `reports`, `dashboard`, `mobile_app`, `whatsapp_kini`, `admin_settings`, `integrations`, `billing`, `other` — or null | customer picks "not sure", team sets it |

`area` is deliberately the **generic Kinematic modules**. A client's own taxonomy belongs in custom fields — never add
a named value here for one client.

The pre-v2 category names are still accepted on input and mapped (`data` → `data_correction`,
`feature_request` → `new_module`); anything unknown becomes `other`. So older app builds and the bot keep working.

## Statuses

`open` → `triaged` → `in_progress` → `waiting_on_customer` → `release_pending` → `resolved` / `closed`, plus
`rejected` for "not planned". Active = everything up to and including `release_pending`; `resolved`, `closed` and
`rejected` are terminal (they stamp `resolved_at`).

- **Team** (platform operators in the dashboard; the owner's WhatsApp commands via the bot): any status / priority, and
  the triage fields (`category` / `platforms` / `area`), with an optional note. The note is what the customer is told;
  on a terminal status it is kept as `resolution_note`. The team's first status change or reply stamps
  `first_response_at` — once, and only for the team — which is what SLA reporting measures.
- **Customer**: can say it is fixed (`resolved`) or that it is still not working (`open` + note), and nothing else —
  the triage fields are rejected with a 403. A customer reply on a terminal or waiting ticket reopens it, `rejected`
  included.

## Screenshots

A customer can attach up to 5 images (PNG / JPEG / WEBP / HEIC, 8 MB each) when raising a ticket, from the
file picker, a drag-and-drop, or by **pasting straight from the clipboard** — which is how a screenshot
usually arrives. `services/support/supportAttachments.ts`.

Two things worth knowing:

- **The files live in the support project's own private bucket**, never the customer's. The generic
  `POST /upload/:type` writes to whichever project the caller is in, so a screenshot uploaded by a Tata user
  would sit in Tata's storage and a platform operator (who works in the Kinematic project) could never be
  issued a signed URL for it. One bucket in the support project serves both sides.
- **The object path carries the org** (`support/<org_id>/<uuid>.<ext>`). The browser uploads *before* the
  ticket exists, so the create call receives client-supplied descriptors; `toAttachments` refuses anything
  outside the requester's own prefix. Without that, a customer could name another customer's object id and be
  handed a signed URL for their screenshot. A descriptor that fails validation is dropped rather than failing
  the ticket — the report matters far more than the picture.

`POST /tickets/attachments` (field `photos`, the shared `uploadMultiple` middleware) returns descriptors;
`GET /tickets/:id` returns them with short-lived signed URLs, and only for a ticket the caller may already
see. The bucket is created on first use, so no environment needs manual setup.

## Customer feedback (CSAT)

Once a ticket is `resolved`, `closed` or `rejected`, the customer rates how it was handled 1–5 with an optional
comment (`csat_rating` / `csat_comment` / `csat_at`, `migration_support_tickets_feedback.sql`). It is
re-submittable — changing your mind should not need a ticket of its own — the team is alerted, and the rating
joins the timeline as a `feedback` event so it reads in context. `POST /tickets/:id/feedback { rating, comment? }`;
the team is refused with a 403, and rating a ticket still in progress with a 400.

## Who is told

- **Customer**, on every team status change or reply:
  - By **email** (`services/support/supportEmail.ts` → the shared `sendEmail`, so it lands in `crm_email_logs`):
    a confirmation when the ticket is raised, then every status change and team reply. Sent from
    `SUPPORT_FROM_EMAIL` (default `support@kinematic.app` — the domain Resend has verified), logged under the
    support org, with suppression bypassed because the customer opened the ticket themselves, and link tracking
    off. The email quotes the team's own note, **never** the WhatsApp rendering of it — that copy is full of
    `*asterisks*` and "reply reopen KM-…" directions that mean nothing in an inbox.
  - WhatsApp from Kinematic's own number (the org whose CRM WhatsApp connection is `SUPPORT_WHATSAPP_NUMBER`, default
    919220299228, or `SUPPORT_ORG_ID`): free-form when they wrote in the last 23 h (checked in `crm_whatsapp_logs`,
    which the bot fills by forwarding every message), else the approved `handoff_reply` template once synced, else
    nothing (the API answer says why).
  - In the app: a notification to the user who raised it, in their project, with
    `data.kind = support_ticket_update` — the kind registered in `lib/notificationCatalog`.

    **That registration is what lets the push leave the building.** `dispatchPendingPushes` runs every row
    through `allowedFlags`, which suppresses any kind missing from the catalogue *and* any kind a client has not
    switched on (`org_settings` → `notifications.enabled_kinds`). Before the kind existed there, every support
    notification was stamped `sent_at` and never pushed: it showed only in the in-app list, and
    `countUnreadAllowed` left it out of the mobile unread badge. `support_ticket` is kept as an alias so earlier
    rows still resolve. A client that switches the kind off keeps the in-app row and loses the push — which is
    what switching it off ought to mean.
- **Team**, when a customer raises / replies / reopens / confirms from the dashboard: the support org's own WhatsApp
  alerts (Client Management → WhatsApp alerts on Kinematic: its template and people). WhatsApp-raised tickets and
  WhatsApp replies are announced by the bot to the owner instead.

## KINI tools (agentic v2)

`src/services/crm/ai/tools/support.tools.ts`, registered in `kiniToolsV2.service.ts`, so they reach a tenant only
where the **`kini_agentic_v2`** flag in `org_settings` is on.

| Tool | Does |
| --- | --- |
| `support_raise_ticket` | Raises a ticket for the caller's org; KINI infers category / platforms / area from the conversation |
| `support_my_tickets` | The org's tickets with per-status counts; takes the same status / category / platform / area filters as the list API |
| `support_ticket_status` | One ticket plus its timeline, by reference |
| `support_reply_ticket` | The customer's reply; reopens a terminal ticket rather than duplicating it |
| `support_confirm_fixed` | The one status change a customer may make |

KINI is also *told* about support: `SUPPORT_SYSTEM_GUIDANCE` (`services/crm/ai/kiniSupportGuidance.ts`) is
added to both v2 system prompts, and the scope line now reads "…Admin and Support". Registering the tools is
not enough on its own — without the guidance the prompt describes KINI's scope without support, so it holds
the tools while being told the job is somebody else's. The bias is **answer first, raise second**, with one
firm exception: never guess about a feature or about the customer's data; say so and offer a ticket.

**What KINI can and cannot answer today.** Ticket questions are fully covered — status, what is open, adding
to a thread, confirming a fix. Product how-tos are only as good as the knowledge the org has given it:
`ai_domain_context` in `org_settings` (see `services/crm/ai/orgAiContext.ts`) is appended to the prompt as
"Company and product knowledge", and is the no-code place to put help content. There is no FAQ or
knowledge-base table, and `learning_materials` with category `Support` holds uploaded FILES (title +
`file_url`), whose contents KINI cannot read — so it is not an answer source.

Two boundaries these tools keep, deliberately:

- **Customer-side only.** Every tool acts as `{ type: 'customer' }` and scopes every read to the caller's project +
  org. KINI's tool context carries no email, so `isPlatformOperator` cannot be evaluated there; rather than guess,
  the tools never grant team powers. Operators work other customers' tickets in the dashboard inbox.
- **A ticket that isn't theirs reads as missing**, never as "forbidden", so a reference cannot be used to probe for
  other customers.

Note for whoever first tightens `ROLE_TOOL_POLICY` in `kiniTools.service.ts`: it is empty (fully permissive) today, so
every role can use these. An allow-list added for a role would also have to include the `support_*` tools, or that
role would lose the ability to raise a ticket through KINI while still having it on the web page.

## Bot API (`/api/v1/support/public`, header `x-kini-key` = `SUPPORT_BOT_KEY` or `KINI_WEB_CHAT_KEY`)

- `POST /tickets` `{ phone, name?, text, subject?, category?, platforms?, area? }` → `{ ticket }`
- `GET /tickets?phone=…&status=all|active|<status>` → the number's tickets; `?team=1&status=active` → everyone's
- `POST /tickets/:ref/comments` `{ phone, text }` and `POST /tickets/:ref/reopen` `{ phone, text }` (the phone must
  match the ticket's contact)
- `PATCH /tickets/:ref` `{ status?, priority?, note?, category?, platforms?, area?, by? }` → team update, returns
  `customer_notified`

## Dashboard API (`/api/v1/support`, JWT)

- `GET /tickets?status=active|all|<status>&q=…&category=…&platform=…&area=…` — the filters narrow the rows **and** the
  status counts, so the tabs never disagree with the list. `q` is operator-only in the UI.
- `POST /tickets` `{ subject, description, category?, priority?, platforms?, area? }`
- `GET /tickets/:id`, `POST /tickets/:id/comments` `{ body }`,
  `PATCH /tickets/:id` `{ status?, priority?, note?, category?, platforms?, area? }`
