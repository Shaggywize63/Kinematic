# Onboarding a new client (per-customer Supabase project)

Each customer runs on its **own Supabase project** for hard data isolation, with
a **Production org** and a **Staging org** inside it. Develop in Staging, then
`promote_org_config` to Production. This runbook is the repeatable per-client
setup; steps 1–6 should eventually be wrapped in a script.

> Reference implementation already done for **Kinematic**:
> project `clldjlojtmrrpozydqxk`, prod org `1111…`, staging org `2222…`.
> **Tata** stays on the original project untouched (default project).

## 1. Create the Supabase project
- Region: match the fleet (`ap-southeast-2`).
- Upgrade to **Pro** before go-live (Free projects auto-pause).

## 2. Replicate the schema
- Copy the full `public` schema from an existing project (enums, tables,
  functions, triggers, RLS, indexes). Verify object-count parity:
  `tables / enums / functions / triggers / policies / indexes / matviews / views / fkeys`.

## 3. Create the orgs + seed config
- Insert the **Production** org row in `organisations` (unique `slug`).
- Either seed fresh defaults — `select crm_seed_defaults(<prod_org>);` and
  `select crm_seed_indian_locations(<prod_org>);` — or clone an existing org.
- Create the **Staging** org (distinct `slug`, e.g. `…-staging`) and clone the
  prod config into it:
  ```sql
  select clone_org_config('<prod_org>'::uuid, '<staging_org>'::uuid);
  ```
  `clone_org_config` copies every config table (geography, pipelines, deal
  stages, products, roles, settings, custom fields, …) with fresh ids and
  **remaps intra-config foreign keys** so the staging graph is self-consistent.
  It does NOT copy transactional data (leads/contacts/deals/activities/users).

## 4. Recreate auth + admin user
- `auth.users` is per-project. Create the admin login in the new project
  (clone the `auth.users` + `auth.identities` + `public.users` rows to keep the
  same password, or create fresh).

## 5. Storage + edge functions
- Create the storage buckets (`distribution`, `kinematic-*`) + the
  `distribution` org-scoped RLS policies.
- Deploy the edge functions; set their secrets (`CRM_EDGE_SECRET`,
  `KINEMATIC_EDGE_SECRET`, `KINEMATIC_BASE_URL`, `ANTHROPIC_API_KEY`).
  NOTE: the cron-side shared secret MUST be named `CRM_EDGE_SECRET` —
  Supabase rejects any function secret starting with the reserved
  `SUPABASE_` prefix. The functions still read the legacy
  `SUPABASE_EDGE_SECRET` as a fallback for older deployments.
- Register the HTTP cron jobs (dispatch-pushes, send-email-queue,
  process-automations, recompute-win-prob, dispatch-scheduled-emails) against
  `https://<ref>.functions.supabase.co/...` using the **new** edge secret. The
  self-contained SQL cron jobs (matview refresh, digest, reminders, purge) have
  no secret and can be scheduled directly.

## 6. Register the project with the apps
- **Backend** env (Railway): `KINEMATIC_SUPABASE_URL / ANON_KEY /
  SERVICE_ROLE_KEY / JWKS_URL / JWT_SECRET / STORAGE_BUCKET / EDGE_*`.
  (Use a distinct env-var prefix per client; the registry in
  `src/lib/projects.ts` reads them.)
- **Directory**: add the client's emails/domain to `PROJECT_EMAIL_DIRECTORY`
  (exact email, preferred) or `PROJECT_DOMAIN_DIRECTORY`, mapping to the
  project key. Unmapped emails fall through to the default project.
- **Dashboard** env (Vercel): `NEXT_PUBLIC_KINEMATIC_SUPABASE_URL /
  _ANON_KEY` and `KINEMATIC_SUPABASE_SERVICE_ROLE_KEY`; the project host is
  already allowlisted in the CSP `connect-src`.

## 7. Ongoing: develop in staging, promote to production
- Admins customize the **staging** org (field overrides, labels, settings).
- Promote the settings/field-override surface to production:
  ```sql
  -- preview (no writes):
  select promote_org_config('<staging_org>', '<prod_org>', true);
  -- apply:
  select promote_org_config('<staging_org>', '<prod_org>', false);
  ```
  `promote_org_config` upserts `crm_settings` (field-override / business config)
  by `(org_id, client_id)` and merges `org_settings` by `key`. It is idempotent
  and never touches transactional data.

  **Scope note:** structural config (pipelines, stages, custom fields, products,
  geography) is carried at staging-creation time by `clone_org_config`.
  Row-level promotion of *structural* changes is intentionally NOT automated
  yet — most of those tables lack a natural key, so a safe merge needs explicit
  per-table key rules. Add them to `promote_org_config` as the need arises.

## Schema / code changes across the fleet
- DB migrations: apply to **every** project (staging org first, then prod) — the
  schemas must stay identical for promotion to be meaningful.
- Code: the `staging` branch → Vercel/Railway staging env (pointed at staging
  orgs); merge to `main` → production.
