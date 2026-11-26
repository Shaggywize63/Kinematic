-- HRMS phase 11: Engagement on the server (the People area's workplace feedback). It stores the pulse surveys and their
-- anonymous, team-level responses, the recognition values catalogue and the kudos posted against it, the completed exit
-- interviews, and the area's activity log.
--
-- The dashboard's rules (lib/hrms/people/engagementEngine.ts + engagementActions.ts) are reproduced by the API with the
-- same words:
--   - a pulse has a name (3+ chars) and 1 to 5 questions, each with some text (5+ chars); it opens on the day it is sent
--     and closes 14 days later (or by hand); nothing is emailed -- it is a simulation;
--   - a response is ANONYMOUS: it carries ONLY the team it came from and the answers, never a person, and its created_at
--     is an audit stamp that is never used for any result; answers are cleaned to the question type (a rating is 1..5);
--   - recognition ("kudos") names who is thanked, the value it shows and a message of at least 10 characters;
--   - an exit interview is completed once per exit case (1 to 3 reasons, a would-return answer); individual answers are
--     HR-only and the team-level themes appear only once enough interviews are in (that minimum lives in the dashboard).
-- The CHECK constraints and unique indexes below are the backstop for the shapes; the plain-sentence rules are applied in
-- the service so the reason is the dashboard's, unprefixed.
--
-- Privacy by construction: a response has NO employee_id and NO free time field -- there is deliberately no way to tie a
-- response to a person. Only the backend's service role reads these tables (RLS on, no policies).
--
-- Run AFTER migration_hrms_core.sql (kudos reference hrms_employees) -- it stops with a clear message if the core
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
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_engagement.sql';
  END IF;
END $$;

-- ── Recognition values ───────────────────────────────────────────────────────
-- The company values kudos are given against. Seeded on first bootstrap from the standard list (by key, idempotent); the
-- dashboard references a value by its stable key ("v_customer"), which is what the API sends out as the value's id.
CREATE TABLE IF NOT EXISTS public.hrms_eng_values (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  key         text NOT NULL,
  name        text NOT NULL,
  blurb       text NOT NULL DEFAULT '',
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_eng_values_key_chk  CHECK (char_length(btrim(key)) BETWEEN 1 AND 40),
  CONSTRAINT hrms_eng_values_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 80)
);

-- ── Surveys (pulses) ─────────────────────────────────────────────────────────
-- questions is [{ id, type, text }] with type in rating | yesno | text and id like "q1".
CREATE TABLE IF NOT EXISTS public.hrms_eng_surveys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  title       text NOT NULL,
  sent_on     date NOT NULL,
  closes_on   date NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  questions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_eng_surveys_title_chk  CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT hrms_eng_surveys_status_chk CHECK (status IN ('open', 'closed')),
  CONSTRAINT hrms_eng_surveys_q_chk      CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 5),
  CONSTRAINT hrms_eng_surveys_close_chk  CHECK (closes_on >= sent_on)
);

-- ── Responses (anonymous, team-level) ────────────────────────────────────────
-- A response carries ONLY the team and the answers. There is NO employee column and NO submission-time column that any
-- result uses (created_at is an append stamp only). answers is { questionId: value }.
CREATE TABLE IF NOT EXISTS public.hrms_eng_responses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  survey_id   uuid NOT NULL REFERENCES public.hrms_eng_surveys(id) ON DELETE CASCADE,
  team_id     text NOT NULL,
  answers     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_eng_responses_team_chk    CHECK (char_length(btrim(team_id)) BETWEEN 1 AND 60),
  CONSTRAINT hrms_eng_responses_answers_chk CHECK (jsonb_typeof(answers) = 'object')
);

-- ── Recognition (kudos) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_eng_kudos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  from_name   text NOT NULL DEFAULT '',
  to_id       uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  value_id    text NOT NULL,
  message     text NOT NULL,
  on_date     date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_eng_kudos_value_chk CHECK (char_length(btrim(value_id)) BETWEEN 1 AND 40),
  CONSTRAINT hrms_eng_kudos_msg_chk   CHECK (char_length(btrim(message)) BETWEEN 10 AND 1000)
);

-- ── Exit interviews ──────────────────────────────────────────────────────────
-- Completed once per exit case. exit_id points at a lifecycle exit (no cross-area FK: the lifecycle flag is kept in step
-- by the dashboard). employee_id may be null for an earlier leaver not in the employee list; label always names them.
CREATE TABLE IF NOT EXISTS public.hrms_eng_exit_interviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  exit_id       uuid,
  employee_id   uuid,
  label         text NOT NULL DEFAULT '',
  completed_on  date NOT NULL,
  reasons       jsonb NOT NULL DEFAULT '[]'::jsonb,
  would_return  text NOT NULL,
  text          text NOT NULL DEFAULT '',
  by_name       text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_eng_exit_reasons_chk CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) BETWEEN 1 AND 3),
  CONSTRAINT hrms_eng_exit_return_chk  CHECK (would_return IN ('yes', 'maybe', 'no'))
);

-- ── Activity log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_eng_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  at         timestamptz NOT NULL DEFAULT now(),
  by_name    text NOT NULL DEFAULT '',
  action     text NOT NULL,
  detail     text,
  CONSTRAINT hrms_eng_log_action_chk CHECK (char_length(action) BETWEEN 1 AND 120)
);

-- ── Indexes / uniques ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_eng_values_org_key_uq      ON public.hrms_eng_values (org_id, lower(btrim(key)));
CREATE INDEX        IF NOT EXISTS hrms_eng_surveys_org_idx        ON public.hrms_eng_surveys (org_id, sent_on DESC);
CREATE INDEX        IF NOT EXISTS hrms_eng_responses_survey_idx   ON public.hrms_eng_responses (survey_id);
CREATE INDEX        IF NOT EXISTS hrms_eng_responses_org_idx      ON public.hrms_eng_responses (org_id, survey_id, team_id);
CREATE INDEX        IF NOT EXISTS hrms_eng_kudos_org_idx          ON public.hrms_eng_kudos (org_id, on_date DESC);
CREATE INDEX        IF NOT EXISTS hrms_eng_kudos_to_idx           ON public.hrms_eng_kudos (to_id);
-- One interview per exit case (NULL exit_id, an earlier leaver with no case, is not constrained).
CREATE UNIQUE INDEX IF NOT EXISTS hrms_eng_exit_org_exit_uq       ON public.hrms_eng_exit_interviews (org_id, exit_id) WHERE exit_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS hrms_eng_exit_org_idx           ON public.hrms_eng_exit_interviews (org_id, completed_on DESC);
CREATE INDEX        IF NOT EXISTS hrms_eng_log_org_at_idx         ON public.hrms_eng_log (org_id, at DESC);

-- ── Row-level security: on, no policies; only the service role reaches these tables ──
ALTER TABLE public.hrms_eng_values          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_eng_surveys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_eng_responses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_eng_kudos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_eng_exit_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_eng_log             ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hrms_eng_values', 'hrms_eng_surveys', 'hrms_eng_responses', 'hrms_eng_kudos', 'hrms_eng_exit_interviews', 'hrms_eng_log'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('GRANT ALL ON public.%I TO service_role', t); END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
