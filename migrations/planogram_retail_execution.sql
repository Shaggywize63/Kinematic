-- planogram_retail_execution.sql
--
-- Retail-execution suite additions to the planogram / shelf-audit module:
--   • Stock count from image  — estimated on-shelf units + availability rollup.
--   • POSM / merchandising     — expected-vs-found point-of-sale-material check.
-- Share-of-shelf, SKU detection, competitor price and planogram compliance were
-- already delivered by planogram_v2_metrics.sql; this migration only adds the
-- two genuinely-new capabilities. Everything ships under the existing
-- `planograms` module.
--
-- Applied to BOTH Supabase projects (every statement is IF NOT EXISTS, so a
-- re-run is a no-op):
--   • Kinematic (default dev/parent tenant):  clldjlojtmrrpozydqxk
--   • Tata Tiscon (production default tenant): lnvxqjqfsxvtjvbzphou
-- Per-detection stock fields (units_estimate / stock_status per SKU) ride inside
-- the existing planogram_recognition.detected_skus jsonb and need no DDL.

-- Planogram: the expected POSM / merchandising assets this planogram prescribes
-- (list of { id?, type, name, brand?, required? }). Empty/absent → POSM
-- compliance is treated as not-applicable for that planogram.
ALTER TABLE public.planograms
  ADD COLUMN IF NOT EXISTS expected_posm jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Recognition: POSM / merchandising assets detected in the shelf image
-- (distinct from `promotions`, which is offer/price signage).
ALTER TABLE public.planogram_recognition
  ADD COLUMN IF NOT EXISTS posm jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Compliance: stock-count rollup + POSM compliance, plus scalar mirrors for
-- cheap trend/aggregate queries.
ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS stock_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS posm jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS posm_score real;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS availability_rate real;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS oos_count integer;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS low_stock_count integer;
