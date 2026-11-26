-- HRMS phase 12: Talent on the server (the People area's talent & succession). It stores the skills catalogue, the
-- required level per designation, each person's skill ratings, the critical roles with their succession bench and its
-- change history, the 9-box placements, and the area's activity log.
--
-- The dashboard's rules (lib/hrms/people/talentEngine.ts + talentActions.ts) are reproduced by the API with the same
-- words:
--   - a skill RATING is a whole number 1..4 (0 = "not assessed" = no row); a level of 3 or 4 needs a note of 8+ chars;
--   - a SUCCESSOR is added to a critical role with a readiness (now | 1-2y | 3y+), some actions and a reason of 5+ chars;
--     the incumbent can never be their own successor and nobody is on a role's bench twice; every add / remove / readiness
--     change is appended to that role's history with the reason;
--   - a 9-box PLACEMENT is one per person: performance 1..3 and potential 1..3 with a rationale of 10+ chars.
-- The CHECK constraints and unique indexes below are the backstop for the shapes; the plain-sentence rules are applied in
-- the service so the reason is the dashboard's, unprefixed.
--
-- Populated demo: unlike a blank-start slice, the service seeds a believable talent picture on first bootstrap, adapted to
-- the ORG'S REAL employees / designations / departments / locations (the standard 12-skill catalogue is fixed; everything
-- else is generated against the rows that exist), so live mode looks like the sample. The seed is deterministic and only
-- runs while the org has no skills yet.
--
-- Run AFTER migration_hrms_core.sql (the employee / designation / department / location tables it references) -- it stops
-- with a clear message if the core migration has not been applied. Independent of the other phase migrations.
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
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_talent.sql';
  END IF;
END $$;

-- ── Skills catalogue ──────────────────────────────────────────────────────────
-- Seeded on first bootstrap from the standard list (by key, idempotent). The dashboard references a skill by its stable
-- key ("sk_field"), which is what the API sends out as the skill's id.
CREATE TABLE IF NOT EXISTS public.hrms_talent_skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  key         text NOT NULL,
  name        text NOT NULL,
  skill_group text NOT NULL DEFAULT '',
  blurb       text NOT NULL DEFAULT '',
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_skills_key_chk  CHECK (char_length(btrim(key)) BETWEEN 1 AND 40),
  CONSTRAINT hrms_talent_skills_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 80)
);

-- ── Skill requirements: the required level per (designation, skill) ────────────
CREATE TABLE IF NOT EXISTS public.hrms_talent_requirements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  designation_id uuid NOT NULL,
  skill_key      text NOT NULL,
  required_level integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_req_level_chk CHECK (required_level BETWEEN 1 AND 4),
  CONSTRAINT hrms_talent_req_skill_chk CHECK (char_length(btrim(skill_key)) BETWEEN 1 AND 40)
);

-- ── Skill ratings: one per (employee, skill); only levels 1..4 are stored ──────
CREATE TABLE IF NOT EXISTS public.hrms_talent_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  skill_key   text NOT NULL,
  level       integer NOT NULL,
  note        text NOT NULL DEFAULT '',
  by_name     text NOT NULL DEFAULT '',
  on_date     date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_rating_level_chk CHECK (level BETWEEN 1 AND 4),
  CONSTRAINT hrms_talent_rating_skill_chk CHECK (char_length(btrim(skill_key)) BETWEEN 1 AND 40)
);

-- ── Critical roles ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_talent_roles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  title          text NOT NULL,
  department_id  uuid,
  location_id    uuid,
  incumbent_id   uuid REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  role_since     date,
  retirement_age integer NOT NULL DEFAULT 60,
  why            text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_roles_title_chk  CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT hrms_talent_roles_retire_chk CHECK (retirement_age BETWEEN 45 AND 80)
);

-- ── Succession bench: a role's candidate successors ───────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_talent_successors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  role_id     uuid NOT NULL REFERENCES public.hrms_talent_roles(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  readiness   text NOT NULL,
  actions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  added_on    date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_succ_ready_chk   CHECK (readiness IN ('now', '1-2y', '3y+')),
  CONSTRAINT hrms_talent_succ_actions_chk CHECK (jsonb_typeof(actions) = 'array')
);

-- ── Succession change history (append-only) ───────────────────────────────────
-- employee_id has NO FK: it is an audit line that must survive a later hard-delete of a draft employee.
CREATE TABLE IF NOT EXISTS public.hrms_talent_succession_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  role_id     uuid NOT NULL REFERENCES public.hrms_talent_roles(id) ON DELETE CASCADE,
  on_date     date NOT NULL,
  by_name     text NOT NULL DEFAULT '',
  kind        text NOT NULL,
  employee_id uuid,
  from_text   text,
  to_text     text,
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_change_kind_chk CHECK (kind IN ('added', 'removed', 'readiness'))
);

-- ── 9-box placements: one per employee ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_talent_placements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  employee_id uuid NOT NULL REFERENCES public.hrms_employees(id) ON DELETE CASCADE,
  performance integer NOT NULL,
  potential   integer NOT NULL,
  rationale   text NOT NULL DEFAULT '',
  by_name     text NOT NULL DEFAULT '',
  on_date     date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_place_perf_chk CHECK (performance BETWEEN 1 AND 3),
  CONSTRAINT hrms_talent_place_pot_chk  CHECK (potential BETWEEN 1 AND 3)
);

-- ── Settings (the review cycle label) ─────────────────────────────────────────
-- A single key/value per org; the only setting today is the cycle label shown on the 9-box tab.
CREATE TABLE IF NOT EXISTS public.hrms_talent_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  key        text NOT NULL,
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_talent_settings_key_chk CHECK (char_length(btrim(key)) BETWEEN 1 AND 60)
);

-- ── Activity log ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hrms_talent_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  at         timestamptz NOT NULL DEFAULT now(),
  by_name    text NOT NULL DEFAULT '',
  action     text NOT NULL,
  detail     text,
  CONSTRAINT hrms_talent_log_action_chk CHECK (char_length(action) BETWEEN 1 AND 120)
);

-- ── Indexes / uniques ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS hrms_talent_skills_org_key_uq   ON public.hrms_talent_skills (org_id, lower(btrim(key)));
CREATE UNIQUE INDEX IF NOT EXISTS hrms_talent_req_org_des_skill_uq ON public.hrms_talent_requirements (org_id, designation_id, lower(btrim(skill_key)));
CREATE UNIQUE INDEX IF NOT EXISTS hrms_talent_rating_org_emp_skill_uq ON public.hrms_talent_ratings (org_id, employee_id, lower(btrim(skill_key)));
CREATE INDEX        IF NOT EXISTS hrms_talent_roles_org_idx       ON public.hrms_talent_roles (org_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_talent_succ_org_role_emp_uq ON public.hrms_talent_successors (org_id, role_id, employee_id);
CREATE INDEX        IF NOT EXISTS hrms_talent_succ_role_idx       ON public.hrms_talent_successors (role_id);
CREATE INDEX        IF NOT EXISTS hrms_talent_change_role_idx     ON public.hrms_talent_succession_changes (role_id, on_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_talent_place_org_emp_uq    ON public.hrms_talent_placements (org_id, employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_talent_settings_org_key_uq ON public.hrms_talent_settings (org_id, lower(btrim(key)));
CREATE INDEX        IF NOT EXISTS hrms_talent_log_org_at_idx      ON public.hrms_talent_log (org_id, at DESC);

-- ── Row-level security: on, no policies; only the service role reaches these tables ──
ALTER TABLE public.hrms_talent_skills             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_requirements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_ratings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_roles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_successors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_succession_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_placements         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_talent_log                ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hrms_talent_skills', 'hrms_talent_requirements', 'hrms_talent_ratings', 'hrms_talent_roles', 'hrms_talent_successors',
    'hrms_talent_succession_changes', 'hrms_talent_placements', 'hrms_talent_settings', 'hrms_talent_log'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('GRANT ALL ON public.%I TO service_role', t); END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
