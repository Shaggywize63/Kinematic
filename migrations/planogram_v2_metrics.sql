-- planogram_v2_metrics.sql
--
-- Enhanced planogram / shelf-audit module ("v2 metrics"): promotions, occupancy,
-- shelf-share, per-category and per-zone rollups, verbatim shelf-tag pricing, and
-- an auditable `methodology` object explaining how every headline number is
-- computed.
--
-- ALREADY APPLIED — this file is for the record only. The DDL below was applied
-- by hand to BOTH Supabase projects before this migration was committed:
--   • Kinematic (default dev/parent tenant):  clldjlojtmrrpozydqxk
--   • Tata Tiscon (production default tenant): lnvxqjqfsxvtjvbzphou
-- Every statement uses IF NOT EXISTS so re-running it is a no-op. Detection-level
-- fields (brand/category/price/zone/bbox_area/reasoning per SKU) ride inside the
-- existing detected_skus / expected_skus jsonb and need no DDL.

-- Recognition: top-level promotions / offer signage detected on the shelf image.
ALTER TABLE public.planogram_recognition
  ADD COLUMN IF NOT EXISTS promotions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Compliance: the new v2 metric columns.
ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS occupancy_score real;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS shelf_share_own real;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS shelf_share_competitor real;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS category_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS zone_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS pricing jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS promotions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.planogram_compliance
  ADD COLUMN IF NOT EXISTS methodology jsonb NOT NULL DEFAULT '{}'::jsonb;
