-- Finance module — recurring invoices + "next invoice date" reminder.
--
-- Adds a per-invoice recurrence schedule to finance_documents so an invoice can
-- repeat on a fixed cadence. The NEXT invoice date is DERIVED from a start date
-- ("from date") + a duration (never typed in by hand), and a daily cron reminds
-- the finance admin — in-app bell + push + email — when that date arrives, so
-- they can raise the next invoice. Remind-only: nothing is auto-created.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test).
-- NOT applied to the Tata database (`tata`) — the finance_* tables live only in
-- Kinematic, and the reminder scan self-gates (missing table → silent no-op).
--
-- All columns are additive with safe defaults, so the running backend (which
-- does not yet reference them) is unaffected until the new code deploys.

ALTER TABLE public.finance_documents
  ADD COLUMN IF NOT EXISTS recurrence_enabled        boolean     NOT NULL DEFAULT false,
  -- weekly | monthly | quarterly | half_yearly | yearly | custom  (NULL when disabled)
  ADD COLUMN IF NOT EXISTS recurrence_interval       text,
  -- 'custom' only: repeat every N units …
  ADD COLUMN IF NOT EXISTS recurrence_custom_every   int,
  -- … of this unit: 'day' | 'month'
  ADD COLUMN IF NOT EXISTS recurrence_custom_unit    text,
  -- the "from date": the cycle anchor the next date is computed off (usually the issue date)
  ADD COLUMN IF NOT EXISTS recurrence_start          date,
  -- DERIVED (start + one duration, then rolled forward each cycle). The reminder fires on this date.
  ADD COLUMN IF NOT EXISTS next_invoice_date         date,
  -- also email the finance admin (in-app bell + push always happen when enabled)
  ADD COLUMN IF NOT EXISTS recurrence_reminder_email boolean     NOT NULL DEFAULT true,
  -- when the most recent reminder fired (audit + a guard against re-reminding the same cycle)
  ADD COLUMN IF NOT EXISTS recurrence_reminded_at    timestamptz;

-- Value guards (idempotent — skip if already present).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_documents_recurrence_interval_chk') THEN
    ALTER TABLE public.finance_documents
      ADD CONSTRAINT finance_documents_recurrence_interval_chk
      CHECK (recurrence_interval IS NULL OR recurrence_interval IN
        ('weekly','monthly','quarterly','half_yearly','yearly','custom'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_documents_recurrence_unit_chk') THEN
    ALTER TABLE public.finance_documents
      ADD CONSTRAINT finance_documents_recurrence_unit_chk
      CHECK (recurrence_custom_unit IS NULL OR recurrence_custom_unit IN ('day','month'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_documents_recurrence_every_chk') THEN
    ALTER TABLE public.finance_documents
      ADD CONSTRAINT finance_documents_recurrence_every_chk
      CHECK (recurrence_custom_every IS NULL OR (recurrence_custom_every >= 1 AND recurrence_custom_every <= 366));
  END IF;
END $$;

-- The reminder cron scans only enabled, live, due invoices — keep it a cheap index-only range.
CREATE INDEX IF NOT EXISTS finance_documents_recurring_due_idx
  ON public.finance_documents (next_invoice_date)
  WHERE recurrence_enabled AND deleted_at IS NULL AND doc_type = 'invoice';

-- Self-hosted PostgREST (ECS) keeps a schema cache; tell it about the new columns.
NOTIFY pgrst, 'reload schema';
