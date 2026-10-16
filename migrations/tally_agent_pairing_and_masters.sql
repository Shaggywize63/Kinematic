-- Tally connector: one-time pairing code, agent profile / health, command queue,
-- and a staging table for masters (stock items + parties) pulled from Tally.
-- Idempotent. Applies to the project the integration lives in (Kinematic by default).

ALTER TABLE public.distribution_integrations
  ADD COLUMN IF NOT EXISTS pairing_code_hash         text,
  ADD COLUMN IF NOT EXISTS pairing_expires_at        timestamptz,
  ADD COLUMN IF NOT EXISTS agent_version             text,
  ADD COLUMN IF NOT EXISTS tally_profile             jsonb,
  ADD COLUMN IF NOT EXISTS tally_profile_at          timestamptz,
  ADD COLUMN IF NOT EXISTS pending_commands          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_command_result       jsonb,
  ADD COLUMN IF NOT EXISTS master_sync_requested_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_master_sync_at       timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dist_integrations_pairing_hash
  ON public.distribution_integrations (pairing_code_hash) WHERE pairing_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.distribution_tally_masters (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL,
  integration_id  uuid        NOT NULL REFERENCES public.distribution_integrations(id) ON DELETE CASCADE,
  kind            text        NOT NULL CHECK (kind IN ('stock_item', 'party')),
  tally_guid      text        NOT NULL,
  name            text        NOT NULL,
  data            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'matched', 'imported', 'ignored')),
  matched_ref_id  uuid        NULL,            -- distributors.id | skus.id once matched/imported
  match_method    text        NULL,            -- gstin | name | manual | created
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, kind, tally_guid)
);
CREATE INDEX IF NOT EXISTS idx_tally_masters_lookup
  ON public.distribution_tally_masters (integration_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_tally_masters_ref
  ON public.distribution_tally_masters (integration_id, kind, matched_ref_id);

-- Service-role only (the API); no policies = no anon/authenticated access.
ALTER TABLE public.distribution_tally_masters ENABLE ROW LEVEL SECURITY;
