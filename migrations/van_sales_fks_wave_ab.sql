-- Van Sales / Distributor Management — FK backfill for Waves A & B
--
-- The Wave A/B tables were created without foreign keys, but the controllers
-- use PostgREST resource embedding (e.g. `skus:sku_id(name, sku_code)`,
-- `distributors:distributor_id(name)`, `items:distribution_van_load_items(...)`).
-- PostgREST can ONLY embed across a declared foreign key — without these, the
-- list/detail endpoints return PGRST200 "could not find a relationship".
--
-- Applied to BOTH projects (Kinematic clldjlojtmrrpozydqxk, Tata
-- lnvxqjqfsxvtjvbzphou) via apply_migration `van_sales_fks_wave_ab`. Idempotent.
-- Default (NO ACTION) delete semantics: a SKU/distributor that is referenced by
-- distribution stock/movements/damage/claims cannot be hard-deleted — correct
-- referential integrity for these records.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_dist_stock_sku') THEN
    ALTER TABLE public.distribution_distributor_stock
      ADD CONSTRAINT fk_dist_stock_sku FOREIGN KEY (sku_id) REFERENCES public.skus(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_dist_stock_distributor') THEN
    ALTER TABLE public.distribution_distributor_stock
      ADD CONSTRAINT fk_dist_stock_distributor FOREIGN KEY (distributor_id) REFERENCES public.distributors(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_stock_mov_sku') THEN
    ALTER TABLE public.distribution_stock_movements
      ADD CONSTRAINT fk_stock_mov_sku FOREIGN KEY (sku_id) REFERENCES public.skus(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_stock_mov_distributor') THEN
    ALTER TABLE public.distribution_stock_movements
      ADD CONSTRAINT fk_stock_mov_distributor FOREIGN KEY (distributor_id) REFERENCES public.distributors(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_van_item_load') THEN
    ALTER TABLE public.distribution_van_load_items
      ADD CONSTRAINT fk_van_item_load FOREIGN KEY (van_load_id) REFERENCES public.distribution_van_loads(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_van_item_sku') THEN
    ALTER TABLE public.distribution_van_load_items
      ADD CONSTRAINT fk_van_item_sku FOREIGN KEY (sku_id) REFERENCES public.skus(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_damage_sku') THEN
    ALTER TABLE public.distribution_damage_entries
      ADD CONSTRAINT fk_damage_sku FOREIGN KEY (sku_id) REFERENCES public.skus(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_damage_distributor') THEN
    ALTER TABLE public.distribution_damage_entries
      ADD CONSTRAINT fk_damage_distributor FOREIGN KEY (distributor_id) REFERENCES public.distributors(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_claims_distributor') THEN
    ALTER TABLE public.distribution_claims
      ADD CONSTRAINT fk_claims_distributor FOREIGN KEY (distributor_id) REFERENCES public.distributors(id);
  END IF;
END $$;
