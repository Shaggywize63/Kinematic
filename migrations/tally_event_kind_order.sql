-- Allow Sales Orders to be queued for Tally. Widening only: every existing kind stays valid.
-- Idempotent (drop-if-exists then add).
ALTER TABLE public.distribution_integration_events
  DROP CONSTRAINT IF EXISTS distribution_integration_events_kind_check;
ALTER TABLE public.distribution_integration_events
  ADD CONSTRAINT distribution_integration_events_kind_check
  CHECK (kind = ANY (ARRAY['invoice','payment','return','credit_note','master_ledger','master_stock_item','order']::text[]));
