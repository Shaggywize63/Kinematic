-- HRMS phase 3: Time & Leave on the server (shifts, the weekly roster, leave types / policies, holiday lists and leave balances).
--
-- Run AFTER migration_hrms_core.sql (it refers to hrms_employees; it stops with a clear message if the core migration has not been
-- applied). migration_hrms_payroll.sql is independent of this file; the three may be applied in any order after the core one.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS or a guarded block, so running it twice is a no-op. No existing table is
-- touched. Pure DDL: there is no freeze/commit equivalent in this phase, so no plpgsql functions are defined.
--
-- Tenancy and data protection: exactly as the core migration. Every row carries org_id + client_id (HRMS only writes client_id NULL),
-- RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's service role uses these tables.

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_employees') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_time.sql';
  END IF;
END $$;

-- ── Shifts ──────────────────────────────────────────────────────────────────
-- start / "end" are HH:MM (24h); "end" is quoted because it is a reserved word. is_night is derived by the API from the times
-- (a shift that ends before it starts runs past midnight). full_day_hours is what payroll reads for the overtime hourly rate
-- (hrms_employees.shift_id -> this row's full_day_hours; the engine falls back to 8 for an employee with no / unknown shift).
CREATE TABLE IF NOT EXISTS public.hrms_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  name            text NOT NULL,
  start           text NOT NULL,
  "end"           text NOT NULL,
  break_minutes   int     NOT NULL DEFAULT 0,
  grace_minutes   int     NOT NULL DEFAULT 0,
  full_day_hours  numeric NOT NULL DEFAULT 8,
  half_day_hours  numeric NOT NULL DEFAULT 4,
  is_night        boolean NOT NULL DEFAULT false,
  color           text    NOT NULL DEFAULT '#3E9EFF',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_shifts_name_chk   CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT hrms_shifts_start_chk  CHECK (start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT hrms_shifts_end_chk    CHECK ("end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT hrms_shifts_break_chk  CHECK (break_minutes >= 0 AND break_minutes <= 240),
  CONSTRAINT hrms_shifts_grace_chk  CHECK (grace_minutes >= 0 AND grace_minutes <= 120),
  CONSTRAINT hrms_shifts_full_chk   CHECK (full_day_hours >= 1 AND full_day_hours <= 16),
  CONSTRAINT hrms_shifts_half_chk   CHECK (half_day_hours > 0 AND half_day_hours < full_day_hours),
  CONSTRAINT hrms_shifts_color_chk  CHECK (char_length(color) <= 32)
);

-- ── Weekly roster (one row per employee and week) ───────────────────────────
-- days is an array of exactly 7 strings (Mon..Sun); each is a shift id (text, referring to hrms_shifts.id) or 'off'. The API checks
-- the shift ids are real and the week starts on a Monday; the shift ids are not a foreign key here (a cell holds 'off' too), so a
-- shift that a roster day still names is kept alive by the API delete guard, not by the database.
CREATE TABLE IF NOT EXISTS public.hrms_roster (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  days        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_roster_days_chk   CHECK (jsonb_typeof(days) = 'array' AND jsonb_array_length(days) = 7),
  CONSTRAINT hrms_roster_monday_chk CHECK (EXTRACT(dow FROM week_start) = 1)
);

-- ── Leave types (policies) ──────────────────────────────────────────────────
-- accrual / carry_forward / encashment pass through in the dashboard's camelCase shape:
--   accrual       { mode: none|monthly|yearly|on_joining, days, afterMonths }
--   carry_forward { allowed, maxDays, expiryMonths }
--   encashment    { allowed, maxDays, onExit }
-- code is uppercased by the API; it is unique per org. max_consecutive_days / document_after_days are null when not set.
CREATE TABLE IF NOT EXISTS public.hrms_leave_types (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  client_id            uuid,
  name                 text NOT NULL,
  code                 text NOT NULL,
  paid                 boolean NOT NULL DEFAULT true,
  audience             text NOT NULL DEFAULT 'all',
  accrual              jsonb NOT NULL DEFAULT '{}'::jsonb,
  carry_forward        jsonb NOT NULL DEFAULT '{}'::jsonb,
  encashment           jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_consecutive_days int,
  document_after_days  int,
  probation_eligible   boolean NOT NULL DEFAULT true,
  include_weekly_offs  boolean NOT NULL DEFAULT false,
  description          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_leave_types_name_chk     CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT hrms_leave_types_code_chk     CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  CONSTRAINT hrms_leave_types_audience_chk CHECK (audience IN ('all', 'female', 'male')),
  CONSTRAINT hrms_leave_types_accrual_chk  CHECK (jsonb_typeof(accrual) = 'object'),
  CONSTRAINT hrms_leave_types_cf_chk       CHECK (jsonb_typeof(carry_forward) = 'object'),
  CONSTRAINT hrms_leave_types_enc_chk      CHECK (jsonb_typeof(encashment) = 'object'),
  CONSTRAINT hrms_leave_types_maxcons_chk  CHECK (max_consecutive_days IS NULL OR (max_consecutive_days BETWEEN 1 AND 365)),
  CONSTRAINT hrms_leave_types_doc_chk      CHECK (document_after_days  IS NULL OR (document_after_days  BETWEEN 1 AND 365))
);

-- ── Holiday lists (per state and year) ──────────────────────────────────────
-- holidays is an array of { date (YYYY-MM-DD), name, optional }. The API checks the dates and that a date sits in the list's year.
CREATE TABLE IF NOT EXISTS public.hrms_holiday_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  name       text NOT NULL,
  state      text NOT NULL,
  year       int  NOT NULL,
  holidays   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_holiday_lists_name_chk     CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT hrms_holiday_lists_year_chk     CHECK (year BETWEEN 2000 AND 2100),
  CONSTRAINT hrms_holiday_lists_holidays_chk CHECK (jsonb_typeof(holidays) = 'array')
);

-- ── Leave balances (one per employee and leave type) ────────────────────────
-- opening + accrued - taken - encashed - lapsed = the available balance (which may itself be negative; the five stored numbers may not).
-- The leave type cannot be deleted while a balance references it (RESTRICT); balances follow their employee (CASCADE).
CREATE TABLE IF NOT EXISTS public.hrms_leave_balances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  employee_id   uuid NOT NULL REFERENCES public.hrms_employees(id)   ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES public.hrms_leave_types(id) ON DELETE RESTRICT,
  opening       numeric NOT NULL DEFAULT 0,
  accrued       numeric NOT NULL DEFAULT 0,
  taken         numeric NOT NULL DEFAULT 0,
  encashed      numeric NOT NULL DEFAULT 0,
  lapsed        numeric NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_leave_balances_nums_chk CHECK (opening >= 0 AND accrued >= 0 AND taken >= 0 AND encashed >= 0 AND lapsed >= 0)
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_shifts_org_name_uq          ON public.hrms_shifts (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_roster_org_emp_week_uq      ON public.hrms_roster (org_id, employee_id, week_start);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_leave_types_org_code_uq     ON public.hrms_leave_types (org_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_leave_balances_org_emp_lt_uq ON public.hrms_leave_balances (org_id, employee_id, leave_type_id);

CREATE INDEX IF NOT EXISTS hrms_shifts_org_idx            ON public.hrms_shifts (org_id);
CREATE INDEX IF NOT EXISTS hrms_roster_org_idx            ON public.hrms_roster (org_id);
CREATE INDEX IF NOT EXISTS hrms_roster_org_week_idx       ON public.hrms_roster (org_id, week_start);
CREATE INDEX IF NOT EXISTS hrms_roster_employee_idx       ON public.hrms_roster (employee_id);
CREATE INDEX IF NOT EXISTS hrms_leave_types_org_idx       ON public.hrms_leave_types (org_id);
CREATE INDEX IF NOT EXISTS hrms_holiday_lists_org_idx     ON public.hrms_holiday_lists (org_id);
CREATE INDEX IF NOT EXISTS hrms_leave_balances_org_idx    ON public.hrms_leave_balances (org_id);
CREATE INDEX IF NOT EXISTS hrms_leave_balances_org_emp_idx ON public.hrms_leave_balances (org_id, employee_id);
CREATE INDEX IF NOT EXISTS hrms_leave_balances_lt_idx     ON public.hrms_leave_balances (leave_type_id);

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_shifts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_roster         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_leave_types    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_holiday_lists  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_leave_balances ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Same pattern as the core / payroll migrations: Supabase hands anon / authenticated everything on new public tables. Guarded by role
-- existence so the same file runs on a plain Postgres (tests, local) too.
DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hrms_shifts', 'hrms_roster', 'hrms_leave_types', 'hrms_holiday_lists', 'hrms_leave_balances'
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
