-- Free-text "Make" on a CRM product (Spark & Ray).
--
-- The product's make was previously a link to the Makes master list (crm_products.make_id → crm_makes).
-- It is now a plain typed string on the product, so a rep types the manufacturer directly and there is no
-- separate Makes settings list to maintain. This adds the text column; the old make_id column is left in place
-- (existing links keep resolving, and nothing is dropped).
--
-- Additive and idempotent.
ALTER TABLE public.crm_products ADD COLUMN IF NOT EXISTS make text;

-- PostgREST caches the schema; tell it to reload so the new column is visible to the API at once.
NOTIFY pgrst, 'reload schema';
