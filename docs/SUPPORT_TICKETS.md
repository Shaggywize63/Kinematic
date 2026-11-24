# Support tickets

Customers raise tickets; the Kinematic team works them in one inbox; the customer hears back on WhatsApp and in the app.

Code: `src/services/support/supportTickets.service.ts`, `src/controllers/support.controller.ts`,
`src/routes/support.routes.ts` (dashboard), `src/routes/support-public.routes.ts` (KINI WhatsApp bot).
Tables: `support_tickets`, `support_ticket_events` (`migration_support_tickets.sql`, applied on boot).

## Where tickets live

Always in the **Kinematic project**, whatever project the customer's data is in (Tata included), so there is one queue.
Each ticket keeps `project_key` + `org_id` of the customer so it can be shown back to them and so in-app notifications
land in the right project. Refs are `KM-5001` upwards (the old bot-only tickets used lower numbers).

## Ways in

| Channel | Who | How |
| --- | --- | --- |
| Dashboard → Help & Support | any logged-in user | `POST /api/v1/support/tickets`; the user is the contact (their mobile gets WhatsApp updates) |
| WhatsApp (Kinematic's number) | anyone; matched to a user by mobile in any project when possible | KINI bot → `POST /api/v1/support/public/tickets` (x-kini-key) |

## Statuses

`open` → `in_progress` → `waiting_on_customer` → `resolved` / `closed`. Active = the first three.

- **Team** (platform operators in the dashboard; the owner's WhatsApp commands via the bot): any status / priority,
  optional note. The note is what the customer is told; on resolve / close it is kept as `resolution_note`.
- **Customer**: can say it is fixed (`resolved`) or that it is still not working (`open` + note). A customer reply on a
  resolved, closed or waiting ticket reopens it.

## Who is told

- **Customer**, on every team status change or reply:
  - WhatsApp from Kinematic's own number (the org whose CRM WhatsApp connection is `SUPPORT_WHATSAPP_NUMBER`, default
    919220299228, or `SUPPORT_ORG_ID`): free-form when they wrote in the last 23 h (checked in `crm_whatsapp_logs`,
    which the bot fills by forwarding every message), else the approved `handoff_reply` template once synced, else
    nothing (the API answer says why).
  - In the app: a notification to the user who raised it, in their project (`data.kind = support_ticket`).
- **Team**, when a customer raises / replies / reopens / confirms from the dashboard: the support org's own WhatsApp
  alerts (Client Management → WhatsApp alerts on Kinematic: its template and people). WhatsApp-raised tickets and
  WhatsApp replies are announced by the bot to the owner instead.

## Bot API (`/api/v1/support/public`, header `x-kini-key` = `SUPPORT_BOT_KEY` or `KINI_WEB_CHAT_KEY`)

- `POST /tickets` `{ phone, name?, text, subject?, category? }` → `{ ticket }`
- `GET /tickets?phone=…&status=all|active|<status>` → the number's tickets; `?team=1&status=active` → everyone's
- `POST /tickets/:ref/comments` `{ phone, text }` and `POST /tickets/:ref/reopen` `{ phone, text }` (the phone must
  match the ticket's contact)
- `PATCH /tickets/:ref` `{ status?, priority?, note?, by? }` → team update, returns `customer_notified`
