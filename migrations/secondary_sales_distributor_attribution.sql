-- Van Sales / Distributor Management — secondary-sales distributor attribution
--
-- The period-captured `secondary_sales` table records sell-out per outlet+SKU
-- but had no distributor attribution, so it could not roll up by distributor
-- (reconciliation already attributes secondary via orders.distributor_id; this
-- closes the gap for the period-import path). Add a nullable distributor_id,
-- an FK for embedding, and an index. Attribution on write + a one-time backfill
-- derive the distributor from the outlet's most recent servicing order.
--
-- Applied to BOTH projects (Kinematic clldjlojtmrrpozydqxk, Tata
-- lnvxqjqfsxvtjvbzphou) via apply_migration `secondary_sales_distributor_attribution`.

ALTER TABLE public.secondary_sales ADD COLUMN IF NOT EXISTS distributor_id uuid;

CREATE INDEX IF NOT EXISTS idx_secondary_sales_distributor
  ON public.secondary_sales (org_id, distributor_id);

-- Backfill: attribute each existing row to the distributor that most recently
-- fulfilled an order for that outlet (same org). Outlets with no order history
-- stay null.
UPDATE public.secondary_sales ss
SET distributor_id = sub.distributor_id
FROM (
  SELECT DISTINCT ON (o.org_id, o.outlet_id) o.org_id, o.outlet_id, o.distributor_id
  FROM public.orders o
  WHERE o.outlet_id IS NOT NULL AND o.distributor_id IS NOT NULL
  ORDER BY o.org_id, o.outlet_id, o.placed_at DESC
) sub
WHERE ss.distributor_id IS NULL
  AND ss.org_id = sub.org_id
  AND ss.outlet_id = sub.outlet_id;

-- FK for PostgREST embedding (distributors:distributor_id(name)). Guarded so the
-- migration is idempotent; only added if no orphan rows remain after backfill.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_secondary_sales_distributor')
     AND NOT EXISTS (
       SELECT 1 FROM public.secondary_sales ss
       WHERE ss.distributor_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.distributors d WHERE d.id = ss.distributor_id)
     ) THEN
    ALTER TABLE public.secondary_sales
      ADD CONSTRAINT fk_secondary_sales_distributor FOREIGN KEY (distributor_id) REFERENCES public.distributors(id);
  END IF;
END $$;
