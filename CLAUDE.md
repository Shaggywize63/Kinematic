# Kinematic Backend — Agent Guide

Express + TypeScript API over **self-hosted Supabase on AWS** (see "Where the data lives" below —
there are no supabase.com cloud projects).
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

## Where the data lives — AWS, not supabase.com

Everything runs in AWS account `023620758744`, region `ap-south-1`, ECS cluster `kinematic`:

| Service (ECS) | What it is | Public host |
|---|---|---|
| `kinematic-backend` | this API (task def `kinematic-backend`) | `api.kinematicapp.com` |
| `kinematic-supabase` | **Kinematic tenant**: PostgREST + GoTrue + storage-api + nginx | `supabase-kinematic.kinematicapp.com` |
| `kinematic-supabase-tata` | **Tata tenant**: same stack | `supabase-tata.kinematicapp.com` |

- The backend reaches them via env `KINEMATIC_SUPABASE_URL` (Kinematic) and `SUPABASE_URL` (Tata).
- Postgres is RDS `kinematic-mumbai-test` (Postgres 17, **database `kinematic`** for the Kinematic tenant,
  master user `kinematic_admin` with an AWS-managed secret `rds!db-…`). It is named "test" but is the live
  Kinematic database. The Tata tenant's database location has not been verified here — check the
  `kinematic-supabase-tata` task definition's `DATABASE_URL` secret reference before touching it.
- The RDS instance is private (not publicly accessible). The **Supabase MCP connector cannot reach any of
  this** (it only sees supabase.com projects) — do not try it; the old project ids
  (`clldjlojtmrrpozydqxk`, `lnvxqjqfsxvtjvbzphou`) are stale.

### Running SQL / migrations (the pattern that works)
PostgREST caches the schema, so after DDL send `NOTIFY pgrst, 'reload schema'`.

1. Register a one-off Fargate task definition (family e.g. `kinematic-migrate`): image `postgres:17-alpine`,
   execution role `kinematic-ecs-task-execution` (it can read Secrets Manager), `awslogs` group
   `/ecs/kinematic`, and the DB login injected **by reference** — `secrets: DB_USER` / `DB_PASS` with
   `valueFrom` = `<rds! secret ARN>:username::` / `:password::` — so credentials never appear in a transcript.
2. The command runs `psql -h kinematic-mumbai-test.cj2yqwsi6udf.ap-south-1.rds.amazonaws.com -U $DB_USER -d kinematic
   -v ON_ERROR_STOP=1` with `PGSSLMODE=require`: **pre-check first** (db name, target table exists, owner), then
   apply with `-1` (single transaction), then verify, then `NOTIFY pgrst, 'reload schema'`.
3. Run it with `RunTask` using the same subnets / security group as the `kinematic-supabase` service
   (`sg-066697baa07f4e402`, public IP on so Docker Hub is reachable), read the result from the log stream,
   then deregister the task definition. Migrations must be additive and idempotent (`IF NOT EXISTS`).
4. Verify through the API, not just SQL: query the new column/table via
   `https://supabase-kinematic.kinematicapp.com/rest/v1/<table>?select=<col>&limit=1` with the service key.

## Default tenant for changes — Kinematic, not Tata

Unless the user **explicitly names** a tenant, ALL data, schema, config, SQL, and edge/cron operations default to
the **Kinematic** tenant (`kinematic-supabase`, database `kinematic`), NOT Tata. Only touch Tata (or any other
org) when the user names it.

Backend code in this repo is **shared** by both tenants, so when adding
multi-project features keep production behavior for the Tata `default` project
unchanged: route every no-explicit-project fallback through
`fallbackProjectKey()` in `src/lib/projects.ts`, which in production ALWAYS
falls back to `default` (Tata). Dev/tooling may default to Kinematic only
outside production via `DEV_DEFAULT_PROJECT` (never set it on the prod server).

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

## Deploy — AWS ECS (NOT Railway)
Hosting moved to **AWS ECS/Fargate** (ap-south-1): the `.github/workflows/
deploy-aws.yml` workflow builds the multi-arch Docker image, pushes it to ECR
`kinematic-backend:latest`, and force-new-deployments the `kinematic-backend`
ECS service in the `kinematic` cluster. It runs on **push to `main`** (so a
merge auto-deploys; `**.md`-only changes are skipped by `paths-ignore`). The
API is served at **https://api.kinematicapp.com** (`/health` returns 200).
Railway is no longer used — there is no `railway.json`.
