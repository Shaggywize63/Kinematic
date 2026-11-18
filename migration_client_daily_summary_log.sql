-- Dedup ledger for the 7 pm WhatsApp manager summary (services/clientDailySummary.service.ts).
-- The sender claims (org_id, summary_date) before sending, so each client gets at most one summary per IST day even
-- across overlapping ticks or several backend instances. Additive and idempotent. Kinematic project only.
CREATE TABLE IF NOT EXISTS public.client_daily_summary_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  summary_date date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_daily_summary
  ON public.client_daily_summary_log (org_id, summary_date);
ALTER TABLE public.client_daily_summary_log ENABLE ROW LEVEL SECURITY;  -- deny-by-default; service-role bypasses
NOTIFY pgrst, 'reload schema';
