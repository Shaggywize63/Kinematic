-- OAuth 2.0 Authorization Server tables.
--
-- These back the "Connect your Kinematic account" flow used by external
-- assistants (ChatGPT Apps, Claude connectors) via the MCP server. OAuth is a
-- GLOBAL concern, so these tables live ONLY in the default project's DB and are
-- always accessed with adminClientFor('default') — never the ALS-bound proxy.
-- Each code/token row carries `project_key` + `user_id` so token validation can
-- runWithProject(project_key) → buildUserContext(user_id) into the right tenant.
--
-- Tokens are OPAQUE: only SHA-256 hashes are stored, never the raw value.

BEGIN;

-- Registered OAuth clients (one row per integration: ChatGPT, Claude, …).
CREATE TABLE IF NOT EXISTS public.oauth_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text NOT NULL UNIQUE,
  -- SHA-256 hex of the client secret. NULL for public / PKCE-only clients.
  client_secret_hash  text,
  name                text NOT NULL,
  redirect_uris       text[] NOT NULL DEFAULT '{}',
  allowed_scopes      text[] NOT NULL DEFAULT '{}',
  is_confidential     boolean NOT NULL DEFAULT true,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Short-lived authorization codes (PKCE, single-use).
CREATE TABLE IF NOT EXISTS public.oauth_authorization_codes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             text NOT NULL UNIQUE,        -- SHA-256 of the code
  client_id             text NOT NULL,
  user_id               uuid NOT NULL,               -- public.users.id (Supabase auth id)
  project_key           text NOT NULL,               -- which Supabase project the user lives in
  org_id                uuid,
  redirect_uri          text NOT NULL,
  scopes                text[] NOT NULL DEFAULT '{}',
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Access + refresh tokens (opaque; only hashes stored).
CREATE TABLE IF NOT EXISTS public.oauth_access_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash   text NOT NULL UNIQUE,
  refresh_token_hash  text UNIQUE,
  client_id           text NOT NULL,
  user_id             uuid NOT NULL,
  project_key         text NOT NULL,
  org_id              uuid,
  scopes              text[] NOT NULL DEFAULT '{}',
  access_expires_at   timestamptz NOT NULL,
  refresh_expires_at  timestamptz,
  revoked_at          timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Audit trail of assistant-driven actions (writes go through the MCP server).
CREATE TABLE IF NOT EXISTS public.oauth_action_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text,
  user_id       uuid,
  project_key   text,
  org_id        uuid,
  tool          text NOT NULL,               -- MCP tool name, e.g. update_lead
  scopes        text[] NOT NULL DEFAULT '{}',
  target_type   text,                        -- lead | deal | activity | …
  target_id     text,
  request       jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome       text NOT NULL DEFAULT 'ok',  -- ok | denied | error
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_idx     ON public.oauth_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_client_idx   ON public.oauth_access_tokens(client_id);
CREATE INDEX IF NOT EXISTS oauth_auth_codes_expiry_idx      ON public.oauth_authorization_codes(expires_at);
CREATE INDEX IF NOT EXISTS oauth_action_audit_user_idx      ON public.oauth_action_audit(user_id, created_at DESC);

-- Service-role only (the backend uses the service key, which bypasses RLS).
-- RLS enabled as defense-in-depth: no anon/authenticated policy is granted, so
-- these tables are unreadable except via the service role.
ALTER TABLE public.oauth_clients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_access_tokens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_action_audit        ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='oauth_clients' AND policyname='oauth_clients_service') THEN
    CREATE POLICY oauth_clients_service ON public.oauth_clients FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='oauth_authorization_codes' AND policyname='oauth_codes_service') THEN
    CREATE POLICY oauth_codes_service ON public.oauth_authorization_codes FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='oauth_access_tokens' AND policyname='oauth_tokens_service') THEN
    CREATE POLICY oauth_tokens_service ON public.oauth_access_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='oauth_action_audit' AND policyname='oauth_audit_service') THEN
    CREATE POLICY oauth_audit_service ON public.oauth_action_audit FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
