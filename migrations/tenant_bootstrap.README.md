# Tenant bootstrap schema

The per-client provisioner (`src/services/provisionClient.service.ts`) creates a
brand-new, **empty** Supabase project for each client and then loads a golden
schema into it. That schema is `migrations/tenant_bootstrap.sql` (this file's
sibling). It is **not committed with real DDL** because a faithful copy must be a
`pg_dump --schema-only` of the live **Kinematic control-plane** project, which
requires that project's database password — a credential the CI/agent does not
hold.

## Generate it once (operator, from a machine with the DB password)

```bash
# ref = clldjlojtmrrpozydqxk  (Kinematic-Production / control plane)
pg_dump \
  --schema-only --no-owner --no-privileges --no-comments \
  --schema=public \
  "postgresql://postgres:<KINEMATIC_DB_PASSWORD>@db.clldjlojtmrrpozydqxk.supabase.co:5432/postgres" \
  > Kinematic/migrations/tenant_bootstrap.sql
```

Then trim it so it is safe to replay into a fresh project:

- Keep: `create table`, indexes, constraints, sequences, functions, triggers,
  views, RLS policies, and any **catalog / lookup seed** rows a tenant needs
  (e.g. `modules`, deal-stage/pipeline defaults) — no per-tenant business data.
- Remove: `leads`, `contacts`, `deals`, `crm_activities`, `users`, and any other
  row-level business data (the provisioner seeds the org + admin user itself).
- A fresh Supabase project already ships the `auth`, `storage`, and `extensions`
  schemas, so keep the dump scoped to `public`.

## How the provisioner consumes it

- Path is `TENANT_BOOTSTRAP_SQL_PATH` (default `migrations/tenant_bootstrap.sql`).
- The provisioner **refuses to create a billable project** if the file is missing
  or empty, so you never end up paying for an un-seeded project.
- Schema drift: when you ship a new migration to the platform, regenerate this
  file (or apply the same migration to every `platform_projects` ref) so new
  tenants match existing ones.
