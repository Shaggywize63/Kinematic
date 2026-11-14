-- HRMS phase 7: the Benefits module on the server (the plan catalogue, per-employee enrolments, insurance claims with
-- their append-only status trail, the enrolment window + its extensions, enrolment reminders, and the send-to-payroll
-- action that creates one-time deductions in the already-server-backed payroll).
--
-- Run AFTER migration_hrms_core.sql (plans/enrolments/claims reference hrms_employees; send-to-payroll writes
-- hrms_adjustments, which migration_hrms_payroll.sql creates) -- it stops with a clear message if the core migration has
-- not been applied. The other phase migrations (payroll, time, lifecycle, privacy, assets) are independent of this file;
-- the seven may be applied in any order after the core one, EXCEPT that hrms_benefit_send_to_payroll needs
-- hrms_adjustments to exist, so apply the payroll migration before using send-to-payroll (the function body is not
-- validated until it runs, so the migration itself applies even if payroll is not yet in place).
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS, CREATE OR REPLACE or a guarded DO block, so running it
-- twice is a no-op. No existing table is touched.
--
-- Tenancy and data protection: exactly as the core migration. Every row carries org_id + client_id (HRMS only writes
-- client_id NULL), RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's
-- service role uses these tables and the functions.
--
-- Note on reserved words: the dashboard's Enrolment has a field `by` (the actor). `by` is a SQL reserved word, so the
-- physical column is `by_name`; the API maps it back to `by` on the wire (matching hrms_pay_run_audit / hrms_asset_events).
-- The `by` inside the claim trail, the window extensions and the sent map is a jsonb key, which needs no renaming.

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_employees') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_benefits.sql';
  END IF;
END $$;

-- ── Benefit plans (the catalogue) ───────────────────────────────────────────
-- The nested shapes (tiers, employer_share_pct, dependants rules, baskets) pass through as jsonb in the dashboard's
-- camelCase shape, exactly as lifecycle stores its checklist arrays. Only the kind is constrained; the arithmetic shapes
-- are validated by the API's zod schema and reproduced by the ported engine.
CREATE TABLE IF NOT EXISTS public.hrms_benefit_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  client_id          uuid,
  kind               text NOT NULL,
  name               text NOT NULL,
  summary            text NOT NULL DEFAULT '',
  provider           text NOT NULL DEFAULT '',
  auto               boolean NOT NULL DEFAULT false,
  tiers              jsonb NOT NULL DEFAULT '[]'::jsonb,
  employer_share_pct jsonb NOT NULL DEFAULT '{}'::jsonb,
  dependants         jsonb,
  flex_monthly       numeric(14,2),
  baskets            jsonb,
  tax_note           text NOT NULL DEFAULT '',
  cover_start        date NOT NULL,
  renews_on          date NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_benefit_plans_kind_chk CHECK (kind IN ('health', 'accident', 'meal', 'nps', 'flex')),
  CONSTRAINT hrms_benefit_plans_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT hrms_benefit_plans_flex_chk CHECK (flex_monthly IS NULL OR flex_monthly >= 0),
  CONSTRAINT hrms_benefit_plans_tiers_chk      CHECK (jsonb_typeof(tiers) = 'array'),
  CONSTRAINT hrms_benefit_plans_employer_chk   CHECK (jsonb_typeof(employer_share_pct) = 'object'),
  CONSTRAINT hrms_benefit_plans_dependants_chk CHECK (dependants IS NULL OR jsonb_typeof(dependants) = 'object'),
  CONSTRAINT hrms_benefit_plans_baskets_chk    CHECK (baskets IS NULL OR jsonb_typeof(baskets) = 'array')
);

-- ── Benefit enrolments (one per employee) ───────────────────────────────────
-- submitEnrolment upserts one row per employee (unique org + employee). dependants / flex are jsonb in the dashboard's
-- camelCase shape. A waiver keeps empty dependants/flex and null tiers, exactly as the dashboard writes it.
CREATE TABLE IF NOT EXISTS public.hrms_benefit_enrolments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  client_id    uuid,
  employee_id  uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  status       text NOT NULL,
  submitted_on date NOT NULL,
  by_name      text NOT NULL,
  health_tier  text,
  dependants   jsonb NOT NULL DEFAULT '[]'::jsonb,
  meal_tier    text,
  nps_tier     text,
  flex         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_benefit_enrolments_status_chk     CHECK (status IN ('enrolled', 'waived')),
  CONSTRAINT hrms_benefit_enrolments_dependants_chk CHECK (jsonb_typeof(dependants) = 'array'),
  CONSTRAINT hrms_benefit_enrolments_flex_chk       CHECK (jsonb_typeof(flex) = 'object'),
  CONSTRAINT hrms_benefit_enrolments_by_chk         CHECK (char_length(btrim(by_name)) BETWEEN 1 AND 200)
);

-- ── Benefit claims (with the append-only status trail) ──────────────────────
-- A claim moves through the CLAIM_NEXT state machine (see hrms_benefit_move_claim); the trail is an append-only jsonb
-- array of { on, status, note?, by }, so the history can never diverge from the status. ref is the (sample) TPA number
-- the API assigns; unique per org.
CREATE TABLE IF NOT EXISTS public.hrms_benefit_claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  client_id        uuid,
  ref              text NOT NULL,
  employee_id      uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  patient          text NOT NULL,
  relation         text NOT NULL,
  kind             text NOT NULL,
  hospital         text NOT NULL,
  claimed          numeric(14,2) NOT NULL,
  approved         numeric(14,2),
  filed_on         date NOT NULL,
  closed_on        date,
  status           text NOT NULL,
  rejection_reason text,
  trail            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_benefit_claims_relation_chk CHECK (relation IN ('self', 'spouse', 'child', 'parent')),
  CONSTRAINT hrms_benefit_claims_kind_chk     CHECK (kind IN ('cashless', 'reimbursement')),
  CONSTRAINT hrms_benefit_claims_status_chk   CHECK (status IN ('submitted', 'in_review', 'query', 'approved', 'settled', 'rejected')),
  CONSTRAINT hrms_benefit_claims_claimed_chk  CHECK (claimed > 0),
  CONSTRAINT hrms_benefit_claims_approved_chk CHECK (approved IS NULL OR approved >= 0),
  CONSTRAINT hrms_benefit_claims_trail_chk    CHECK (jsonb_typeof(trail) = 'array'),
  CONSTRAINT hrms_benefit_claims_ref_chk      CHECK (char_length(btrim(ref)) BETWEEN 1 AND 60)
);

-- ── Benefit config (a singleton per org) ────────────────────────────────────
-- One row per org, holding the enrolment window (opens/closes + its extensions), the reminders map (employeeId -> date a
-- reminder was logged) and the sent map (month -> { on, rows, total, by } recorded by send-to-payroll). Unique(org_id):
-- HRMS always writes client_id NULL, so a plain unique on org_id is the singleton key (and the target of the upsert).
CREATE TABLE IF NOT EXISTS public.hrms_benefit_config (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  opens_on   date NOT NULL,
  closes_on  date NOT NULL,
  extensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  reminders  jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_benefit_config_extensions_chk CHECK (jsonb_typeof(extensions) = 'array'),
  CONSTRAINT hrms_benefit_config_reminders_chk  CHECK (jsonb_typeof(reminders) = 'object'),
  CONSTRAINT hrms_benefit_config_sent_chk       CHECK (jsonb_typeof(sent) = 'object')
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS hrms_benefit_plans_org_idx         ON public.hrms_benefit_plans (org_id);
CREATE INDEX IF NOT EXISTS hrms_benefit_plans_org_kind_idx    ON public.hrms_benefit_plans (org_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_benefit_enrolments_org_emp_uq ON public.hrms_benefit_enrolments (org_id, employee_id);
CREATE INDEX IF NOT EXISTS hrms_benefit_enrolments_org_idx    ON public.hrms_benefit_enrolments (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_benefit_claims_org_ref_uq ON public.hrms_benefit_claims (org_id, ref);
CREATE INDEX IF NOT EXISTS hrms_benefit_claims_org_idx        ON public.hrms_benefit_claims (org_id);
CREATE INDEX IF NOT EXISTS hrms_benefit_claims_org_emp_idx    ON public.hrms_benefit_claims (org_id, employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_benefit_config_org_uq  ON public.hrms_benefit_config (org_id);

-- ── Register a claim, atomically ────────────────────────────────────────────
-- Assigns the ref from the current claim count (the dashboard's TPA-26-NNNNN formula: 4100 + count*37 + 41), inserts the
-- claim in 'submitted' with the initial trail entry, and returns the claim id. The unique(org, ref) index is the race-safe
-- backstop: a raced ref raises 23505 and the API recomputes and retries. The API has already validated the inputs
-- (enrolled employee, hospital, amount, patient covered) with the dashboard's plain words.
CREATE OR REPLACE FUNCTION public.hrms_benefit_register_claim(
  p_org uuid, p_claim uuid, p_employee uuid, p_patient text, p_relation text, p_kind text, p_hospital text,
  p_claimed numeric, p_on date, p_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_cnt   integer;
  v_ref   text;
  v_by    text := COALESCE(NULLIF(btrim(p_by), ''), 'Unknown');
BEGIN
  IF p_org IS NULL OR p_claim IS NULL OR p_employee IS NULL THEN
    RAISE EXCEPTION 'hrms_benefit_register_claim: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_cnt FROM public.hrms_benefit_claims WHERE org_id = p_org AND client_id IS NULL;
  v_ref := 'TPA-26-' || lpad((4100 + v_cnt * 37 + 41)::text, 5, '0');

  INSERT INTO public.hrms_benefit_claims (
    id, org_id, client_id, ref, employee_id, patient, relation, kind, hospital, claimed, approved,
    filed_on, closed_on, status, rejection_reason, trail, created_at, updated_at
  ) VALUES (
    p_claim, p_org, NULL, v_ref, p_employee, p_patient, p_relation, p_kind, p_hospital, p_claimed, NULL,
    p_on, NULL, 'submitted', NULL,
    jsonb_build_array(jsonb_build_object('on', to_char(p_on, 'YYYY-MM-DD'), 'status', 'submitted', 'note', 'Claim registered.', 'by', v_by)),
    v_now, v_now
  );

  RETURN p_claim;
END;
$fn$;

-- ── Move a claim through the state machine, atomically ──────────────────────
-- Locks the claim, re-checks CLAIM_NEXT under the lock (so a status that changed between the API's read and this call is
-- caught: of two concurrent moves of one claim, one wins), applies the dashboard's moveClaim mutations and appends the
-- trail entry -- all in one transaction, so the trail and the status never diverge. The API has already validated the
-- amount / reason / reply inputs with the dashboard's plain words; this function enforces the transition itself.
--   CLAIM_NEXT: submitted -> in_review|rejected; in_review -> query|approved|rejected; query -> in_review|rejected;
--               approved -> settled; settled -> (none); rejected -> in_review.
-- Errors carry a token as the message (SQLSTATE P0001): CLAIM_NOT_FOUND, CLAIM_STATE (illegal transition); the API maps
-- them to the dashboard's plain reasons. Returns the claim id; the API reads the updated claim back.
CREATE OR REPLACE FUNCTION public.hrms_benefit_move_claim(
  p_org uuid, p_claim uuid, p_to text, p_on date, p_approved numeric, p_reason text, p_note text, p_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_claim   public.hrms_benefit_claims%ROWTYPE;
  v_now     timestamptz := clock_timestamp();
  v_allowed boolean := false;
  v_closed  date;
  v_reject  text;
  v_approved numeric;
  v_by      text := COALESCE(NULLIF(btrim(p_by), ''), 'Unknown');
  v_entry   jsonb;
BEGIN
  IF p_org IS NULL OR p_claim IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'hrms_benefit_move_claim: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim FROM public.hrms_benefit_claims WHERE id = p_claim AND org_id = p_org AND client_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  v_allowed := CASE v_claim.status
    WHEN 'submitted' THEN p_to IN ('in_review', 'rejected')
    WHEN 'in_review' THEN p_to IN ('query', 'approved', 'rejected')
    WHEN 'query'     THEN p_to IN ('in_review', 'rejected')
    WHEN 'approved'  THEN p_to IN ('settled')
    WHEN 'settled'   THEN false
    WHEN 'rejected'  THEN p_to IN ('in_review')
    ELSE false
  END;
  IF NOT v_allowed THEN RAISE EXCEPTION 'CLAIM_STATE' USING ERRCODE = 'P0001'; END IF;

  v_closed   := v_claim.closed_on;
  v_reject   := v_claim.rejection_reason;
  v_approved := v_claim.approved;

  IF p_to = 'approved' THEN v_approved := round(p_approved); END IF;
  IF p_to IN ('settled', 'rejected') THEN v_closed := p_on; END IF;
  IF p_to = 'rejected' THEN v_reject := btrim(p_reason); v_approved := NULL; END IF;
  IF p_to = 'in_review' AND v_closed IS NOT NULL THEN v_closed := NULL; v_reject := NULL; END IF;

  -- trail entry: { on, status, note?, by } -- note omitted when blank (jsonb_strip_nulls), as the dashboard does
  v_entry := jsonb_strip_nulls(jsonb_build_object(
    'on', to_char(p_on, 'YYYY-MM-DD'), 'status', p_to,
    'note', CASE WHEN btrim(COALESCE(p_note, '')) = '' THEN NULL ELSE btrim(p_note) END, 'by', v_by));

  UPDATE public.hrms_benefit_claims
     SET status = p_to, approved = v_approved, closed_on = v_closed, rejection_reason = v_reject,
         trail = trail || v_entry, updated_at = v_now
   WHERE id = p_claim;

  RETURN p_claim;
END;
$fn$;

-- ── Send the monthly deductions to payroll, atomically ──────────────────────
-- Replaces the prior one-time deductions tagged `[benefits <month>]` for the org + month: refuses while that month's
-- pay run is frozen or paid (the dashboard blocks the send then), deletes the old tagged rows, inserts the new ones
-- (kind one_time_deduction, taxable false; the note already carries the tag), and records the send in the config `sent`
-- map -- all in one transaction, so payroll never loses the old rows without gaining the new ones. The deduction amounts
-- are computed by the ported engine in the service (so they match the dashboard exactly) and passed in as p_rows; this
-- function does no arithmetic on them. The config row is created by ensure_config in the service before this runs.
--   p_rows: jsonb array of { employee_id, amount, note } (note already prefixed with the tag).
--   p_sent: the { on, rows, total, by } entry to store under sent[p_month].
-- Returns the number of old rows removed. RUN_LOCKED (SQLSTATE P0001) if the month's run is frozen/paid.
CREATE OR REPLACE FUNCTION public.hrms_benefit_send_to_payroll(
  p_org uuid, p_month text, p_tag text, p_rows jsonb, p_sent jsonb, p_by text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_removed integer := 0;
  v_row     jsonb;
  v_by      text := COALESCE(NULLIF(btrim(p_by), ''), 'Unknown');
BEGIN
  IF p_org IS NULL OR p_month IS NULL OR p_tag IS NULL THEN
    RAISE EXCEPTION 'hrms_benefit_send_to_payroll: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.hrms_pay_runs
              WHERE org_id = p_org AND client_id IS NULL AND month = p_month AND status IN ('frozen', 'paid')) THEN
    RAISE EXCEPTION 'RUN_LOCKED' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.hrms_adjustments
   WHERE org_id = p_org AND client_id IS NULL AND month = p_month
     AND note IS NOT NULL AND starts_with(note, p_tag);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    INSERT INTO public.hrms_adjustments (
      id, org_id, client_id, employee_id, month, kind, amount, taxable, note, source, created_by, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), p_org, NULL, (v_row->>'employee_id')::uuid, p_month, 'one_time_deduction',
      (v_row->>'amount')::numeric, false, v_row->>'note', NULL, v_by, v_now, v_now
    );
  END LOOP;

  UPDATE public.hrms_benefit_config
     SET sent = jsonb_set(COALESCE(sent, '{}'::jsonb), ARRAY[p_month], p_sent, true), updated_at = v_now
   WHERE org_id = p_org AND client_id IS NULL;

  RETURN v_removed;
END;
$fn$;

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_benefit_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_benefit_enrolments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_benefit_claims     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_benefit_config     ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Same pattern as the core / payroll / lifecycle / assets migrations. Guarded by role existence so the same file runs on
-- a plain Postgres too.
DO $$
DECLARE
  t text;
  f text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hrms_benefit_plans', 'hrms_benefit_enrolments', 'hrms_benefit_claims', 'hrms_benefit_config'] LOOP
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
    'public.hrms_benefit_register_claim(uuid, uuid, uuid, text, text, text, text, numeric, date, text)',
    'public.hrms_benefit_move_claim(uuid, uuid, text, date, numeric, text, text, text)',
    'public.hrms_benefit_send_to_payroll(uuid, text, text, jsonb, jsonb, text)'
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
