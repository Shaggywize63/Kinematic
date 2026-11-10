-- HRMS phase 1: organisation + people (legal entities, locations, departments, designations, employees, their
-- documents, change log, the sensitive-data access log, settings and the employee-code counter).
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS or a guarded DO block, so running it twice is a no-op.
--
-- Tenancy: every row carries org_id + client_id. HRMS only ever writes client_id NULL (the org's own people); the
-- backend filters `org_id = <caller's org> AND client_id IS NULL` on every query (src/services/hrms/scope.ts).
--
-- Data protection (DPDP): these tables hold personal data.
--   * Row level security is ENABLED with NO policies, so PostgREST's anon / authenticated roles see nothing. The
--     backend uses the service role, which bypasses RLS.
--   * anon / authenticated also lose their table privileges (RLS does not stop TRUNCATE).
--   * PAN and bank details are stored ENCRYPTED (AES-256-GCM, app level, see src/lib/hrmsCrypto.ts): pan_enc and
--     bank_enc hold ciphertext only. Only the last four digits of Aadhaar are ever kept (checked below).
--
-- Access: master admin only, never while impersonating (src/middleware/hrmsAccess.ts).

-- ── Legal entities ──────────────────────────────────────────────────────────
-- Company identifiers (PAN, TAN, CIN, GSTIN), not personal data: stored in the clear.
CREATE TABLE IF NOT EXISTS public.hrms_entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  name          text NOT NULL,
  pan           text,
  tan           text,
  cin           text,
  gstin         text,
  address       jsonb NOT NULL DEFAULT '{}'::jsonb,        -- { line1, line2, city, state, pincode }
  registrations jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{ id, type, state, number, validFrom, validTo, notes }]
  signatory     jsonb,                                     -- { name, designation }
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_entities_name_chk          CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT hrms_entities_registrations_chk CHECK (jsonb_typeof(registrations) = 'array')
);

-- ── Locations ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  entity_id       uuid NOT NULL REFERENCES public.hrms_entities(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  state           text NOT NULL,
  city            text NOT NULL,
  address         text,
  metro           boolean NOT NULL DEFAULT false,
  holiday_list_id text,                                    -- holiday lists are not on the server yet: a plain id
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_locations_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 120)
);

-- ── Departments ─────────────────────────────────────────────────────────────
-- head_id points at hrms_employees, which does not exist yet (employees point back at departments): the foreign
-- key is added after the employees table is created.
CREATE TABLE IF NOT EXISTS public.hrms_departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  name       text NOT NULL,
  head_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_departments_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 100)
);

-- ── Designations ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_designations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  name       text NOT NULL,
  grade      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_designations_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 100)
);

-- ── Employees ───────────────────────────────────────────────────────────────
-- Enum values are the ones in the dashboard's src/lib/hrms/types.ts.
CREATE TABLE IF NOT EXISTS public.hrms_employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  client_id           uuid,
  code                text NOT NULL,                       -- shown to people, e.g. EMP-0001; unique per org while not deleted
  first_name          text NOT NULL,
  last_name           text NOT NULL DEFAULT '',            -- single-name people exist
  email               text NOT NULL,
  mobile              text NOT NULL,
  gender              text NOT NULL,
  dob                 date NOT NULL,
  father_name         text,
  marital_status      text,
  blood_group         text,
  address             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { line1, line2, city, state, pincode }
  emergency_contact   jsonb,                               -- { name, relation, mobile }

  entity_id           uuid NOT NULL REFERENCES public.hrms_entities(id)     ON DELETE RESTRICT,
  location_id         uuid NOT NULL REFERENCES public.hrms_locations(id)    ON DELETE RESTRICT,
  department_id       uuid NOT NULL REFERENCES public.hrms_departments(id)  ON DELETE RESTRICT,
  designation_id      uuid NOT NULL REFERENCES public.hrms_designations(id) ON DELETE RESTRICT,
  reporting_to_id     uuid REFERENCES public.hrms_employees(id) ON DELETE SET NULL,
  employment_type     text NOT NULL,
  status              text NOT NULL DEFAULT 'onboarding',
  join_date           date NOT NULL,
  confirmation_date   date,
  probation_months    int  NOT NULL DEFAULT 0,
  notice_days         int  NOT NULL DEFAULT 0,
  last_working_date   date,
  shift_id            text,                                -- shifts are not on the server yet: a plain id
  cost_centre         text,
  contract_end_date   date,

  pan_enc             text,                                -- AES-256-GCM ciphertext of the PAN; never the PAN itself
  aadhaar_last4       text,                                -- only ever four digits
  aadhaar_verified    boolean NOT NULL DEFAULT false,
  uan                 text,
  uan_status          text NOT NULL DEFAULT 'none',
  pf_member           boolean NOT NULL DEFAULT false,
  pf_on_actual_wage   boolean NOT NULL DEFAULT false,
  pf_join_date        date,
  esic_ip             text,
  pt_applicable       boolean NOT NULL DEFAULT false,
  lwf_applicable      boolean NOT NULL DEFAULT false,
  tax_regime          text NOT NULL DEFAULT 'new',
  declaration         jsonb NOT NULL DEFAULT '{"sec80C":0,"sec80D":0,"nps80CCD1B":0,"homeLoanInterest":0,"rentPaidAnnual":0,"other":0,"status":"not_submitted"}'::jsonb,
  bank_enc            text,                                -- AES-256-GCM ciphertext of the bank JSON; never the account number
  pay_mode            text NOT NULL DEFAULT 'bank',
  structure_id        text,                                -- salary structures are not on the server yet: a plain id
  annual_ctc          numeric(14,2),
  structure_overrides jsonb,                               -- { componentId: monthly rupees }

  deleted_at          timestamptz,                         -- soft delete (drafts only; the API refuses anything else)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hrms_employees_first_name_chk   CHECK (char_length(btrim(first_name)) BETWEEN 1 AND 100),
  CONSTRAINT hrms_employees_last_name_chk    CHECK (char_length(last_name) <= 100),
  CONSTRAINT hrms_employees_code_chk         CHECK (char_length(btrim(code)) BETWEEN 1 AND 32),
  CONSTRAINT hrms_employees_gender_chk       CHECK (gender IN ('male', 'female', 'other')),
  CONSTRAINT hrms_employees_marital_chk      CHECK (marital_status IS NULL OR marital_status IN ('single', 'married', 'other')),
  CONSTRAINT hrms_employees_emp_type_chk     CHECK (employment_type IN ('permanent', 'fixed_term', 'contract', 'intern', 'daily_wage')),
  CONSTRAINT hrms_employees_status_chk       CHECK (status IN ('onboarding', 'active', 'on_notice', 'exited')),
  CONSTRAINT hrms_employees_uan_status_chk   CHECK (uan_status IN ('none', 'generated', 'activated', 'aadhaar_seeded')),
  CONSTRAINT hrms_employees_tax_regime_chk   CHECK (tax_regime IN ('new', 'old')),
  CONSTRAINT hrms_employees_pay_mode_chk     CHECK (pay_mode IN ('bank', 'cash', 'cheque')),
  CONSTRAINT hrms_employees_probation_chk    CHECK (probation_months BETWEEN 0 AND 60),
  CONSTRAINT hrms_employees_notice_chk       CHECK (notice_days BETWEEN 0 AND 365),
  CONSTRAINT hrms_employees_ctc_chk          CHECK (annual_ctc IS NULL OR annual_ctc >= 0),
  CONSTRAINT hrms_employees_aadhaar4_chk     CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT hrms_employees_not_own_boss_chk CHECK (reporting_to_id IS NULL OR reporting_to_id <> id)
);

-- Department heads are employees (set null when the employee row goes). Guarded so a re-run does not fail.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hrms_departments_head_fk' AND conrelid = 'public.hrms_departments'::regclass
  ) THEN
    ALTER TABLE public.hrms_departments
      ADD CONSTRAINT hrms_departments_head_fk
      FOREIGN KEY (head_id) REFERENCES public.hrms_employees(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Employee documents (metadata only; file upload is a later phase) ────────
CREATE TABLE IF NOT EXISTS public.hrms_employee_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  type        text NOT NULL,
  name        text NOT NULL,
  uploaded_on date NOT NULL DEFAULT CURRENT_DATE,
  status      text NOT NULL DEFAULT 'pending',
  mandatory   boolean NOT NULL DEFAULT false,
  file_name   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_employee_documents_type_chk   CHECK (type IN ('offer_letter', 'appointment_letter', 'id_proof', 'address_proof', 'pan_card', 'aadhaar', 'education', 'experience', 'bank_proof', 'relieving_letter', 'other')),
  CONSTRAINT hrms_employee_documents_status_chk CHECK (status IN ('pending', 'uploaded', 'verified', 'rejected')),
  CONSTRAINT hrms_employee_documents_name_chk   CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
);

-- ── Employee change log ─────────────────────────────────────────────────────
-- One row per changed field. PAN / bank rows say "Updated", never the value.
CREATE TABLE IF NOT EXISTS public.hrms_employee_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  by_user_id  uuid,
  by_name     text NOT NULL,
  field       text NOT NULL,
  from_value  text,
  to_value    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Access log: every reveal of a sensitive value ───────────────────────────
-- employee_id is deliberately NOT a foreign key: the trail must outlive the employee row.
CREATE TABLE IF NOT EXISTS public.hrms_access_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  by_user_id  uuid,
  by_name     text NOT NULL,
  employee_id uuid NOT NULL,
  field       text NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_access_log_field_chk  CHECK (field IN ('pan', 'bank', 'aadhaar')),
  CONSTRAINT hrms_access_log_reason_chk CHECK (char_length(btrim(reason)) >= 5)
);

-- ── Settings (employee_code_prefix today) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Counters (employee codes) ───────────────────────────────────────────────
-- next_value is the number the NEXT call will hand out.
CREATE TABLE IF NOT EXISTS public.hrms_counters (
  org_id     uuid NOT NULL,
  name       text NOT NULL,
  next_value int  NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, name),
  CONSTRAINT hrms_counters_next_chk CHECK (next_value >= 1)
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_employees_org_code_uq ON public.hrms_employees (org_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hrms_settings_org_key_uq   ON public.hrms_settings (org_id, key);

CREATE INDEX IF NOT EXISTS hrms_entities_org_idx       ON public.hrms_entities (org_id);
CREATE INDEX IF NOT EXISTS hrms_locations_org_idx      ON public.hrms_locations (org_id);
CREATE INDEX IF NOT EXISTS hrms_locations_entity_idx   ON public.hrms_locations (entity_id);
CREATE INDEX IF NOT EXISTS hrms_departments_org_idx    ON public.hrms_departments (org_id);
CREATE INDEX IF NOT EXISTS hrms_departments_head_idx   ON public.hrms_departments (head_id);
CREATE INDEX IF NOT EXISTS hrms_designations_org_idx   ON public.hrms_designations (org_id);
CREATE INDEX IF NOT EXISTS hrms_employees_org_idx      ON public.hrms_employees (org_id);
CREATE INDEX IF NOT EXISTS hrms_employees_org_status_idx   ON public.hrms_employees (org_id, status);
CREATE INDEX IF NOT EXISTS hrms_employees_org_reporting_idx ON public.hrms_employees (org_id, reporting_to_id);
-- The restrict / set-null checks on these foreign keys look employees up by them.
CREATE INDEX IF NOT EXISTS hrms_employees_entity_idx      ON public.hrms_employees (entity_id);
CREATE INDEX IF NOT EXISTS hrms_employees_location_idx    ON public.hrms_employees (location_id);
CREATE INDEX IF NOT EXISTS hrms_employees_department_idx  ON public.hrms_employees (department_id);
CREATE INDEX IF NOT EXISTS hrms_employees_designation_idx ON public.hrms_employees (designation_id);
CREATE INDEX IF NOT EXISTS hrms_employee_documents_org_idx      ON public.hrms_employee_documents (org_id);
CREATE INDEX IF NOT EXISTS hrms_employee_documents_employee_idx ON public.hrms_employee_documents (employee_id);
CREATE INDEX IF NOT EXISTS hrms_employee_history_org_idx        ON public.hrms_employee_history (org_id);
CREATE INDEX IF NOT EXISTS hrms_employee_history_employee_idx   ON public.hrms_employee_history (employee_id, at DESC);
CREATE INDEX IF NOT EXISTS hrms_access_log_org_idx      ON public.hrms_access_log (org_id, at DESC);
CREATE INDEX IF NOT EXISTS hrms_access_log_employee_idx ON public.hrms_access_log (employee_id, at DESC);
CREATE INDEX IF NOT EXISTS hrms_settings_org_idx        ON public.hrms_settings (org_id);
CREATE INDEX IF NOT EXISTS hrms_counters_org_idx        ON public.hrms_counters (org_id);

-- ── Next employee code ──────────────────────────────────────────────────────
-- Atomically hands out the next number for (org, counter name): INSERT .. ON CONFLICT DO UPDATE takes the row lock,
-- so two concurrent creates can never get the same number. The API formats it as <prefix><zero-padded number>.
-- p_count > 1 reserves a block (a bulk import) in one round trip and returns the LAST number of the block.
-- Called with two arguments it behaves exactly as hrms_next_code(p_org, p_name): 1, 2, 3 ...
CREATE OR REPLACE FUNCTION public.hrms_next_code(p_org uuid, p_name text, p_count int DEFAULT 1)
RETURNS int
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_last int;
BEGIN
  IF p_org IS NULL OR p_name IS NULL OR p_count IS NULL OR p_count < 1 OR p_count > 1000 THEN
    RAISE EXCEPTION 'hrms_next_code: invalid arguments' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.hrms_counters AS c (org_id, name, next_value)
  VALUES (p_org, p_name, 1 + p_count)
  ON CONFLICT (org_id, name) DO UPDATE SET next_value = c.next_value + p_count
  RETURNING c.next_value - 1 INTO v_last;
  RETURN v_last;
END;
$fn$;

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_entities           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_locations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_departments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_designations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_employees          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_employee_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_access_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_counters           ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Supabase grants anon / authenticated everything on new public tables and PUBLIC may execute new functions.
-- Guarded by role existence so the same file runs on a plain Postgres (tests, local) too.
DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hrms_entities', 'hrms_locations', 'hrms_departments', 'hrms_designations', 'hrms_employees',
    'hrms_employee_documents', 'hrms_employee_history', 'hrms_access_log', 'hrms_settings', 'hrms_counters'
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

  EXECUTE 'REVOKE ALL ON FUNCTION public.hrms_next_code(uuid, text, int) FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.hrms_next_code(uuid, text, int) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hrms_next_code(uuid, text, int) TO service_role';
  END IF;
END $$;

-- PostgREST caches the schema: tell it to reload.
NOTIFY pgrst, 'reload schema';
