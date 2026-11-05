-- AI-assistant (MCP connector) entitlement table.
--
-- Source of truth for which organisations may connect Claude / ChatGPT to their
-- CRM (a paid add-on). Read by src/lib/oauth/mcpEntitlement.ts (the OAuth
-- authorize gate + the MCP tool layer) and managed from the dashboard
-- "AI Assistant Access" page via src/controllers/mcpConnector.controller.ts.
--
-- Like the oauth_* tables, this is a GLOBAL concern and lives ONLY in the
-- default project's DB — always accessed with adminClientFor('default'), never
-- the ALS-bound proxy. The lookup is by org_id alone, so it is project-agnostic;
-- `project_key` is informational (which Supabase project the org's users live in).
--
-- Idempotent + additive: safe to re-run. After applying, reload PostgREST's
-- schema cache with:  NOTIFY pgrst, 'reload schema';  (also issued at the end).

BEGIN;

CREATE TABLE IF NOT EXISTS public.mcp_connector_orgs (
  org_id       uuid PRIMARY KEY,
  project_key  text,
  label        text,
  enabled      boolean NOT NULL DEFAULT false,
  updated_by   uuid,            -- super-admin who last toggled it (no FK: cross-project)
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_connector_orgs_enabled_idx ON public.mcp_connector_orgs(enabled);

-- Service-role only (the backend uses the service key, which bypasses RLS).
-- RLS enabled as defense-in-depth: no anon/authenticated policy is granted.
ALTER TABLE public.mcp_connector_orgs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mcp_connector_orgs'
      AND policyname = 'mcp_connector_orgs_service'
  ) THEN
    CREATE POLICY mcp_connector_orgs_service ON public.mcp_connector_orgs
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Seed the Kinematic parent org ON (matches the KINEMATIC_PARENT_ORG_ID safety
-- fallback in mcpEntitlement.ts). DO NOTHING so a later explicit toggle is kept.
INSERT INTO public.mcp_connector_orgs (org_id, project_key, label, enabled)
VALUES ('11111111-1111-4111-8111-111111111111', 'kinematic', 'Kinematic (parent)', true)
ON CONFLICT (org_id) DO NOTHING;

COMMIT;

-- PostgREST caches the schema; make the new table visible to the REST API.
NOTIFY pgrst, 'reload schema';
