-- HRMS phase 2: payroll on the server (salary structures, monthly attendance inputs, adjustments, loans and advances, pay runs
-- and their audit trail, payslips, full-and-final settlements) plus the functions that make freeze / unfreeze / compute atomic.
--
-- Run AFTER migration_hrms_core.sql (it refers to hrms_entities, hrms_employees and hrms_access_log; it stops with a clear
-- message if the core migration has not been applied).
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS, CREATE OR REPLACE, or a guarded DO block, so running it twice is a no-op.
-- The one change to an existing table is a widening of hrms_access_log (see "Access log" below): no row is touched.
--
-- Tenancy and data protection: exactly as the core migration. Every row carries org_id + client_id (HRMS only writes client_id NULL),
-- RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's service role uses these tables.
-- Salaries are personal data: nothing here is readable through PostgREST's public roles.
--
-- Money: amounts are numeric, never floating point. The engine (src/services/hrms/payroll/engine) rounds exactly as the dashboard's does
-- and the API stores what it computed; SQL never recomputes pay. The functions below only move whole recorded amounts (loan recoveries).

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_employees') IS NULL OR to_regclass('public.hrms_entities') IS NULL OR to_regclass('public.hrms_access_log') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_payroll.sql';
  END IF;
END $$;

-- ── Salary structures ───────────────────────────────────────────────────────
-- components: an array in the dashboard's SalaryComponent shape
--   { id, code, name, kind, calc: { type, value }, isWage, taxable, pfApplicable, esiApplicable, prorate, showInPayslip }
-- (validated by the API with the dashboard's own rules; employees point at a structure with hrms_employees.structure_id, a plain text id).
CREATE TABLE IF NOT EXISTS public.hrms_structures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  name           text NOT NULL,
  description    text,
  effective_from date NOT NULL,
  components     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_structures_name_chk       CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT hrms_structures_components_chk CHECK (jsonb_typeof(components) = 'array')
);

-- ── Monthly attendance inputs (one row per employee and month) ──────────────
-- lop_days / overtime_hours are what payroll reads. The other counts are informational (the field attendance module will feed them).
-- locked is set by a freeze for the people in the run and cleared by the matching unfreeze (or by hand, while no run is closed).
CREATE TABLE IF NOT EXISTS public.hrms_attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  employee_id     uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  month           text NOT NULL,
  days_in_month   int  NOT NULL,
  present_days    numeric NOT NULL DEFAULT 0,
  paid_leave_days numeric NOT NULL DEFAULT 0,
  weekly_offs     numeric NOT NULL DEFAULT 0,
  holidays        numeric NOT NULL DEFAULT 0,
  lop_days        numeric NOT NULL DEFAULT 0,
  overtime_hours  numeric NOT NULL DEFAULT 0,
  locked          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_attendance_month_chk    CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT hrms_attendance_days_chk     CHECK (days_in_month BETWEEN 28 AND 31),
  CONSTRAINT hrms_attendance_counts_chk   CHECK (present_days >= 0 AND paid_leave_days >= 0 AND weekly_offs >= 0 AND holidays >= 0),
  CONSTRAINT hrms_attendance_lop_chk      CHECK (lop_days >= 0 AND lop_days <= days_in_month),
  CONSTRAINT hrms_attendance_overtime_chk CHECK (overtime_hours >= 0 AND overtime_hours <= 200)
);

-- ── Adjustments (one-time pay and deductions in a month) ────────────────────
-- source is null for hand-entered rows; a generated row (for example an incentive push) names where it came from.
-- created_by is the display name of whoever entered it.
CREATE TABLE IF NOT EXISTS public.hrms_adjustments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  month       text NOT NULL,
  kind        text NOT NULL,
  amount      numeric(14,2) NOT NULL,
  taxable     boolean NOT NULL DEFAULT false,
  note        text,
  source      text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_adjustments_month_chk  CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT hrms_adjustments_kind_chk   CHECK (kind IN ('arrear', 'bonus', 'incentive', 'reimbursement', 'one_time_deduction', 'loan_emi', 'advance_recovery')),
  CONSTRAINT hrms_adjustments_amount_chk CHECK (amount > 0),
  CONSTRAINT hrms_adjustments_note_chk   CHECK (note IS NULL OR char_length(note) <= 200)
);

-- ── Loans and advances ──────────────────────────────────────────────────────
-- recovered only moves through freeze (adds the recovery) and unfreeze (gives it back); the API never writes it.
-- A loan is a money record: the employee row cannot be purged while a loan points at it (RESTRICT).
CREATE TABLE IF NOT EXISTS public.hrms_loans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE RESTRICT,
  kind        text NOT NULL,
  principal   numeric(14,2) NOT NULL,
  emi         numeric(14,2) NOT NULL,
  start_month text NOT NULL,
  recovered   numeric(14,2) NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_loans_kind_chk      CHECK (kind IN ('loan', 'advance')),
  CONSTRAINT hrms_loans_principal_chk CHECK (principal > 0),
  CONSTRAINT hrms_loans_emi_chk       CHECK (emi > 0),
  CONSTRAINT hrms_loans_month_chk     CHECK (start_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT hrms_loans_recovered_chk CHECK (recovered >= 0 AND recovered <= principal),
  CONSTRAINT hrms_loans_note_chk      CHECK (note IS NULL OR char_length(note) <= 200)
);

-- ── Pay runs ────────────────────────────────────────────────────────────────
-- status: draft -> computed -> frozen -> paid (an unfreeze goes frozen -> computed; a paid run is closed).
-- input_fingerprint is a stable hash of everything the last compute read (see src/services/hrms/payroll/fingerprint.ts); a computed run whose
-- inputs hash differently now is STALE, and a freeze is refused until it is computed again.
-- loan_recoveries ({ loanId: rupees }) and attendance_locked_for ([employee id]) record exactly what the freeze did so the unfreeze can undo it.
CREATE TABLE IF NOT EXISTS public.hrms_pay_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  client_id              uuid,
  entity_id              uuid NOT NULL REFERENCES public.hrms_entities(id) ON DELETE RESTRICT,
  month                  text NOT NULL,
  type                   text NOT NULL DEFAULT 'regular',
  status                 text NOT NULL DEFAULT 'draft',
  law_version            text,
  computed_at            timestamptz,
  frozen_at              timestamptz,
  frozen_by_user_id      uuid,
  frozen_by              text,
  paid_at                timestamptz,
  loan_recoveries        jsonb NOT NULL DEFAULT '{}'::jsonb,
  attendance_locked_for  jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_fingerprint      text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_pay_runs_month_chk    CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT hrms_pay_runs_type_chk     CHECK (type IN ('regular', 'offcycle')),
  CONSTRAINT hrms_pay_runs_status_chk   CHECK (status IN ('draft', 'computed', 'frozen', 'paid')),
  CONSTRAINT hrms_pay_runs_frozen_chk   CHECK (status NOT IN ('frozen', 'paid') OR frozen_at IS NOT NULL),
  CONSTRAINT hrms_pay_runs_paid_chk     CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT hrms_pay_runs_recov_chk    CHECK (jsonb_typeof(loan_recoveries) = 'object'),
  CONSTRAINT hrms_pay_runs_locked_chk   CHECK (jsonb_typeof(attendance_locked_for) = 'array')
);

-- ── Pay run audit trail (append only; oldest first by seq) ──────────────────
CREATE TABLE IF NOT EXISTS public.hrms_pay_run_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  run_id     uuid NOT NULL REFERENCES public.hrms_pay_runs(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  by_user_id uuid,
  by_name    text NOT NULL,
  action     text NOT NULL,
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_pay_run_audit_action_chk CHECK (char_length(btrim(action)) BETWEEN 1 AND 1000)
);

-- ── Payslips ────────────────────────────────────────────────────────────────
-- earnings / deductions / employer / reimbursements hold the dashboard's PayslipLine[] ({ code, name, amount, taxable? }) in engine order;
-- wages is { codeWages, pfWage, esiWage, ptBase, taxableMonthly }; warnings is string[]. position keeps the engine's order across reads.
-- A payslip is a financial record: the employee row cannot be purged while one points at it (RESTRICT).
CREATE TABLE IF NOT EXISTS public.hrms_payslips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  client_id        uuid,
  run_id           uuid NOT NULL REFERENCES public.hrms_pay_runs(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE RESTRICT,
  month            text NOT NULL,
  position         int  NOT NULL DEFAULT 0,
  days_in_month    int  NOT NULL,
  paid_days        numeric NOT NULL,
  lop_days         numeric NOT NULL,
  overtime_hours   numeric NOT NULL DEFAULT 0,
  earnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  deductions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  employer         jsonb NOT NULL DEFAULT '[]'::jsonb,
  reimbursements   jsonb NOT NULL DEFAULT '[]'::jsonb,
  gross            numeric(14,2) NOT NULL,
  total_deductions numeric(14,2) NOT NULL,
  net              numeric(14,2) NOT NULL,
  employer_cost    numeric(14,2) NOT NULL,
  wages            jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_payslips_month_chk  CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT hrms_payslips_lines_chk  CHECK (jsonb_typeof(earnings) = 'array' AND jsonb_typeof(deductions) = 'array'
                                             AND jsonb_typeof(employer) = 'array' AND jsonb_typeof(reimbursements) = 'array'),
  CONSTRAINT hrms_payslips_wages_chk  CHECK (jsonb_typeof(wages) = 'object'),
  CONSTRAINT hrms_payslips_warn_chk   CHECK (jsonb_typeof(warnings) = 'array')
);

-- ── Full and final settlements ──────────────────────────────────────────────
-- due_by is set by the API: two working days after the last working day (Code on Wages).
CREATE TABLE IF NOT EXISTS public.hrms_fnf_cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  client_id          uuid,
  employee_id        uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE RESTRICT,
  last_working_date  date NOT NULL,
  resignation_date   date,
  notice_days_served numeric NOT NULL DEFAULT 0,
  leave_encash_days  numeric NOT NULL DEFAULT 0,
  other_recoveries   numeric(14,2) NOT NULL DEFAULT 0,
  other_payments     numeric(14,2) NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'draft',
  due_by             date NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_fnf_status_chk   CHECK (status IN ('draft', 'approved', 'paid')),
  CONSTRAINT hrms_fnf_amounts_chk  CHECK (other_recoveries >= 0 AND other_payments >= 0),
  CONSTRAINT hrms_fnf_notice_chk   CHECK (notice_days_served >= 0 AND notice_days_served <= 365),
  CONSTRAINT hrms_fnf_encash_chk   CHECK (leave_encash_days >= 0 AND leave_encash_days <= 365),
  CONSTRAINT hrms_fnf_dates_chk    CHECK (resignation_date IS NULL OR resignation_date <= last_working_date)
);

-- ── Access log: the bank file ───────────────────────────────────────────────
-- Every bank file the API hands out writes ONE row: field 'bank_file', no single employee (employee_id NULL), run_id = the run, reason
-- "Bank file for <entity> <month>". So employee_id becomes nullable and the field list gains 'bank_file'; a reveal of a PAN / bank /
-- aadhaar still needs its employee (hrms_access_log_employee_chk). Existing rows satisfy the new rules as they stand.
ALTER TABLE public.hrms_access_log ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE public.hrms_access_log ALTER COLUMN employee_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hrms_access_log_field_chk' AND conrelid = 'public.hrms_access_log'::regclass AND pg_get_constraintdef(oid) LIKE '%bank_file%'
  ) THEN
    ALTER TABLE public.hrms_access_log DROP CONSTRAINT IF EXISTS hrms_access_log_field_chk;
    ALTER TABLE public.hrms_access_log ADD CONSTRAINT hrms_access_log_field_chk CHECK (field IN ('pan', 'bank', 'aadhaar', 'bank_file'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrms_access_log_employee_chk' AND conrelid = 'public.hrms_access_log'::regclass) THEN
    ALTER TABLE public.hrms_access_log ADD CONSTRAINT hrms_access_log_employee_chk CHECK (field = 'bank_file' OR employee_id IS NOT NULL);
  END IF;
END $$;

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_attendance_org_emp_month_uq ON public.hrms_attendance (org_id, employee_id, month);
-- one REGULAR run per legal entity and month (an off-cycle run is not limited here; the API returns the existing one for the same entity and month)
CREATE UNIQUE INDEX IF NOT EXISTS hrms_pay_runs_regular_uq         ON public.hrms_pay_runs (org_id, entity_id, month) WHERE type = 'regular';
CREATE UNIQUE INDEX IF NOT EXISTS hrms_payslips_run_employee_uq    ON public.hrms_payslips (run_id, employee_id);
-- one OPEN settlement per employee (a paid one does not block a later case, for example after a re-hire)
CREATE UNIQUE INDEX IF NOT EXISTS hrms_fnf_cases_open_uq           ON public.hrms_fnf_cases (org_id, employee_id) WHERE status <> 'paid';

CREATE INDEX IF NOT EXISTS hrms_structures_org_idx        ON public.hrms_structures (org_id);
CREATE INDEX IF NOT EXISTS hrms_attendance_org_month_idx  ON public.hrms_attendance (org_id, month);
CREATE INDEX IF NOT EXISTS hrms_attendance_employee_idx   ON public.hrms_attendance (employee_id);
CREATE INDEX IF NOT EXISTS hrms_adjustments_org_month_idx ON public.hrms_adjustments (org_id, month);
CREATE INDEX IF NOT EXISTS hrms_adjustments_employee_idx  ON public.hrms_adjustments (employee_id, month);
CREATE INDEX IF NOT EXISTS hrms_loans_org_idx             ON public.hrms_loans (org_id);
CREATE INDEX IF NOT EXISTS hrms_loans_employee_idx        ON public.hrms_loans (employee_id);
CREATE INDEX IF NOT EXISTS hrms_pay_runs_org_month_idx    ON public.hrms_pay_runs (org_id, month);
CREATE INDEX IF NOT EXISTS hrms_pay_runs_entity_idx       ON public.hrms_pay_runs (entity_id, month);
CREATE INDEX IF NOT EXISTS hrms_pay_run_audit_org_idx     ON public.hrms_pay_run_audit (org_id);
CREATE INDEX IF NOT EXISTS hrms_pay_run_audit_run_idx     ON public.hrms_pay_run_audit (run_id, seq);
CREATE INDEX IF NOT EXISTS hrms_payslips_org_month_idx    ON public.hrms_payslips (org_id, month);
CREATE INDEX IF NOT EXISTS hrms_payslips_run_pos_idx      ON public.hrms_payslips (run_id, position);
CREATE INDEX IF NOT EXISTS hrms_payslips_employee_idx     ON public.hrms_payslips (employee_id);
CREATE INDEX IF NOT EXISTS hrms_fnf_cases_org_idx         ON public.hrms_fnf_cases (org_id);
CREATE INDEX IF NOT EXISTS hrms_fnf_cases_employee_idx    ON public.hrms_fnf_cases (employee_id);
CREATE INDEX IF NOT EXISTS hrms_access_log_run_idx        ON public.hrms_access_log (run_id) WHERE run_id IS NOT NULL;

-- ── Compute: replace a run's payslips in one go ─────────────────────────────
-- PostgREST has no transactions, and "delete the old payslips, insert the new ones, mark the run computed" must never be seen half done
-- (a run with no payslips that says "computed", or old and new slips mixed). The API computes the payslips with the engine and hands them
-- over here as a JSON array; this function stores them verbatim (SQL never recomputes pay), stamps the run and writes the audit row.
-- A frozen or paid run is refused (RUN_FROZEN) whatever the API checked a moment earlier.
-- Errors carry a token as the message (RUN_NOT_FOUND, RUN_FROZEN, PAYSLIP_EMPLOYEE) with SQLSTATE P0001; the API maps them to plain reasons.
CREATE OR REPLACE FUNCTION public.hrms_store_computed_run(
  p_org uuid, p_run uuid, p_payslips jsonb, p_fingerprint text, p_law_version text, p_by_user uuid, p_by_name text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_run public.hrms_pay_runs%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_n   int;
BEGIN
  IF p_org IS NULL OR p_run IS NULL OR p_payslips IS NULL OR jsonb_typeof(p_payslips) <> 'array' OR p_fingerprint IS NULL THEN
    RAISE EXCEPTION 'hrms_store_computed_run: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run FROM public.hrms_pay_runs WHERE id = p_run AND org_id = p_org AND client_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_run.status NOT IN ('draft', 'computed') THEN RAISE EXCEPTION 'RUN_FROZEN' USING ERRCODE = 'P0001'; END IF;

  DELETE FROM public.hrms_payslips WHERE run_id = v_run.id;

  INSERT INTO public.hrms_payslips (
    org_id, client_id, run_id, employee_id, month, position, days_in_month, paid_days, lop_days, overtime_hours,
    earnings, deductions, employer, reimbursements, gross, total_deductions, net, employer_cost, wages, warnings, created_at, updated_at
  )
  SELECT p_org, NULL, v_run.id, x.employee_id, v_run.month, x.position, x.days_in_month, x.paid_days, x.lop_days, x.overtime_hours,
         x.earnings, x.deductions, x.employer, x.reimbursements, x.gross, x.total_deductions, x.net, x.employer_cost, x.wages, x.warnings, v_now, v_now
  FROM jsonb_to_recordset(p_payslips) AS x(
    employee_id uuid, position int, days_in_month int, paid_days numeric, lop_days numeric, overtime_hours numeric,
    earnings jsonb, deductions jsonb, employer jsonb, reimbursements jsonb,
    gross numeric, total_deductions numeric, net numeric, employer_cost numeric, wages jsonb, warnings jsonb
  )
  JOIN public.hrms_employees e ON e.id = x.employee_id AND e.org_id = p_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- every payslip must be for an employee of this org (the join above drops any other): nothing is kept if one was dropped
  IF v_n <> jsonb_array_length(p_payslips) THEN RAISE EXCEPTION 'PAYSLIP_EMPLOYEE' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.hrms_pay_runs
     SET status = 'computed', computed_at = v_now, law_version = p_law_version, input_fingerprint = p_fingerprint, updated_at = v_now
   WHERE id = v_run.id;
  INSERT INTO public.hrms_pay_run_audit (org_id, client_id, run_id, at, by_user_id, by_name, action)
  VALUES (p_org, NULL, v_run.id, v_now, p_by_user, COALESCE(NULLIF(btrim(p_by_name), ''), 'Unknown'), 'Computed ' || v_n || ' payslips');
  RETURN v_n;
END;
$fn$;

-- ── Freeze: lock the run's inputs and recover the loans, atomically ─────────
-- In ONE transaction, with the run row locked: check the status (only a computed run freezes) and that the caller's fingerprint is the one
-- stored by the last compute (so the run was not recomputed, and the API's stale check applies to these payslips), then
--   * add each open loan's recovery, min(emi, principal - recovered), for the people on the run, and record it per loan in loan_recoveries;
--   * lock the month's attendance for exactly the people on the run (only rows that were open), and record who in attendance_locked_for;
--   * set the status to frozen with who and when, and write the audit row.
-- Money is added as numeric, exactly. The unfreeze below gives back exactly what was recorded here, so freeze, unfreeze, freeze never
-- recovers an EMI twice. Locks are taken in the same order everywhere (run, loans, attendance) so a freeze and an unfreeze cannot deadlock.
-- Errors (SQLSTATE P0001, token as the message): RUN_NOT_FOUND, RUN_NOT_COMPUTED, RUN_STALE.
CREATE OR REPLACE FUNCTION public.hrms_freeze_run(p_org uuid, p_run uuid, p_by_user uuid, p_by_name text, p_fingerprint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_run    public.hrms_pay_runs%ROWTYPE;
  v_now    timestamptz := clock_timestamp();
  v_recov  jsonb := '{}'::jsonb;
  v_locked jsonb := '[]'::jsonb;
  v_emi    numeric;
  r        record;
BEGIN
  IF p_org IS NULL OR p_run IS NULL THEN
    RAISE EXCEPTION 'hrms_freeze_run: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run FROM public.hrms_pay_runs WHERE id = p_run AND org_id = p_org AND client_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_run.status <> 'computed' THEN RAISE EXCEPTION 'RUN_NOT_COMPUTED' USING ERRCODE = 'P0001'; END IF;
  IF p_fingerprint IS NULL OR v_run.input_fingerprint IS NULL OR p_fingerprint <> v_run.input_fingerprint THEN
    RAISE EXCEPTION 'RUN_STALE' USING ERRCODE = 'P0001';
  END IF;

  -- loans first (lock order: run, loans, attendance). One payslip per person, so a loan is visited once.
  FOR r IN
    SELECT l.id, l.emi, l.principal, l.recovered
    FROM public.hrms_loans l
    JOIN public.hrms_payslips s ON s.employee_id = l.employee_id AND s.run_id = v_run.id
    WHERE l.org_id = p_org AND l.client_id IS NULL AND l.start_month <= v_run.month AND l.recovered < l.principal
    ORDER BY s.position, l.created_at, l.id
    FOR UPDATE OF l
  LOOP
    v_emi := LEAST(r.emi, r.principal - r.recovered);
    IF v_emi <= 0 THEN CONTINUE; END IF;
    UPDATE public.hrms_loans SET recovered = recovered + v_emi, updated_at = v_now WHERE id = r.id;
    v_recov := v_recov || jsonb_build_object(r.id::text, COALESCE((v_recov ->> r.id::text)::numeric, 0) + v_emi);
  END LOOP;

  -- attendance: only the people on this run (not every entity's), only rows that were still open
  WITH locked AS (
    UPDATE public.hrms_attendance a
       SET locked = true, updated_at = v_now
     WHERE a.org_id = p_org AND a.client_id IS NULL AND a.month = v_run.month AND a.locked = false
       AND a.employee_id IN (SELECT s.employee_id FROM public.hrms_payslips s WHERE s.run_id = v_run.id)
    RETURNING a.employee_id
  )
  SELECT COALESCE(jsonb_agg(employee_id ORDER BY employee_id), '[]'::jsonb) INTO v_locked FROM locked;

  UPDATE public.hrms_pay_runs
     SET status = 'frozen', frozen_at = v_now, frozen_by_user_id = p_by_user, frozen_by = COALESCE(NULLIF(btrim(p_by_name), ''), 'Unknown'),
         loan_recoveries = v_recov, attendance_locked_for = v_locked, updated_at = v_now
   WHERE id = v_run.id;
  INSERT INTO public.hrms_pay_run_audit (org_id, client_id, run_id, at, by_user_id, by_name, action)
  VALUES (p_org, NULL, v_run.id, v_now, p_by_user, COALESCE(NULLIF(btrim(p_by_name), ''), 'Unknown'), 'Frozen. Payslips are locked.');

  RETURN jsonb_build_object('loan_recoveries', v_recov, 'attendance_locked_for', v_locked);
END;
$fn$;

-- ── Unfreeze: put back exactly what the freeze did ──────────────────────────
-- Only a frozen run (a paid run is closed). The reason must be at least 5 characters once trimmed; it goes into the audit row.
-- Each loan gets back the amount recorded in loan_recoveries (never below zero), the attendance the freeze locked is unlocked (and only that),
-- the run goes back to computed with frozen_* cleared. The run stays computed with its payslips; the API reports it stale if inputs moved.
-- Errors (SQLSTATE P0001): RUN_NOT_FOUND, RUN_NOT_FROZEN, UNFREEZE_REASON.
CREATE OR REPLACE FUNCTION public.hrms_unfreeze_run(p_org uuid, p_run uuid, p_by_user uuid, p_by_name text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_run public.hrms_pay_runs%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_why text := btrim(COALESCE(p_reason, ''));
  r     record;
BEGIN
  IF p_org IS NULL OR p_run IS NULL THEN
    RAISE EXCEPTION 'hrms_unfreeze_run: invalid arguments' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_why) < 5 THEN RAISE EXCEPTION 'UNFREEZE_REASON' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM public.hrms_pay_runs WHERE id = p_run AND org_id = p_org AND client_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_run.status <> 'frozen' THEN RAISE EXCEPTION 'RUN_NOT_FROZEN' USING ERRCODE = 'P0001'; END IF;

  FOR r IN SELECT key, value FROM jsonb_each_text(v_run.loan_recoveries) ORDER BY key LOOP
    UPDATE public.hrms_loans
       SET recovered = GREATEST(0, recovered - r.value::numeric), updated_at = v_now
     WHERE id = r.key::uuid AND org_id = p_org AND client_id IS NULL;
  END LOOP;

  UPDATE public.hrms_attendance
     SET locked = false, updated_at = v_now
   WHERE org_id = p_org AND client_id IS NULL AND month = v_run.month
     AND employee_id IN (SELECT e::uuid FROM jsonb_array_elements_text(v_run.attendance_locked_for) AS e);

  UPDATE public.hrms_pay_runs
     SET status = 'computed', frozen_at = NULL, frozen_by_user_id = NULL, frozen_by = NULL,
         loan_recoveries = '{}'::jsonb, attendance_locked_for = '[]'::jsonb, updated_at = v_now
   WHERE id = v_run.id;
  INSERT INTO public.hrms_pay_run_audit (org_id, client_id, run_id, at, by_user_id, by_name, action)
  VALUES (p_org, NULL, v_run.id, v_now, p_by_user, COALESCE(NULLIF(btrim(p_by_name), ''), 'Unknown'), 'Unfrozen: ' || v_why);

  RETURN jsonb_build_object('status', 'computed');
END;
$fn$;

-- ── Mark paid: frozen -> paid with its audit row, atomically ────────────────
-- Errors (SQLSTATE P0001): RUN_NOT_FOUND, RUN_NOT_FROZEN.
CREATE OR REPLACE FUNCTION public.hrms_mark_run_paid(p_org uuid, p_run uuid, p_by_user uuid, p_by_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_run public.hrms_pay_runs%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_org IS NULL OR p_run IS NULL THEN
    RAISE EXCEPTION 'hrms_mark_run_paid: invalid arguments' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.hrms_pay_runs WHERE id = p_run AND org_id = p_org AND client_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_run.status <> 'frozen' THEN RAISE EXCEPTION 'RUN_NOT_FROZEN' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.hrms_pay_runs SET status = 'paid', paid_at = v_now, updated_at = v_now WHERE id = v_run.id;
  INSERT INTO public.hrms_pay_run_audit (org_id, client_id, run_id, at, by_user_id, by_name, action)
  VALUES (p_org, NULL, v_run.id, v_now, p_by_user, COALESCE(NULLIF(btrim(p_by_name), ''), 'Unknown'), 'Marked paid');
  RETURN jsonb_build_object('status', 'paid');
END;
$fn$;

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_structures    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_attendance    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_adjustments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_loans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_pay_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_pay_run_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_payslips      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_fnf_cases     ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Same pattern as the core migration: Supabase hands anon / authenticated everything on new public tables and PUBLIC may execute new
-- functions. Guarded by role existence so the same file runs on a plain Postgres (tests, local) too.
DO $$
DECLARE
  t text;
  f text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hrms_structures', 'hrms_attendance', 'hrms_adjustments', 'hrms_loans', 'hrms_pay_runs', 'hrms_pay_run_audit', 'hrms_payslips', 'hrms_fnf_cases'
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

  FOREACH f IN ARRAY ARRAY[
    'public.hrms_store_computed_run(uuid, uuid, jsonb, text, text, uuid, text)',
    'public.hrms_freeze_run(uuid, uuid, uuid, text, text)',
    'public.hrms_unfreeze_run(uuid, uuid, uuid, text, text)',
    'public.hrms_mark_run_paid(uuid, uuid, uuid, text)'
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
