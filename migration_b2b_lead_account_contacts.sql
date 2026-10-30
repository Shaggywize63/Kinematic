-- B2B lead → account, and multiple contacts-with-requirements per lead
-- (Spark & Ray valve-survey flow). Additive + idempotent.
--
--   * crm_leads.account_id   — a B2B lead's company, resolved to a real CRM account
--                              (distinct from converted_account_id, which only the
--                              explicit convert flow sets).
--   * crm_contacts.lead_id   — provenance: which lead a contact was captured on, so a
--                              revisit can show "the people logged on this lead".
--   * crm_contacts.requirement — what this person at the customer asked for.
--
-- No new tables, so the existing RLS / tenant_isolation / grants on crm_leads and
-- crm_contacts already cover these columns.

BEGIN;

ALTER TABLE public.crm_leads    ADD COLUMN IF NOT EXISTS account_id  uuid REFERENCES public.crm_accounts(id);
ALTER TABLE public.crm_contacts ADD COLUMN IF NOT EXISTS lead_id     uuid REFERENCES public.crm_leads(id);
ALTER TABLE public.crm_contacts ADD COLUMN IF NOT EXISTS requirement text;

CREATE INDEX IF NOT EXISTS idx_crm_leads_account  ON public.crm_leads (account_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_lead  ON public.crm_contacts (lead_id);

COMMIT;
