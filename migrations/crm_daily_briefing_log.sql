-- Dedup ledger for the daily AI briefing. The scheduler claims (user_id,
-- briefing_date) atomically before generating + pushing a rep's morning
-- briefing, so each rep gets at most one per day even across overlapping
-- ticks or multiple instances.
CREATE TABLE IF NOT EXISTS public.crm_daily_briefing_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  briefing_date date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_briefing
  ON public.crm_daily_briefing_log (user_id, briefing_date);
