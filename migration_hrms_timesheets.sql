-- HRMS phase 9: Timesheets on the server (the Workplace area's weekly hours against projects). It stores the project
-- list, one timesheet per person per week (its project lines, status and append-only trail), and the org's timesheet
-- settings: the daily limit / weekly cap / standard week, and who tracks time.
--
-- The dashboard's rules (lib/hrms/people/timesheetEngine.ts + timesheetActions.ts) are reproduced by the API with the
-- same words: a week is editable while draft or returned; submit needs some hours, steps of 0.25 h, no future days and
-- no day above the daily limit; approve locks the week; a return needs a comment. The CHECK constraints below are the
-- backstop for the shapes.
--
-- Run AFTER migration_hrms_core.sql (sheets reference hrms_employees) -- it stops with a clear message if the core
-- migration has not been applied. Independent of the other phase migrations.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS, CREATE OR REPLACE or a guarded DO block, so running it twice
-- is a no-op. No existing table is touched.
--
-- Tenancy and data protection: exactly as the core migration. Every row carries org_id + client_id (HRMS only writes
-- client_id NULL), RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's service
-- role uses these tables.

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_employees') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_timesheets.sql';
  END IF;
END $$;

-- ── Projects ─────────────────────────────────────────────────────────────────
-- What people log hours against: a client project (billable or not) or an internal one. budget_hours and prior_hours
-- (hours logged before the first week on record) drive the budget bar; rate is the hourly billing rate used for the
-- project value (rupees; 0 for non-billable). An archived project stays on old weeks but cannot be added to a new one.
CREATE TABLE IF NOT EXISTS public.hrms_ts_projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  client_id    uuid,
  name         text NOT NULL,
  client       text NOT NULL DEFAULT '',
  kind         text NOT NULL DEFAULT 'client',
  billable     boolean NOT NULL DEFAULT true,
  budget_hours numeric(10,2) NOT NULL DEFAULT 0,
  prior_hours  numeric(10,2) NOT NULL DEFAULT 0,
  rate         numeric(12,2) NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_ts_projects_name_chk   CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT hrms_ts_projects_client_chk CHECK (char_length(client) <= 120),
  CONSTRAINT hrms_ts_projects_kind_chk   CHECK (kind IN ('client', 'internal')),
  CONSTRAINT hrms_ts_projects_nums_chk   CHECK (budget_hours >= 0 AND prior_hours >= 0 AND rate >= 0)
);

-- ── Timesheets (one row per person per week) ─────────────────────────────────
-- week_start is the Monday. lines is an array of { projectId, hours: [Mon..Sun] } (the dashboard's SheetLine shape);
-- trail is the append-only list of { at, by, action, comment? }. Status: draft -> submitted -> approved | returned;
-- returned -> submitted again. Unique per org + employee + week.
CREATE TABLE IF NOT EXISTS public.hrms_ts_sheets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  client_id    uuid,
  employee_id  uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  week_start   date NOT NULL,
  lines        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       text NOT NULL DEFAULT 'draft',
  submitted_on date,
  decided_on   date,
  decided_by   text,
  comment      text,
  trail        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_ts_sheets_monday_chk CHECK (extract(isodow FROM week_start) = 1),
  CONSTRAINT hrms_ts_sheets_status_chk CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
  CONSTRAINT hrms_ts_sheets_lines_chk  CHECK (jsonb_typeof(lines) = 'array'),
  CONSTRAINT hrms_ts_sheets_trail_chk  CHECK (jsonb_typeof(trail) = 'array')
);

-- ── Settings (a singleton per org) ───────────────────────────────────────────
-- The company limits (the dashboard's setPolicy ranges) and the people who track time.
CREATE TABLE IF NOT EXISTS public.hrms_ts_config (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  max_per_day   numeric(5,2) NOT NULL DEFAULT 12,
  weekly_cap    numeric(5,2) NOT NULL DEFAULT 60,
  standard_week numeric(5,2) NOT NULL DEFAULT 40,
  tracked_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_ts_config_day_chk     CHECK (max_per_day BETWEEN 8 AND 24),
  CONSTRAINT hrms_ts_config_cap_chk     CHECK (weekly_cap BETWEEN 20 AND 90),
  CONSTRAINT hrms_ts_config_std_chk     CHECK (standard_week >= 20 AND standard_week <= weekly_cap),
  CONSTRAINT hrms_ts_config_tracked_chk CHECK (jsonb_typeof(tracked_ids) = 'array')
);

-- ── Indexes / uniques ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_ts_projects_org_name_uq ON public.hrms_ts_projects (org_id, lower(btrim(name)));
CREATE INDEX        IF NOT EXISTS hrms_ts_projects_org_idx     ON public.hrms_ts_projects (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_ts_sheets_org_emp_week_uq ON public.hrms_ts_sheets (org_id, employee_id, week_start);
CREATE INDEX        IF NOT EXISTS hrms_ts_sheets_org_week_idx    ON public.hrms_ts_sheets (org_id, week_start);
CREATE INDEX        IF NOT EXISTS hrms_ts_sheets_employee_idx    ON public.hrms_ts_sheets (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_ts_config_org_uq        ON public.hrms_ts_config (org_id);

-- ── Row-level security: on, no policies; only the service role reaches these tables ──
ALTER TABLE public.hrms_ts_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_ts_sheets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_ts_config   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hrms_ts_projects', 'hrms_ts_sheets', 'hrms_ts_config'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('GRANT ALL ON public.%I TO service_role', t); END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
