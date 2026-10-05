-- Finance: per-line billing duration (month / quarter / 6 months / year).
-- Rate is per month; amount = quantity × rate × duration_months. NULL = one-time line (×1).
-- Additive and idempotent. The app only writes this column when a duration is chosen, so
-- deploying the code before this migration is safe — only picking a duration needs it.
ALTER TABLE public.finance_document_items
  ADD COLUMN IF NOT EXISTS duration_months int;

DO $$ BEGIN
  ALTER TABLE public.finance_document_items
    ADD CONSTRAINT finance_document_items_duration_chk CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 120);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- PostgREST on the self-hosted stack does not reload its schema cache after DDL.
NOTIFY pgrst, 'reload schema';
