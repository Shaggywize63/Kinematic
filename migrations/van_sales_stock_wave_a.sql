-- Van Sales / Distributor Management — Wave A
-- Distributor on-hand stock movements + van load-in/load-out ledger.
--
-- Applied to BOTH Supabase projects (shared backend): Kinematic
-- (clldjlojtmrrpozydqxk) and Tata (lnvxqjqfsxvtjvbzphou) via apply_migration
-- `van_sales_stock_wave_a`. Recorded here for the repo.
--
-- Wires the previously-orphaned distribution_distributor_stock table (running
-- balance) with an immutable movement ledger, and adds a van-stock ledger so a
-- rep loads stock at day start, sells from the van, and reconciles physical
-- returns/damage at end-of-day. Two new modules ship OFF by default.

CREATE TABLE IF NOT EXISTS public.distribution_stock_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  distributor_id uuid NOT NULL,
  sku_id         uuid NOT NULL,
  delta          integer NOT NULL,                 -- +receipt / -issue
  reason         text NOT NULL,                     -- receipt|sale|return|damage|adjustment|van_load|van_return
  ref_type       text,                              -- order|return|van_load|manual
  ref_id         uuid,
  balance_after  integer,
  note           text,
  created_by     uuid,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dist_stock_mov_dist ON public.distribution_stock_movements (org_id, distributor_id);
CREATE INDEX IF NOT EXISTS idx_dist_stock_mov_sku  ON public.distribution_stock_movements (sku_id);

CREATE TABLE IF NOT EXISTS public.distribution_van_loads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  user_id        uuid NOT NULL,                     -- the van-sales rep
  distributor_id uuid,                              -- source distributor (van draws its stock)
  route_plan_id  uuid,                              -- the beat for the day
  load_date      date NOT NULL DEFAULT current_date,
  status         text NOT NULL DEFAULT 'open',       -- open|reconciled|closed
  opened_at      timestamptz DEFAULT now(),
  closed_at      timestamptz,
  notes          text,
  created_by     uuid,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_van_loads_org  ON public.distribution_van_loads (org_id);
CREATE INDEX IF NOT EXISTS idx_van_loads_user ON public.distribution_van_loads (user_id, load_date);

CREATE TABLE IF NOT EXISTS public.distribution_van_load_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  van_load_id  uuid NOT NULL,
  org_id       uuid NOT NULL,
  sku_id       uuid NOT NULL,
  loaded_qty   integer NOT NULL DEFAULT 0,
  sold_qty     integer NOT NULL DEFAULT 0,           -- computed = loaded - returned - damaged (at reconcile)
  returned_qty integer NOT NULL DEFAULT 0,
  damaged_qty  integer NOT NULL DEFAULT 0,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_van_load_items_load ON public.distribution_van_load_items (van_load_id);

-- RLS: deny-all to anon/authenticated; the Express backend uses service_role.
ALTER TABLE public.distribution_stock_movements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_van_loads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_van_load_items   ENABLE ROW LEVEL SECURITY;

-- Modules (OFF by default; registered but not auto-granted).
INSERT INTO public.modules (id, name, description, package, is_universal) VALUES
  ('distribution_stock', 'Distributor Stock', 'Distributor on-hand inventory & movement ledger', 'distribution', false),
  ('distribution_van',   'Van Sales',         'Van load-in / load-out stock & reconciliation',    'distribution', false)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, package=EXCLUDED.package, is_universal=EXCLUDED.is_universal;
