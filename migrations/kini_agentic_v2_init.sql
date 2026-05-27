-- =============================================================================
-- KINI Agentic v2 — Initial schema
-- =============================================================================
-- Provisions the persistent surfaces required for the agentic KINI v2 path:
--
--   * kini_threads      long-running conversation threads per user
--   * kini_messages     turns inside a thread (text, tool_calls, cards)
--   * kini_tool_calls   observability for every tool the model invokes
--   * kini_user_memory  stable facts the assistant remembers across sessions
--
-- All four tables are scoped by org_id (and client_id where applicable) so
-- they obey the platform's multi-tenant boundary. RLS is enabled with a
-- service_role bypass policy that matches the established style in
-- migrations/security_enable_rls_on_core_tables.sql.
--
-- This migration only provisions storage. The agentic v2 path is gated by
-- the `kini_agentic_v2` row in `org_settings` and is off by default; flipping
-- it on is a separate operation.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- kini_threads
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kini_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  user_id         uuid NOT NULL,
  title           text,
  last_message_at timestamptz,
  message_count   integer NOT NULL DEFAULT 0,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kini_threads_user
  ON public.kini_threads (user_id, last_message_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_kini_threads_org
  ON public.kini_threads (org_id, last_message_at DESC);

ALTER TABLE public.kini_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kini_threads_service_role ON public.kini_threads;
CREATE POLICY kini_threads_service_role ON public.kini_threads FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- kini_messages
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kini_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES public.kini_threads(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content     text,
  tool_calls  jsonb,
  cards       jsonb,
  tokens_in   integer,
  tokens_out  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kini_messages_thread
  ON public.kini_messages (thread_id, created_at);

ALTER TABLE public.kini_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kini_messages_service_role ON public.kini_messages;
CREATE POLICY kini_messages_service_role ON public.kini_messages FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- kini_tool_calls
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kini_tool_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  user_id       uuid,
  thread_id     uuid REFERENCES public.kini_threads(id) ON DELETE SET NULL,
  tool_name     text NOT NULL,
  args          jsonb,
  result_size   integer,
  success       boolean NOT NULL,
  error_code    text,
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kini_tool_calls_org_created
  ON public.kini_tool_calls (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kini_tool_calls_tool_created
  ON public.kini_tool_calls (tool_name, created_at DESC);

ALTER TABLE public.kini_tool_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kini_tool_calls_service_role ON public.kini_tool_calls;
CREATE POLICY kini_tool_calls_service_role ON public.kini_tool_calls FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- kini_user_memory
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kini_user_memory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  org_id      uuid NOT NULL,
  key         text NOT NULL,
  value       text NOT NULL,
  source      text NOT NULL DEFAULT 'kini',
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_kini_user_memory_user
  ON public.kini_user_memory (user_id, updated_at DESC);

ALTER TABLE public.kini_user_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kini_user_memory_service_role ON public.kini_user_memory;
CREATE POLICY kini_user_memory_service_role ON public.kini_user_memory FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMIT;

-- Verification (commented — run by hand after migrate):
--   SELECT count(*) FROM information_schema.tables WHERE table_name IN
--     ('kini_threads','kini_messages','kini_tool_calls','kini_user_memory');
--   -- expected: 4
