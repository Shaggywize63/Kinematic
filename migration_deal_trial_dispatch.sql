-- Spark & Ray product-trial dispatch details on crm_deals: the sample sent for a trial is couriered,
-- so the Product trial deal section needs its logistics — the airway bill / docket number, free-text
-- shipment details (carrier, what was sent, how) and the value of the sample shipped (INR).
-- Additive + idempotent. Applied at boot via exec_migration (PL/pgSQL EXECUTE) — so NO top-level
-- BEGIN/COMMIT. Gated to connected-B2B clients (Spark & Ray) in the API (DEAL_SECTION_KEYS), so a
-- tenant whose database has run this file but is not a B2B client is never written these columns.
-- After apply the runner issues: NOTIFY pgrst, 'reload schema';
ALTER TABLE public.crm_deals ADD COLUMN IF NOT EXISTS trial_awb      text;
ALTER TABLE public.crm_deals ADD COLUMN IF NOT EXISTS trial_shipment text;
ALTER TABLE public.crm_deals ADD COLUMN IF NOT EXISTS trial_value    numeric;

NOTIFY pgrst, 'reload schema';
