-- HRMS phase 10: Learning on the server (the People area's training). It stores the course catalogue (lessons and
-- quiz included), who has been given which course and how far they are, the certificates issued on a pass, the
-- reminders logged for overdue people, and the area's activity log.
--
-- The dashboard's rules (lib/hrms/people/learningEngine.ts + learningActions.ts) are reproduced by the API with the
-- same words: a course is "mandatory for" an audience of departments / designations / locations (an empty list means
-- everyone); "Apply rules" creates the assignments a rule calls for and nobody has made; lessons are finished in order
-- and the quiz comes last; a score of 70% or more passes, completes the course and issues a certificate
-- (CERT-<year>-<0000>, numbered per org), valid for the course's refresher interval; a refresher is a new assignment
-- for the same person and course. The CHECK constraints and unique indexes below are the backstop for the shapes.
--
-- Run AFTER migration_hrms_core.sql (assignments reference hrms_employees) -- it stops with a clear message if the core
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
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_learning.sql';
  END IF;
END $$;

-- ── Courses ──────────────────────────────────────────────────────────────────
-- The catalogue. audience is { departmentIds, designationIds, locationIds } (each empty = everyone on that dimension);
-- lessons is [{ title, body }]; quiz is [{ q, options[], answer }] (answer = index of the right option).
-- refresher_months 0 = a one-off course; due_days = how long a person gets from the day the course is assigned.
CREATE TABLE IF NOT EXISTS public.hrms_learn_courses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  client_id        uuid,
  code             text NOT NULL,
  title            text NOT NULL,
  category         text NOT NULL DEFAULT 'compliance',
  mode             text NOT NULL DEFAULT 'self_paced',
  duration_min     integer NOT NULL DEFAULT 30,
  summary          text NOT NULL DEFAULT '',
  mandatory        boolean NOT NULL DEFAULT false,
  audience         jsonb NOT NULL DEFAULT '{"departmentIds":[],"designationIds":[],"locationIds":[]}'::jsonb,
  refresher_months integer NOT NULL DEFAULT 0,
  due_days         integer NOT NULL DEFAULT 30,
  owner            text NOT NULL DEFAULT '',
  lessons          jsonb NOT NULL DEFAULT '[]'::jsonb,
  quiz             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_learn_courses_code_chk      CHECK (char_length(btrim(code)) BETWEEN 1 AND 24),
  CONSTRAINT hrms_learn_courses_title_chk     CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT hrms_learn_courses_category_chk  CHECK (category IN ('compliance', 'skill')),
  CONSTRAINT hrms_learn_courses_mode_chk      CHECK (mode IN ('self_paced', 'classroom')),
  CONSTRAINT hrms_learn_courses_duration_chk  CHECK (duration_min BETWEEN 1 AND 6000),
  CONSTRAINT hrms_learn_courses_refresher_chk CHECK (refresher_months BETWEEN 0 AND 60),
  CONSTRAINT hrms_learn_courses_due_chk       CHECK (due_days BETWEEN 1 AND 365),
  CONSTRAINT hrms_learn_courses_audience_chk  CHECK (jsonb_typeof(audience) = 'object'),
  CONSTRAINT hrms_learn_courses_lessons_chk   CHECK (jsonb_typeof(lessons) = 'array'),
  CONSTRAINT hrms_learn_courses_quiz_chk      CHECK (jsonb_typeof(quiz) = 'array')
);

-- ── Assignments ──────────────────────────────────────────────────────────────
-- One row per time a course is given to a person (a refresher is a new row; the latest one is the current one).
-- steps_done counts finished lessons; attempts counts quiz submissions; completed_on / score / certificate_no are set
-- on a pass.
CREATE TABLE IF NOT EXISTS public.hrms_learn_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  employee_id    uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  course_id      uuid NOT NULL REFERENCES public.hrms_learn_courses(id) ON DELETE CASCADE,
  assigned_on    date NOT NULL,
  due_on         date NOT NULL,
  source         text NOT NULL DEFAULT 'manual',
  steps_done     integer NOT NULL DEFAULT 0,
  attempts       integer NOT NULL DEFAULT 0,
  completed_on   date,
  score          integer,
  certificate_no text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_learn_asg_source_chk   CHECK (source IN ('rule', 'manual', 'refresher')),
  CONSTRAINT hrms_learn_asg_counts_chk   CHECK (steps_done >= 0 AND attempts >= 0),
  CONSTRAINT hrms_learn_asg_score_chk    CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  CONSTRAINT hrms_learn_asg_due_chk      CHECK (due_on >= assigned_on)
);

-- ── Certificates ─────────────────────────────────────────────────────────────
-- Issued when a quiz is passed. number = CERT-<year of issue>-<seq, 4 digits>; seq runs per org. One per assignment.
CREATE TABLE IF NOT EXISTS public.hrms_learn_certificates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  seq           integer NOT NULL,
  number        text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES public.hrms_learn_assignments(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  course_id     uuid NOT NULL REFERENCES public.hrms_learn_courses(id) ON DELETE CASCADE,
  issued_on     date NOT NULL,
  expires_on    date,
  score         integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_learn_cert_seq_chk     CHECK (seq > 0),
  CONSTRAINT hrms_learn_cert_score_chk   CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT hrms_learn_cert_expiry_chk  CHECK (expires_on IS NULL OR expires_on > issued_on)
);

-- ── Reminders ────────────────────────────────────────────────────────────────
-- A reminder is LOGGED, not sent: there is no mail or message service behind it yet.
CREATE TABLE IF NOT EXISTS public.hrms_learn_reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  assignment_id uuid NOT NULL REFERENCES public.hrms_learn_assignments(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  course_id     uuid NOT NULL REFERENCES public.hrms_learn_courses(id) ON DELETE CASCADE,
  reminded_on   date NOT NULL,
  reminded_by   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Activity log ─────────────────────────────────────────────────────────────
-- What changed and who did it ("Course assigned", "Rules applied", "Course completed", ...). Append-only.
CREATE TABLE IF NOT EXISTS public.hrms_learn_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  at         timestamptz NOT NULL DEFAULT now(),
  by_name    text NOT NULL DEFAULT '',
  action     text NOT NULL,
  detail     text,
  CONSTRAINT hrms_learn_log_action_chk CHECK (char_length(action) BETWEEN 1 AND 120)
);

-- ── Indexes / uniques ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_learn_courses_org_code_uq   ON public.hrms_learn_courses (org_id, lower(btrim(code)));
CREATE INDEX        IF NOT EXISTS hrms_learn_courses_org_idx       ON public.hrms_learn_courses (org_id);
CREATE INDEX        IF NOT EXISTS hrms_learn_asg_org_emp_course_idx ON public.hrms_learn_assignments (org_id, employee_id, course_id);
CREATE INDEX        IF NOT EXISTS hrms_learn_asg_org_course_idx    ON public.hrms_learn_assignments (org_id, course_id);
CREATE INDEX        IF NOT EXISTS hrms_learn_asg_employee_idx      ON public.hrms_learn_assignments (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_learn_cert_org_seq_uq       ON public.hrms_learn_certificates (org_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_learn_cert_org_number_uq    ON public.hrms_learn_certificates (org_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_learn_cert_assignment_uq    ON public.hrms_learn_certificates (assignment_id);
CREATE INDEX        IF NOT EXISTS hrms_learn_cert_employee_idx     ON public.hrms_learn_certificates (employee_id);
CREATE INDEX        IF NOT EXISTS hrms_learn_rem_org_idx           ON public.hrms_learn_reminders (org_id, reminded_on DESC);
CREATE INDEX        IF NOT EXISTS hrms_learn_rem_assignment_idx    ON public.hrms_learn_reminders (assignment_id);
CREATE INDEX        IF NOT EXISTS hrms_learn_log_org_at_idx        ON public.hrms_learn_log (org_id, at DESC);

-- ── Row-level security: on, no policies; only the service role reaches these tables ──
ALTER TABLE public.hrms_learn_courses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_learn_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_learn_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_learn_reminders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_learn_log          ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hrms_learn_courses', 'hrms_learn_assignments', 'hrms_learn_certificates', 'hrms_learn_reminders', 'hrms_learn_log'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('GRANT ALL ON public.%I TO service_role', t); END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
