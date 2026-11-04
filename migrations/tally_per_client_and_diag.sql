-- Tally: first-class per-client scoping + connector self-report diagnostics.
-- Additive + idempotent. Safe to run on every tenant DB (Kinematic + Tata/default).
--
--   client_id            promotes the legacy config.client_id JSON key to a real,
--                        indexable column so a Tally connection is first-class
--                        per-client (one connection per client, scoped like the
--                        rest of the system).
--   agent_last_error(_at) let the on-prem connector report *why* it failed (bad or
--                        expired pairing code, Tally unreachable, startup fault) so
--                        the dashboard shows the client's exact error without anyone
--                        touching the client's PC.

ALTER TABLE distribution_integrations ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE distribution_integrations ADD COLUMN IF NOT EXISTS agent_last_error text;
ALTER TABLE distribution_integrations ADD COLUMN IF NOT EXISTS agent_last_error_at timestamptz;

-- Backfill the new column from the legacy config.client_id (well-formed UUIDs only).
UPDATE distribution_integrations
   SET client_id = (config->>'client_id')::uuid
 WHERE client_id IS NULL
   AND config->>'client_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Lookup index for per-client scoping / dedupe checks.
CREATE INDEX IF NOT EXISTS idx_dint_org_client_provider
  ON distribution_integrations (org_id, client_id, provider);

NOTIFY pgrst, 'reload schema';
