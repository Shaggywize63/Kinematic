-- Distribution: daily closing stock + employee-wise collection targets.
--
-- Shared backend; the coordinator applies this to the KINEMATIC Supabase project only (Gomant lives there),
-- NEVER Tata. Both tables are additive and opt-in BY DATA: a client with no rows behaves exactly as today.
-- Access reuses existing modules — closing stock is gated on `distribution_stock`, collection targets on
-- `reports` + admin — so no new module has to be registered or granted (Gomant already has both).
--
-- CLOSING STOCK: one physical count per (distributor, SKU, day). `system_qty` snapshots
-- distribution_distributor_stock.qty at the moment the count is saved; `variance = physical_qty - system_qty`.
-- On admin approval of a non-zero variance the backend posts a stock-movement adjustment (reason 'adjustment')
-- so the running balance matches the count, and records the movement id here. The report derives opening /
-- received / issued for a date range from distribution_stock_movements — this table only stores the count.
--
-- COLLECTION TARGETS: one monthly ₹ target per user (reps + supervisors). Actual collection is computed at
-- read time from payments (status cleared|pending, received_at in the month, salesman_id = the user), so no
-- actuals are duplicated here.

CREATE TABLE IF NOT EXISTS public.distribution_closing_stock (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL,
  client_id               uuid,
  distributor_id          uuid NOT NULL,
  sku_id                  uuid NOT NULL,
  stock_date              date NOT NULL,
  system_qty              integer NOT NULL DEFAULT 0,   -- snapshot of on-hand when the count was saved
  physical_qty            integer NOT NULL DEFAULT 0,   -- the counted quantity
  variance                integer NOT NULL DEFAULT 0,   -- physical_qty - system_qty (stored for reporting)
  status                  text NOT NULL DEFAULT 'recorded',  -- recorded | approved | adjusted
  note                    text,
  counted_by              uuid,
  approved_by             uuid,
  approved_at             timestamptz,
  adjustment_movement_id  uuid,                         -- the distribution_stock_movements row posted on approval
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, distributor_id, sku_id, stock_date)
);
CREATE INDEX IF NOT EXISTS idx_closing_stock_day  ON public.distribution_closing_stock (org_id, distributor_id, stock_date);
CREATE INDEX IF NOT EXISTS idx_closing_stock_sku  ON public.distribution_closing_stock (sku_id);

CREATE TABLE IF NOT EXISTS public.distribution_collection_targets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  user_id        uuid NOT NULL,
  period_month   date NOT NULL,                          -- first day of the month, e.g. 2026-10-01
  target_amount  numeric(14,2) NOT NULL DEFAULT 0,
  note           text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_collection_targets_month ON public.distribution_collection_targets (org_id, period_month);

-- RLS: deny-all to anon/authenticated; the Express backend uses the service role.
ALTER TABLE public.distribution_closing_stock      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_collection_targets ENABLE ROW LEVEL SECURITY;

-- PostgREST must see the new tables immediately.
NOTIFY pgrst, 'reload schema';
