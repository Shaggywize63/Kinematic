-- Outlet approval. A field rep can add an outlet, but it only becomes usable (order / collection pickers)
-- once a manager approves it. Existing outlets default to 'approved', so nothing changes for them.
-- Additive and idempotent.
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS approval_status  text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS created_by       uuid,
  ADD COLUMN IF NOT EXISTS approved_by      uuid,
  ADD COLUMN IF NOT EXISTS approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  -- Channel: on-trade (consumed on premises: bars, restaurants) vs off-trade (retail shops). Separate from
  -- store_type, which is the free-text retail category (Kirana, Pan Shop, …).
  ADD COLUMN IF NOT EXISTS trade_type      text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_approval_status_check') THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_approval_status_check CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_trade_type_check') THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_trade_type_check CHECK (trade_type IS NULL OR trade_type IN ('on_trade', 'off_trade'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stores_approval_pending
  ON public.stores (org_id, approval_status) WHERE approval_status <> 'approved';
NOTIFY pgrst, 'reload schema';
