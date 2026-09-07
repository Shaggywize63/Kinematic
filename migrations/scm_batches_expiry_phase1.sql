-- ============================================================================
-- SCM Phase 1 — Batch/lot layers, expiry, and FIFO/FEFO rotation.
--
-- Adds batch-level stock tracking to the DISTRIBUTOR ledger
-- (distribution_distributor_stock), plus expiry/shelf-life fields on SKUs and
-- lifecycle/expiry fields on assets, and registers two new deny-by-default
-- distribution sub-modules.
--
-- Batch tracking is OPT-IN per SKU (skus.track_batches): when off, the existing
-- flat-balance behaviour is unchanged. When on, receipts create dated/costed
-- layers and consumption draws them down FEFO (soonest expiry first, FIFO
-- fallback), keeping distribution_distributor_stock.qty in sync as the total.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT) so it can be applied to any project
-- (Kinematic + Tata) safely and re-run.
-- ============================================================================

-- 1) Batch / lot layers on the distributor ledger ----------------------------
CREATE TABLE IF NOT EXISTS public.distribution_stock_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  distributor_id uuid NOT NULL,
  sku_id         uuid NOT NULL,
  batch_no       text,
  mfg_date       date,
  expiry_date    date,
  received_at    timestamptz NOT NULL DEFAULT now(),
  qty_received   numeric NOT NULL DEFAULT 0,
  qty_remaining  numeric NOT NULL DEFAULT 0,
  unit_cost      numeric,               -- cost layer for FIFO/FEFO valuation
  reference      text,                  -- GRN / PO reference
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Fast on-hand lookup and rotation ordering. The FEFO index is partial on
-- open layers (qty_remaining > 0) and ordered by expiry then receipt, which is
-- exactly the draw-down order.
CREATE INDEX IF NOT EXISTS idx_dsb_lookup
  ON public.distribution_stock_batches (org_id, distributor_id, sku_id);
CREATE INDEX IF NOT EXISTS idx_dsb_fefo
  ON public.distribution_stock_batches (org_id, distributor_id, sku_id, expiry_date, received_at)
  WHERE qty_remaining > 0;
CREATE INDEX IF NOT EXISTS idx_dsb_expiry
  ON public.distribution_stock_batches (org_id, expiry_date)
  WHERE qty_remaining > 0;

-- 2) Link each movement to the batch it drew from (traceability) -------------
ALTER TABLE public.distribution_stock_movements
  ADD COLUMN IF NOT EXISTS batch_id uuid;

-- 3) SKU shelf-life / batch flags --------------------------------------------
ALTER TABLE public.skus ADD COLUMN IF NOT EXISTS shelf_life_days   integer;
ALTER TABLE public.skus ADD COLUMN IF NOT EXISTS is_perishable     boolean NOT NULL DEFAULT false;
ALTER TABLE public.skus ADD COLUMN IF NOT EXISTS track_batches     boolean NOT NULL DEFAULT false;
ALTER TABLE public.skus ADD COLUMN IF NOT EXISTS expiry_alert_days integer;   -- near-expiry threshold override

-- 4) Asset lifecycle / expiry -------------------------------------------------
-- Assets today are a merchandising catalog (standees/POSM). These support both
-- durable-asset warranty/service dates AND a shelf-life expiry for consumable
-- assets, admin's choice per asset.
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS purchase_date   date;
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS warranty_expiry date;
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS service_due_at  date;
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS expiry_date     date;
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS is_perishable   boolean NOT NULL DEFAULT false;

-- 5) Register the two new deny-by-default distribution sub-modules ------------
INSERT INTO public.modules (id, name, description, package, is_universal) VALUES
  ('distribution_receiving', 'Goods Receiving (GRN)',
   'Receive stock into a distributor as dated, costed batches — creates the FIFO/FEFO layers.',
   'distribution', false),
  ('distribution_batches', 'Batch & Expiry',
   'Batch/lot on-hand with expiry, near-expiry alerts, and FEFO/FIFO stock rotation & valuation.',
   'distribution', false)
ON CONFLICT (id) DO UPDATE SET
  name         = EXCLUDED.name,
  description  = EXCLUDED.description,
  package      = EXCLUDED.package,
  is_universal = EXCLUDED.is_universal;
