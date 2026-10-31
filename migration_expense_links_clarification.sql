-- Expense ↔ account/form links + a claim-level clarification (Spark & Ray
-- connected-B2B flow). Additive + idempotent.
--
--   * expense_claims.clarification — the mandatory purpose/justification a rep
--                                    gives for the claim (enforced at submit for
--                                    B2B clients only; optional column otherwise).
--   * expense_claims.account_id    — the CRM account this expense is against.
--   * expense_claims.form_id       — the builder form this expense is linked to
--                                    (its title is shown wherever the link appears).
--   * builder_forms.expense_linked — admin toggle in the Form Builder marking a
--                                    form as linkable to expenses (the expense
--                                    form-picker lists these).
--
-- No new tables, so the existing RLS / tenant grants on expense_claims and
-- builder_forms already cover these columns. Kinematic tenant only (Spark lives
-- under it); the backend writes the new expense columns ONLY for B2B clients and
-- reads via select('*'), so a tenant without this migration is unaffected.

BEGIN;

ALTER TABLE public.expense_claims ADD COLUMN IF NOT EXISTS clarification text;
ALTER TABLE public.expense_claims ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.crm_accounts(id);
ALTER TABLE public.expense_claims ADD COLUMN IF NOT EXISTS form_id    uuid REFERENCES public.builder_forms(id);

CREATE INDEX IF NOT EXISTS idx_expense_claims_account ON public.expense_claims (account_id);
CREATE INDEX IF NOT EXISTS idx_expense_claims_form    ON public.expense_claims (form_id);

ALTER TABLE public.builder_forms ADD COLUMN IF NOT EXISTS expense_linked boolean NOT NULL DEFAULT false;

COMMIT;
