# Kinematic Backend — Agent Guide

Express + TypeScript API over Supabase (Postgres project `lnvxqjqfsxvtjvbzphou`).
Consumed by the web dashboard (`kinematic-dashboard`), iOS (`Kinematic-iOS`) and
Android (`Kinematic-App`) apps.

Key conventions:
- CRM routes live in `src/routes/crm.routes.ts`, mounted under `/api/v1/crm`.
- Generic list/CRUD helpers: `src/services/crm/crud.service.ts`. **The generic
  list helper applies any non-reserved query-string key as `.eq(key, value)`** —
  so a filter only works if that column exists and is the *right* one. Examples
  of where this bites:
  - Activities track the person via **`assigned_to`** (often with `owner_id`
    null), so an owner filter must match `owner_id` **OR** `assigned_to`.
  - `crm_activities` has **no geo columns** — filter by city via the linked
    lead (`activity.lead_id → leads.city`), not `.eq('city')`.
- **Multi-tenant.** Use `orgId(req)` + `clientScope(req)` (from `X-Client-Id`).
  `crud.clientScopedList*` adds the client filter; pass `strictClient` for real
  tenant isolation (leads/deals/contacts/accounts) vs shared lookup tables.

## Golden rule: wire BOTH ends for every new module / feature

A green typecheck does **not** mean a feature works. Most bugs have been
"half-wired". Before calling anything done, verify the whole chain:

1. **DB** — table/columns exist **and are populated** (query real data).
2. **Backend** — route mounted + service implemented; query params applied to
   the **right** columns; UUIDs validated before interpolating into PostgREST
   `.or()`; tenant/client scoping correct; `npx tsc --noEmit` clean.
3. **API client** (in `kinematic-dashboard`) — a typed method points at the
   route and sends the params/headers it needs.
4. **Frontend** — control present and populated; state sent; refetch wired on
   change; global filters (city scope) subscribed to.
5. **Render** — lists sort/group by the persisted field (e.g. `position`).
6. **Parity** — list and CSV-export endpoints share the same filters; the same
   capability is wired on iOS/Android where it should appear.
7. **Verify against real data**; state explicitly what you could not verify.

## Build / check
- `npx tsc --noEmit`.
