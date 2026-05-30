-- =============================================================================
-- Messaging, @mentions, and Web Push subscriptions — initial schema
-- =============================================================================
-- Ships the storage layer for four paired surfaces:
--
--   1. Direct messages + team chat — message_threads is the conversation,
--      message_thread_members is the access-control list (and tracks
--      per-user last_read_at for unread badges), messages stores the
--      actual content. Threads are scoped to org_id so RLS keeps tenants
--      isolated; super-admin reads bypass via the service-role key.
--
--   2. @mentions — generic mention table keyed by (source_kind, source_id)
--      so the same surface powers mentions on lead updates, activities,
--      and chat messages without separate tables per surface.
--
--   3. Web Push subscriptions — one row per browser per user, captures
--      the endpoint + p256dh + auth keys returned by the browser's Push
--      Manager so the backend can dispatch notifications via web-push.
--
--   4. Mobile push tokens — already live on users.fcm_token; no schema
--      change needed.
--
-- Scope-enforcement (city ∩ hierarchy subtree) is computed at the service
-- layer in src/services/crm/messaging.service.ts, not in SQL — it needs
-- the user_subtree_ids RPC + user_city_assignments join which is awkward
-- to express in a single RLS policy.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- message_threads — conversation container
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.message_threads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL,
  client_id       UUID        NULL,
  kind            TEXT        NOT NULL CHECK (kind IN ('dm', 'team')),
  name            TEXT        NULL,
  created_by      UUID        NOT NULL,
  last_message_at TIMESTAMPTZ NULL,
  last_message_preview TEXT   NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_message_threads_org_lastmsg
  ON public.message_threads(org_id, last_message_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- message_thread_members — ACL + per-user read state
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.message_thread_members (
  thread_id    UUID        NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_read_at TIMESTAMPTZ NULL,
  notify       BOOLEAN     NOT NULL DEFAULT TRUE,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_thread_members_user
  ON public.message_thread_members(user_id);

-- -----------------------------------------------------------------------------
-- messages — actual content
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   UUID        NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  org_id      UUID        NOT NULL,
  sender_id   UUID        NOT NULL,
  body        TEXT        NOT NULL,
  language    TEXT        NULL,  -- ISO 639-1 (en, hi, ta, te, …), best-effort
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ NULL,
  CONSTRAINT messages_body_not_empty CHECK (length(trim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread_created
  ON public.messages(thread_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_org_created
  ON public.messages(org_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- mentions — generic across lead updates, activities, and messages
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mentions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  source_kind      TEXT        NOT NULL CHECK (source_kind IN ('lead_update', 'activity', 'message')),
  source_id        UUID        NOT NULL,
  mentioner_id     UUID        NOT NULL,
  mentioned_user_id UUID       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at          TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_mentions_mentioned_unseen
  ON public.mentions(mentioned_user_id, created_at DESC)
  WHERE seen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mentions_source
  ON public.mentions(source_kind, source_id);

-- -----------------------------------------------------------------------------
-- web_push_subscriptions — one per browser-device per user
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.web_push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  org_id      UUID        NOT NULL,
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  user_agent  TEXT        NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_web_push_user
  ON public.web_push_subscriptions(user_id);

-- -----------------------------------------------------------------------------
-- RLS — service role bypasses; we don't expose these tables directly to
-- the FE supabase client, every read/write goes through Express handlers
-- that already enforce org + city + hierarchy scope.
-- -----------------------------------------------------------------------------
ALTER TABLE public.message_threads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Explicit deny for anon role — service role bypasses RLS automatically.
DROP POLICY IF EXISTS deny_anon ON public.message_threads;
CREATE POLICY deny_anon ON public.message_threads        FOR ALL TO anon USING (false);
DROP POLICY IF EXISTS deny_anon ON public.message_thread_members;
CREATE POLICY deny_anon ON public.message_thread_members FOR ALL TO anon USING (false);
DROP POLICY IF EXISTS deny_anon ON public.messages;
CREATE POLICY deny_anon ON public.messages               FOR ALL TO anon USING (false);
DROP POLICY IF EXISTS deny_anon ON public.mentions;
CREATE POLICY deny_anon ON public.mentions               FOR ALL TO anon USING (false);
DROP POLICY IF EXISTS deny_anon ON public.web_push_subscriptions;
CREATE POLICY deny_anon ON public.web_push_subscriptions FOR ALL TO anon USING (false);

COMMIT;
