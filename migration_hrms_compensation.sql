-- HRMS phase 8: the Compensation module on the server (the third and last slice of the Rewards area, after assets
-- (phase 6) and benefits (phase 7)). It stores the grade pay bands, each person's performance band + their reply to it,
-- and the SINGLE merit cycle per org: its guidelines matrix, the per-person increment proposals, and the record of the
-- increments that were issued.
--
-- What stays elsewhere, exactly as the dashboard's apply flow does it (components/.../compensation/apply.ts): issuing an
-- increment writes the new CTC on the core employee (migration_hrms_core.sql, PUT /hrms/employees/:id) and an increment
-- letter in the register (migration_hrms_lifecycle.sql, the Lifecycle letters). This module only RECORDS that an
-- increment was issued (the `applied` map), the same split as benefits' send-to-payroll, which writes the
-- already-server-backed payroll and keeps only its own `sent` map.
--
-- Run AFTER migration_hrms_core.sql (perf references hrms_employees) -- it stops with a clear message if the core
-- migration has not been applied. It is independent of the other phase migrations and may be applied in any order after
-- the core one. The `applied` record carries a letter id as a plain uuid (a soft reference, no FK): the letter is created
-- through the lifecycle endpoint, and a reopened/edited letter must never cascade into the compensation history.
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
-- client_id NULL), RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's
-- service role uses these tables and the function.
--
-- Note on reserved words: a band's amounts are stored as band_min / band_mid / band_max (min / max are function names
-- in SQL; the physical columns avoid them and the API maps them back to min / mid / max on the wire, matching the
-- by_name convention in the benefits / assets migrations). The merit decision `by`, and the `by` inside the proposals
-- and applied maps, are jsonb keys, which need no renaming.

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_employees') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_compensation.sql';
  END IF;
END $$;

-- ── Pay bands (one row per grade) ────────────────────────────────────────────
-- A grade's salary range (min < mid < max) plus a sample market median and whether it is visible to employees. The
-- band's grade matches a designation's grade (hrms_designations.grade); unique per org. validateBand's shape rule
-- (min < mid < max, max <= 2.5 * min, all positive) is reproduced by the API and enforced again here as a backstop.
CREATE TABLE IF NOT EXISTS public.hrms_comp_bands (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  grade      text NOT NULL,
  band_min   numeric(14,2) NOT NULL,
  band_mid   numeric(14,2) NOT NULL,
  band_max   numeric(14,2) NOT NULL,
  market     numeric(14,2) NOT NULL,
  published  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_comp_bands_grade_chk  CHECK (char_length(btrim(grade)) BETWEEN 1 AND 40),
  CONSTRAINT hrms_comp_bands_pos_chk    CHECK (band_min > 0 AND band_mid > 0 AND band_max > 0 AND market > 0),
  CONSTRAINT hrms_comp_bands_order_chk  CHECK (band_min < band_mid AND band_mid < band_max),
  CONSTRAINT hrms_comp_bands_width_chk  CHECK (band_max <= band_min * 2.5)
);

-- ── Performance band + reply (one row per employee) ──────────────────────────
-- The module's own simple performance band per person (the performance module is not connected), plus the manager's
-- evidence note and the employee's reply. All three are optional: setPerf writes the band, setPerfReply writes the
-- reply; a row may carry any subset. Unique per org + employee.
CREATE TABLE IF NOT EXISTS public.hrms_comp_perf (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  band        text,
  evidence    text,
  reply       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_comp_perf_band_chk CHECK (band IS NULL OR band IN ('exceeds', 'meets', 'partial', 'below', 'unrated'))
);

-- ── Merit cycle (a singleton per org) ────────────────────────────────────────
-- One row per org (unique org_id, HRMS always writes client_id NULL): the current merit cycle. guidelines is the full
-- PerfBand x CompaZone matrix of { min, max } percent ranges; proposals is a map employeeId -> { pct, reason?, by, on };
-- applied is a map employeeId -> { on, from, to, letterId, by } written only by hrms_merit_record_applied. decision is
-- { by, on, note? } or null. The status machine (draft -> submitted -> approved | returned; approved -> draft on reopen)
-- is enforced by the service, with the "no proposals" / "reason needed" / "over budget" words the dashboard already has.
CREATE TABLE IF NOT EXISTS public.hrms_merit_cycle (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  client_id    uuid,
  name         text NOT NULL DEFAULT 'Merit cycle',
  effective_on date NOT NULL,
  budget_pct   numeric(6,2) NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'draft',
  decision     jsonb,
  guidelines   jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposals    jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_merit_cycle_name_chk       CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT hrms_merit_cycle_budget_chk     CHECK (budget_pct >= 0 AND budget_pct <= 30),
  CONSTRAINT hrms_merit_cycle_status_chk     CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
  CONSTRAINT hrms_merit_cycle_decision_chk   CHECK (decision IS NULL OR jsonb_typeof(decision) = 'object'),
  CONSTRAINT hrms_merit_cycle_guidelines_chk CHECK (jsonb_typeof(guidelines) = 'object'),
  CONSTRAINT hrms_merit_cycle_proposals_chk  CHECK (jsonb_typeof(proposals) = 'object'),
  CONSTRAINT hrms_merit_cycle_applied_chk    CHECK (jsonb_typeof(applied) = 'object')
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_comp_bands_org_grade_uq ON public.hrms_comp_bands (org_id, grade);
CREATE INDEX IF NOT EXISTS hrms_comp_bands_org_idx            ON public.hrms_comp_bands (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_comp_perf_org_emp_uq   ON public.hrms_comp_perf (org_id, employee_id);
CREATE INDEX IF NOT EXISTS hrms_comp_perf_org_idx             ON public.hrms_comp_perf (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_merit_cycle_org_uq     ON public.hrms_merit_cycle (org_id);

-- ── Record one issued increment, atomically ──────────────────────────────────
-- Writes applied[employee] = { on, from, to, letterId, by } on the cycle singleton, but only when the cycle is approved
-- and this person has not already been issued an increment in the cycle. The singleton is locked FOR UPDATE, both
-- conditions are re-checked under the lock, then the row is written, so two concurrent applies cannot both record: the
-- second sees applied ? employee and raises. The CTC change and the increment letter are written by the caller through
-- the core / lifecycle endpoints BEFORE this runs (exactly as the dashboard's apply.ts orders it); this only records it.
--   Errors (SQLSTATE P0001): MERIT_NOT_FOUND (no cycle), MERIT_NOT_APPROVED (cycle not approved), MERIT_ALREADY_APPLIED
-- (this person already has an increment in the cycle). The API maps them to the dashboard's plain reasons. Returns the
-- employee id.
CREATE OR REPLACE FUNCTION public.hrms_merit_record_applied(
  p_org uuid, p_employee uuid, p_from numeric, p_to numeric, p_letter uuid, p_on date, p_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now    timestamptz := clock_timestamp();
  v_by     text := COALESCE(NULLIF(btrim(p_by), ''), 'Unknown');
  v_status text;
  v_has    boolean;
  v_entry  jsonb;
BEGIN
  IF p_org IS NULL OR p_employee IS NULL OR p_letter IS NULL THEN
    RAISE EXCEPTION 'hrms_merit_record_applied: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT status, (applied ? p_employee::text) INTO v_status, v_has
    FROM public.hrms_merit_cycle WHERE org_id = p_org AND client_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MERIT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_status <> 'approved' THEN RAISE EXCEPTION 'MERIT_NOT_APPROVED' USING ERRCODE = 'P0001'; END IF;
  IF v_has THEN RAISE EXCEPTION 'MERIT_ALREADY_APPLIED' USING ERRCODE = 'P0001'; END IF;

  v_entry := jsonb_build_object(
    'on', to_char(p_on, 'YYYY-MM-DD'), 'from', round(p_from), 'to', round(p_to),
    'letterId', p_letter::text, 'by', v_by);

  UPDATE public.hrms_merit_cycle
     SET applied = jsonb_set(applied, ARRAY[p_employee::text], v_entry, true), updated_at = v_now
   WHERE org_id = p_org AND client_id IS NULL;

  RETURN p_employee;
END;
$fn$;

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_comp_bands  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_comp_perf   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_merit_cycle ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Same pattern as the core / payroll / lifecycle / assets / benefits migrations. Guarded by role existence so the same
-- file runs on a plain Postgres too.
DO $$
DECLARE
  t text;
  r text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hrms_comp_bands', 'hrms_comp_perf', 'hrms_merit_cycle'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.hrms_merit_record_applied(uuid, uuid, numeric, numeric, uuid, date, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

-- PostgREST caches the schema: tell it to reload.
NOTIFY pgrst, 'reload schema';
