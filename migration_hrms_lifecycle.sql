-- HRMS phase 4: Lifecycle + Letters on the server (onboarding cases, exit cases, letter templates, issued letters).
--
-- Run AFTER migration_hrms_core.sql (it refers to hrms_employees; it stops with a clear message if the core migration has not been
-- applied). migration_hrms_payroll.sql and migration_hrms_time.sql are independent of this file; the four migrations may be applied in
-- any order after the core one. The exit close-blocker in the service layer READS hrms_fnf_cases (from migration_hrms_payroll.sql), but
-- this migration does not depend on it: a missing F&F case is simply treated as "not paid yet" by the service.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS or a guarded block, so running it twice is a no-op. No existing table is
-- touched. Pure DDL: these four collections are simple records (no server "commands" like payroll's freeze), so no plpgsql functions
-- are defined.
--
-- Tenancy and data protection: exactly as the core migration. Every row carries org_id + client_id (HRMS only writes client_id NULL),
-- RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's service role uses these tables.

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_employees') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_lifecycle.sql';
  END IF;
END $$;

-- ── Onboarding cases (one open per new joiner) ──────────────────────────────
-- employee_id is NULL for a pre-hire; it is set null (not cascade) if the draft employee is ever hard-deleted, so the case survives.
-- stage is one of the six ONBOARDING_STAGES (lifecycleActions.ts). tasks passes through in the dashboard's camelCase shape:
--   tasks  [{ id, label, owner, done, dueOn? }]
CREATE TABLE IF NOT EXISTS public.hrms_onboarding_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid REFERENCES public.hrms_employees(id) ON DELETE SET NULL,
  name        text NOT NULL,
  role        text NOT NULL,
  join_date   date NOT NULL,
  stage       text NOT NULL DEFAULT 'offer',
  tasks       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_onboarding_name_chk  CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT hrms_onboarding_role_chk  CHECK (char_length(btrim(role)) BETWEEN 1 AND 100),
  CONSTRAINT hrms_onboarding_stage_chk CHECK (stage IN ('offer', 'documents', 'registration', 'assets', 'induction', 'done')),
  CONSTRAINT hrms_onboarding_tasks_chk CHECK (jsonb_typeof(tasks) = 'array')
);

-- ── Exit cases (a person may have more than one historical exit) ────────────
-- employee_id is NOT NULL and follows the employee (CASCADE). reason / stage are checked against the dashboard enums. clearance and
-- assets pass through in the dashboard's camelCase shape:
--   clearance [{ id, department, owner, done, remarks? }]
--   assets    [{ id, name, returned }]
-- resignation_date <= last_working_date is a WARNING in the dashboard, never a hard block, so it is deliberately NOT a CHECK here.
-- No "one open exit per employee" unique constraint: the dashboard allows historical exits, so the model is left un-over-constrained.
CREATE TABLE IF NOT EXISTS public.hrms_exit_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  client_id         uuid,
  employee_id       uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  reason            text NOT NULL,
  resignation_date  date NOT NULL,
  last_working_date date NOT NULL,
  notice_waived     boolean NOT NULL DEFAULT false,
  stage             text NOT NULL DEFAULT 'notice',
  clearance         jsonb NOT NULL DEFAULT '[]'::jsonb,
  assets            jsonb NOT NULL DEFAULT '[]'::jsonb,
  interview_done    boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_exit_reason_chk    CHECK (reason IN ('resignation', 'termination', 'end_of_contract', 'retirement', 'absconding')),
  CONSTRAINT hrms_exit_stage_chk     CHECK (stage IN ('notice', 'clearance', 'settlement', 'closed')),
  CONSTRAINT hrms_exit_clearance_chk CHECK (jsonb_typeof(clearance) = 'array'),
  CONSTRAINT hrms_exit_assets_chk    CHECK (jsonb_typeof(assets) = 'array')
);

-- ── Letter templates ────────────────────────────────────────────────────────
-- type is one of the seven LetterType values. body holds the raw template text with {{merge fields}}; it is capped generously.
CREATE TABLE IF NOT EXISTS public.hrms_letter_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  type       text NOT NULL,
  name       text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_letter_templates_type_chk CHECK (type IN ('offer', 'appointment', 'confirmation', 'increment', 'relieving', 'experience', 'warning')),
  CONSTRAINT hrms_letter_templates_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT hrms_letter_templates_body_chk CHECK (char_length(body) <= 20000)
);

-- ── Issued letters (the register) ───────────────────────────────────────────
-- A letter follows its employee (CASCADE). template_id is null for an ad-hoc letter, and is set null (not cascade) if the template is
-- deleted, so the register keeps the rendered body. body is the pre-rendered text the client sends (no PDF on the server this phase).
CREATE TABLE IF NOT EXISTS public.hrms_issued_letters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id)        ON DELETE CASCADE,
  template_id uuid          REFERENCES public.hrms_letter_templates(id) ON DELETE SET NULL,
  type        text NOT NULL,
  issued_on   date NOT NULL,
  body        text NOT NULL,
  signed      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_issued_letters_type_chk CHECK (type IN ('offer', 'appointment', 'confirmation', 'increment', 'relieving', 'experience', 'warning')),
  CONSTRAINT hrms_issued_letters_body_chk CHECK (char_length(body) <= 20000)
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS hrms_onboarding_org_idx      ON public.hrms_onboarding_cases (org_id);
CREATE INDEX IF NOT EXISTS hrms_onboarding_org_emp_idx  ON public.hrms_onboarding_cases (org_id, employee_id);
CREATE INDEX IF NOT EXISTS hrms_onboarding_employee_idx ON public.hrms_onboarding_cases (employee_id);

CREATE INDEX IF NOT EXISTS hrms_exit_org_idx      ON public.hrms_exit_cases (org_id);
CREATE INDEX IF NOT EXISTS hrms_exit_org_emp_idx  ON public.hrms_exit_cases (org_id, employee_id);
CREATE INDEX IF NOT EXISTS hrms_exit_employee_idx ON public.hrms_exit_cases (employee_id);

CREATE INDEX IF NOT EXISTS hrms_letter_templates_org_idx ON public.hrms_letter_templates (org_id);

CREATE INDEX IF NOT EXISTS hrms_issued_letters_org_idx      ON public.hrms_issued_letters (org_id);
CREATE INDEX IF NOT EXISTS hrms_issued_letters_org_emp_idx  ON public.hrms_issued_letters (org_id, employee_id);
CREATE INDEX IF NOT EXISTS hrms_issued_letters_employee_idx ON public.hrms_issued_letters (employee_id);
CREATE INDEX IF NOT EXISTS hrms_issued_letters_template_idx ON public.hrms_issued_letters (template_id);

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_onboarding_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_exit_cases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_letter_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_issued_letters   ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Same pattern as the core / payroll / time migrations: Supabase hands anon / authenticated everything on new public tables. Guarded by
-- role existence so the same file runs on a plain Postgres (tests, local) too.
DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hrms_onboarding_cases', 'hrms_exit_cases', 'hrms_letter_templates', 'hrms_issued_letters'
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
