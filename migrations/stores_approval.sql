-- Outlet approval. A field rep can add an outlet, but it only becomes usable (order / collection pickers)
-- once a manager approves it. Existing outlets default to 'approved', so nothing changes for them.
-- Additive and idempotent.
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS approval_status  text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS created_by       uuid,
  ADD COLUMN IF NOT EXISTS approved_by      uuid,
  ADD COLUMN IF NOT EXISTS approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_approval_status_check') THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_approval_status_check CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stores_approval_pending
  ON public.stores (org_id, approval_status) WHERE approval_status <> 'approved';
NOTIFY pgrst, 'reload schema';
