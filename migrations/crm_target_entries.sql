-- Sales / Collection rupee targets: the amounts a rep logs in the app (agrisynx).
--
-- A rep records each order ("sales") or payment received ("collection") they closed, in rupees. A
-- target (crm_targets.metric = 'sales_amount' / 'collection_amount', period 'monthly') is measured
-- against the running monthly total of these entries. crm_targets itself is NOT changed.
--
-- Additive and idempotent: IF NOT EXISTS throughout, no existing table or row is touched. Until it has
-- run, the API degrades instead of failing: logging an entry answers 409 TARGET_ENTRIES_NOT_ENABLED,
-- progress reports achieved 0 and the entry history is empty.
--
-- Tenancy: every row carries org_id + client_id. All access goes through the backend (service role); RLS is
-- enabled with no policies, so anon / authenticated cannot read or write directly (same as the other
-- new CRM tables). The default privileges on this database already grant the API roles what they need.
--
-- Apply as the TABLE OWNER with psql (from a task inside the VPC), like expense_odometer.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f migrations/crm_target_entries.sql
-- (`npm run db:migrate` needs an exec_migration RPC the self-hosted projects do not have.)
-- Target: the Kinematic database (Agrisynx). Not needed on the Tata database.

CREATE TABLE IF NOT EXISTS public.crm_target_entries (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid          NOT NULL,
  client_id   uuid,
  user_id     uuid          NOT NULL,                      -- the rep the amount counts for
  kind        text          NOT NULL CHECK (kind IN ('sales', 'collection')),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),   -- rupees
  entry_date  date          NOT NULL,                      -- the IST calendar day it counts towards
  lead_id     uuid,                                        -- optional: the lead / dealer it was for
  note        text,
  created_by  uuid,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  deleted_at  timestamptz                                  -- soft delete: a deleted entry stops counting
);

-- The hot path: one person's entries of one kind over a date range (progress) and the board (all users).
CREATE INDEX IF NOT EXISTS idx_crm_target_entries_scope
  ON public.crm_target_entries (org_id, client_id, user_id, kind, entry_date);

ALTER TABLE public.crm_target_entries ENABLE ROW LEVEL SECURITY;

-- Make PostgREST pick up the new table straight away.
NOTIFY pgrst, 'reload schema';
