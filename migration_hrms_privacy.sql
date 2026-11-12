-- HRMS phase 5: Privacy/DPDP + Compliance on the server (compliance tasks, consent records, retention rules).
--
-- Run AFTER migration_hrms_core.sql (it refers to hrms_entities and hrms_employees; it stops with a clear message if the core migration
-- has not been applied). migration_hrms_payroll.sql, migration_hrms_time.sql and migration_hrms_lifecycle.sql are independent of this
-- file; the five migrations may be applied in any order after the core one.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS or a guarded block, so running it twice is a no-op. No existing table is
-- touched. Pure DDL: these three collections are simple records (no server "commands"), so no plpgsql functions are defined. The access
-- log (hrms_access_log) already exists from migration_hrms_core.sql -- it is deliberately NOT recreated here.
--
-- Tenancy and data protection: exactly as the core migration. Every row carries org_id + client_id (HRMS only writes client_id NULL),
-- RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's service role uses these tables.
--
-- NOTE ON keep_years: the dashboard's RetentionRule.keepYears is a JavaScript `number` and the standard retention rules include
-- sub-year keep periods (0.25 years = 90 days, 0.08 years = 30 days). The column is therefore `numeric` (not integer) so those
-- fractional periods round-trip exactly as the wire shape (a JSON number) requires; the only constraint is keep_years >= 0.

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_entities') IS NULL OR to_regclass('public.hrms_employees') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_privacy.sql';
  END IF;
END $$;

-- ── Compliance tasks (the statutory calendar) ───────────────────────────────
-- A task is a statutory due date for one legal entity. law is one of the ten dashboard laws (types.ts ComplianceTask.law). The task
-- follows its entity (CASCADE). `status` is DELIBERATELY NOT STORED: the dashboard derives upcoming / due_soon / filed / overdue from
-- due_on, filed_on and today (statutory/builders.ts derivedStatus). filed_on + reference are set when the filing is recorded (markFiled).
CREATE TABLE IF NOT EXISTS public.hrms_compliance_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  name        text NOT NULL,
  law         text NOT NULL,
  due_on      date NOT NULL,
  entity_id   uuid NOT NULL REFERENCES public.hrms_entities(id) ON DELETE CASCADE,
  state       text,
  filed_on    date,
  reference   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_compliance_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT hrms_compliance_law_chk  CHECK (law IN ('PF', 'ESI', 'PT', 'LWF', 'TDS', 'Shops', 'CLRA', 'POSH', 'Gratuity', 'Bonus')),
  CONSTRAINT hrms_compliance_ref_chk  CHECK (reference IS NULL OR char_length(reference) <= 200),
  CONSTRAINT hrms_compliance_state_chk CHECK (state IS NULL OR char_length(state) <= 100)
);

-- ── Consent records (the DPDP ledger) ───────────────────────────────────────
-- Who agreed to what, under which notice version, when. A consent follows its employee (CASCADE). withdrawn_at is set when the consent is
-- withdrawn and the row then stays as evidence (the ledger is never deleted on withdrawal). Timestamps are full timestamptz.
CREATE TABLE IF NOT EXISTS public.hrms_consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  employee_id    uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  purpose        text NOT NULL,
  notice_version text NOT NULL,
  granted_at     timestamptz NOT NULL,
  withdrawn_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_consents_purpose_chk CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 200),
  CONSTRAINT hrms_consents_notice_chk  CHECK (char_length(btrim(notice_version)) BETWEEN 1 AND 100)
);

-- ── Retention rules (policy records only) ───────────────────────────────────
-- How long each dataset is kept and what happens after. These are policy records: NOTHING is deleted or anonymised on their basis this
-- phase. keep_years is numeric so sub-year periods survive (see the note at the top); action is delete or anonymise.
CREATE TABLE IF NOT EXISTS public.hrms_retention_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  dataset     text NOT NULL,
  keep_years  numeric NOT NULL,
  basis       text NOT NULL,
  action      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_retention_dataset_chk CHECK (char_length(btrim(dataset)) BETWEEN 1 AND 200),
  CONSTRAINT hrms_retention_basis_chk   CHECK (char_length(btrim(basis)) BETWEEN 1 AND 500),
  CONSTRAINT hrms_retention_years_chk   CHECK (keep_years >= 0),
  CONSTRAINT hrms_retention_action_chk  CHECK (action IN ('delete', 'anonymise'))
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS hrms_compliance_org_idx     ON public.hrms_compliance_tasks (org_id);
CREATE INDEX IF NOT EXISTS hrms_compliance_org_ent_idx ON public.hrms_compliance_tasks (org_id, entity_id);
CREATE INDEX IF NOT EXISTS hrms_compliance_entity_idx  ON public.hrms_compliance_tasks (entity_id);

CREATE INDEX IF NOT EXISTS hrms_consents_org_idx     ON public.hrms_consents (org_id);
CREATE INDEX IF NOT EXISTS hrms_consents_org_emp_idx ON public.hrms_consents (org_id, employee_id);
CREATE INDEX IF NOT EXISTS hrms_consents_employee_idx ON public.hrms_consents (employee_id);

CREATE INDEX IF NOT EXISTS hrms_retention_org_idx ON public.hrms_retention_rules (org_id);

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_compliance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_consents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_retention_rules  ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Same pattern as the core / payroll / time / lifecycle migrations: Supabase hands anon / authenticated everything on new public tables.
-- Guarded by role existence so the same file runs on a plain Postgres (tests, local) too.
DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hrms_compliance_tasks', 'hrms_consents', 'hrms_retention_rules'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
  END LOOP;
END $$;

-- PostgREST caches the schema: tell it to reload.
NOTIFY pgrst, 'reload schema';
