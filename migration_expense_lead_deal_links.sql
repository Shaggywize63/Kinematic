-- Expense ↔ lead / deal links (connected-B2B flow). Additive + idempotent.
--
--   * expense_claims.lead_id — the CRM lead this expense was spent on.
--   * expense_claims.deal_id — the CRM deal this expense was spent on (a deal's
--                              claims also carry its lead_id; the backend derives it).
--
-- They feed the per-lead / per-deal cost roll-up (total spend, visits and spend
-- as a % of the opportunity value) served by GET /api/v1/crm/leads/:id/expenses
-- and /deals/:id/expenses.
--
-- No new tables, so the existing RLS / tenant grants on expense_claims already
-- cover these columns. The backend writes them ONLY for connected-B2B clients
-- and reads via select('*'), and a write that fails because the columns are
-- missing is retried without them, so a tenant that has not run this migration
-- is unaffected (the roll-up then answers zeros). Apply to the Kinematic tenant
-- database (Spark & Ray lives under it).

BEGIN;

ALTER TABLE public.expense_claims ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.crm_leads(id);
ALTER TABLE public.expense_claims ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES public.crm_deals(id);

CREATE INDEX IF NOT EXISTS idx_expense_claims_lead ON public.expense_claims (lead_id);
CREATE INDEX IF NOT EXISTS idx_expense_claims_deal ON public.expense_claims (deal_id);

COMMIT;
