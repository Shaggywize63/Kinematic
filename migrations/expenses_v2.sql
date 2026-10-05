-- Expenses v2 — multiple named policies, per-line approve/reject with remarks,
-- partial approval, resubmission rounds, and a private receipts bucket.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test).
-- NOT applied to the Tata database (`tata`) — only run there if explicitly asked.
-- The backend self-gates on a schema probe (expense_policies.rules), so a project
-- without this migration keeps the legacy single-policy behaviour unchanged.
--
-- Safe to apply to a live database: every change is additive. At the time of
-- writing the expense tables hold no rows (the module had never been used), so
-- dropping the single-policy unique index loses nothing.

-- ── Policies: many per org/client, each named and assignable ────────────────
ALTER TABLE public.expense_policies
  ADD COLUMN IF NOT EXISTS name           text,
  ADD COLUMN IF NOT EXISTS description    text,
  -- Lower number wins when two policies match a person equally specifically.
  ADD COLUMN IF NOT EXISTS priority       int   NOT NULL DEFAULT 100,
  -- { everyone: bool, roles: text[], org_role_ids: uuid[], user_ids: uuid[] }
  ADD COLUMN IF NOT EXISTS applies_to     jsonb NOT NULL DEFAULT '{"everyone": true}'::jsonb,
  -- Structured rules (mileage rate, receipt rule, per-category caps, enforcement,
  -- auto-approve / escalation thresholds). The legacy scalar columns stay as a
  -- mirror so older readers keep working.
  ADD COLUMN IF NOT EXISTS rules          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date,
  ADD COLUMN IF NOT EXISTS created_by     uuid,
  ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;

UPDATE public.expense_policies SET name = 'Default policy' WHERE name IS NULL;

-- The old design allowed exactly one policy per (org, client). Names are now the
-- uniqueness rule (case-insensitive, among live policies).
DROP INDEX IF EXISTS public.uq_expense_policy_scope;
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_policy_name
  ON public.expense_policies (org_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL AND name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expense_policies_scope
  ON public.expense_policies (org_id, client_id) WHERE deleted_at IS NULL;

-- ── Claims: which policy governed it, partial approval, resubmission ────────
ALTER TABLE public.expense_claims
  ADD COLUMN IF NOT EXISTS policy_id       uuid,
  ADD COLUMN IF NOT EXISTS policy_name     text,
  -- Frozen copy of the rules at submit time, so editing a policy later never
  -- rewrites the terms an old claim was judged against.
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb,
  -- Sum of the approved lines. NULL until decided; < total_amount when some
  -- lines were rejected (partial approval). Reimbursement pays this amount.
  ADD COLUMN IF NOT EXISTS approved_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS submit_count    int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_approved   boolean NOT NULL DEFAULT false;

-- A rejection must always carry a remark. NOT VALID: enforced on every new or
-- updated row without scanning history.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_claims_reject_remark_chk') THEN
    ALTER TABLE public.expense_claims
      ADD CONSTRAINT expense_claims_reject_remark_chk
      CHECK (status <> 'rejected' OR btrim(coalesce(review_note, '')) <> '') NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_expense_claims_submitted
  ON public.expense_claims (org_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_expense_claims_policy
  ON public.expense_claims (policy_id);

-- ── Lines: a decision (and the reason) per line ─────────────────────────────
ALTER TABLE public.expense_claim_items
  ADD COLUMN IF NOT EXISTS decision      text,
  ADD COLUMN IF NOT EXISTS decision_note text,
  ADD COLUMN IF NOT EXISTS decided_by    uuid,
  ADD COLUMN IF NOT EXISTS decided_at    timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_items_decision_chk') THEN
    ALTER TABLE public.expense_claim_items
      ADD CONSTRAINT expense_items_decision_chk
      CHECK (decision IS NULL OR decision IN ('approved', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_items_reject_remark_chk') THEN
    ALTER TABLE public.expense_claim_items
      ADD CONSTRAINT expense_items_reject_remark_chk
      CHECK (decision IS DISTINCT FROM 'rejected' OR btrim(coalesce(decision_note, '')) <> '') NOT VALID;
  END IF;
END $$;

-- ── Approval trail: group rows by resubmission round ────────────────────────
ALTER TABLE public.expense_approvals
  ADD COLUMN IF NOT EXISTS round int NOT NULL DEFAULT 1,
  -- Frozen record of what the approver decided on each line in this round:
  -- [{ item_id, category, amount, decision, note }]. Lives on the trail, so the
  -- remarks stay readable even after the claimant edits the lines and resubmits.
  ADD COLUMN IF NOT EXISTS item_decisions jsonb;

-- ── Private receipts bucket ─────────────────────────────────────────────────
-- Objects live at {org_id}/{user_id}/{uuid}.{ext}. Nothing is publicly readable:
-- GET /expenses/claims/:id signs a short-lived URL per receipt, and only for the
-- claim's owner, an approver in its chain, or an admin. The backend also creates
-- the bucket on first upload, so other projects need no manual step.
INSERT INTO storage.buckets (id, name, public)
VALUES ('kinematic-receipts', 'kinematic-receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Self-hosted PostgREST keeps a schema cache; tell it about the new columns.
NOTIFY pgrst, 'reload schema';
