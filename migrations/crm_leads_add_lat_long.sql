-- Adds geo coordinates to CRM leads.
--
-- Leads are captured with a city/state today, which the dashboard map
-- approximates to a city centroid. These columns let us store the lead's
-- exact position — captured on add via device GPS (or manual entry), or
-- backfilled for old leads via the bulk coordinate upload — so the map can
-- plot the real pin instead of a city-level guess.
--
-- Nullable: most existing rows have no coordinates, and the city-centroid
-- fallback still renders them.

ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS latitude  double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

COMMENT ON COLUMN public.crm_leads.latitude  IS 'Lead geo latitude (-90..90). Captured on add via device GPS / manual entry, or backfilled via bulk coordinate upload. Rendered on the CRM dashboard map.';
COMMENT ON COLUMN public.crm_leads.longitude IS 'Lead geo longitude (-180..180). See latitude.';
