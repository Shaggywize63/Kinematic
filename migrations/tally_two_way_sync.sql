-- ============================================================================
-- Tally two-way sync: distributor edit push + order/voucher status fetch-back
-- ============================================================================
-- Additive + idempotent.
--  1. Allow the 'master_ledger_update' event kind (re-push a dealer ledger as
--     ACTION="Alter" when an already-synced distributor is edited).
--  2. distributors.tally_synced_at — loop guard so a change that arrived FROM
--     Tally (import) is not immediately pushed back up as an "edit".
--  3. events.tally_status / tally_checked_at — the status fetched back from Tally
--     for a pushed voucher (present | cancelled) and when it was last checked.
--  4. orders.tally_status / tally_voucher_no / tally_checked_at — the same,
--     surfaced on the order so the dashboard/app can show its Tally state.
-- ============================================================================

-- 1. Widen the event-kind CHECK (keep every existing kind valid).
ALTER TABLE public.distribution_integration_events
  DROP CONSTRAINT IF EXISTS distribution_integration_events_kind_check;
ALTER TABLE public.distribution_integration_events
  ADD CONSTRAINT distribution_integration_events_kind_check
  CHECK (kind = ANY (ARRAY[
    'invoice','payment','return','credit_note','order',
    'master_ledger','master_ledger_update','master_stock_item'
  ]::text[]));

-- 2. Loop guard on distributors.
ALTER TABLE public.distributors
  ADD COLUMN IF NOT EXISTS tally_synced_at timestamptz NULL;
COMMENT ON COLUMN public.distributors.tally_synced_at IS
  'Last time this dealer''s ledger was pushed to / imported from Tally; the enqueue poller only re-pushes an edit when updated_at > tally_synced_at.';

-- 3. Fetched Tally status on the push event.
ALTER TABLE public.distribution_integration_events
  ADD COLUMN IF NOT EXISTS tally_status text NULL;
ALTER TABLE public.distribution_integration_events
  ADD COLUMN IF NOT EXISTS tally_checked_at timestamptz NULL;

-- 4. Fetched Tally status surfaced on the order.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tally_status text NULL;
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tally_voucher_no text NULL;
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tally_checked_at timestamptz NULL;
COMMENT ON COLUMN public.orders.tally_status IS
  'Status of this order''s voucher as last fetched back from Tally: present | cancelled.';

-- PostgREST caches the schema; reload so the new columns are exposed immediately.
NOTIFY pgrst, 'reload schema';
