-- Website chatbot (KINI) — visitor conversation capture.
--
-- Stores every conversation the public website chatbot ("KINI") has with an
-- anonymous website visitor, plus the visitor details it manages to collect.
-- Once enough contact info is captured (a name + an email OR phone) the backend
-- creates a CRM lead from the session and stamps `lead_id` back onto the row,
-- so the sales team sees both the lead AND the full transcript that produced it.
--
-- The whole transcript lives in a single `transcript` jsonb array
-- (`[{ role: 'visitor'|'kini', content, ts }]`) — the conversation is small and
-- always read/written as a unit, so a child-message table would only add joins.
--
-- Applied to the Kinematic project (clldjlojtmrrpozydqxk). Additive only — no
-- existing table is touched, safe to apply with traffic running.
--
-- Apply via Supabase SQL editor or `supabase db push`.

BEGIN;

CREATE TABLE IF NOT EXISTS public.crm_web_chat_sessions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid        NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,

  -- Stable per-browser key generated client-side (localStorage). Upsert target.
  session_key       text        NOT NULL,

  status            text        NOT NULL DEFAULT 'active',   -- active | lead_captured | closed

  -- Visitor details KINI collects over the conversation.
  visitor_name      text,
  visitor_email     text,
  visitor_phone     text,
  visitor_company   text,
  team_size         text,
  interest          text,
  city              text,
  preferred_time    text,   -- demo/call: visitor's preferred day + time slot

  -- Where the conversation happened / how the visitor arrived.
  page_url          text,
  page_path         text,
  page_title        text,
  referrer_url      text,
  landing_page      text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,

  -- Full transcript: [{ role:'visitor'|'kini', content:text, ts:iso }].
  transcript        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  message_count     integer     NOT NULL DEFAULT 0,

  -- Set once a lead is created from this session.
  lead_id           uuid        REFERENCES public.crm_leads(id) ON DELETE SET NULL,
  lead_created_at   timestamptz,

  user_agent        text,
  meta              jsonb       NOT NULL DEFAULT '{}'::jsonb,

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crm_web_chat_sessions_org_session_key UNIQUE (org_id, session_key)
);

-- List view: most-recent-first per org.
CREATE INDEX IF NOT EXISTS crm_web_chat_sessions_org_last_seen_idx
  ON public.crm_web_chat_sessions (org_id, last_seen_at DESC);

-- Reverse lookup from a lead to its originating conversation.
CREATE INDEX IF NOT EXISTS crm_web_chat_sessions_lead_idx
  ON public.crm_web_chat_sessions (lead_id)
  WHERE lead_id IS NOT NULL;

-- Defense-in-depth: enable RLS. The backend uses the service_role key
-- (bypasses RLS) for all access, and this table is only written by the public
-- keyed webhook + read by authenticated dashboard routes — both server-side —
-- so there is no anon-key surface. Mirrors security_enable_rls_on_core_tables.
ALTER TABLE public.crm_web_chat_sessions ENABLE ROW LEVEL SECURITY;

-- Helper (idempotent — matches security_enable_rls_on_core_tables.sql). Ensures
-- the org-read policy below can be created even if that migration hasn't run.
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id', '')::uuid;
$fn$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'crm_web_chat_sessions'
      AND policyname = 'crm_web_chat_sessions_service_all'
  ) THEN
    CREATE POLICY crm_web_chat_sessions_service_all
      ON public.crm_web_chat_sessions
      FOR ALL TO service_role
      USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'crm_web_chat_sessions'
      AND policyname = 'crm_web_chat_sessions_org_read'
  ) THEN
    CREATE POLICY crm_web_chat_sessions_org_read
      ON public.crm_web_chat_sessions
      FOR SELECT TO authenticated
      USING (org_id = public.current_org_id());
  END IF;
END $$;

COMMIT;
