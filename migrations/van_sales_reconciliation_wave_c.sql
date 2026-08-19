-- Van Sales / Distributor Management — Wave C
-- Primary↔Secondary reconciliation module registration.
--
-- Applied to BOTH Supabase projects (Kinematic clldjlojtmrrpozydqxk, Tata
-- lnvxqjqfsxvtjvbzphou) via apply_migration `van_sales_reconciliation_wave_c`.
--
-- No new tables: reconciliation is computed on the fly from invoices (primary
-- sell-in), orders (secondary sell-out) and distribution_distributor_stock
-- (on-hand). This migration only registers the gating module (OFF by default).
--
-- The on-hand-aware auto-replenishment upgrade in the same wave is a pure code
-- change to the shared replenishment service (no schema).

INSERT INTO public.modules (id, name, description, package, is_universal) VALUES
  ('distribution_reconciliation', 'Reconciliation', 'Primary vs secondary sell-in/sell-out reconciliation', 'distribution', false)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, package=EXCLUDED.package, is_universal=EXCLUDED.is_universal;
