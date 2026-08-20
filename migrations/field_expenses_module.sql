-- Field Expense / Travel Claims module (module `field_expenses`)
--
-- Applied to BOTH Supabase projects (Kinematic clldjlojtmrrpozydqxk, Tata
-- lnvxqjqfsxvtjvbzphou) via apply_migration `field_expenses_module`.
--
-- Reps file expense/travel claims (multi-line: mileage, food, lodging, fuel,
-- toll, misc). Mileage can be auto-computed from the rep's GPS trail
-- (work_activity), receipts are AI-OCR'd, and claims route for approval up the
-- reporting hierarchy (users.supervisor_id), escalating to the next manager for
-- amounts above the policy threshold. Ships OFF by default.

-- Per org/client policy: mileage rate + approval thresholds + category caps.
CREATE TABLE IF NOT EXISTS public.expense_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  client_id          uuid,
  currency           text NOT NULL DEFAULT 'INR',
  mileage_rate       numeric(10,2) NOT NULL DEFAULT 12,     -- reimbursed per km
  auto_approve_under numeric(12,2) NOT NULL DEFAULT 0,       -- 0 = never auto-approve
  escalate_over      numeric(12,2),                          -- > this → also needs next manager up
  require_receipt_over numeric(12,2) NOT NULL DEFAULT 500,   -- receipt mandatory above this
  category_limits    jsonb,                                  -- { food: 500, lodging: 3000, ... } per-day caps
  is_active          boolean NOT NULL DEFAULT true,
  updated_by         uuid,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_policy_scope
  ON public.expense_policies (org_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS public.expense_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  user_id        uuid NOT NULL,                        -- the claimant
  claim_no       text,
  title          text,
  status         text NOT NULL DEFAULT 'draft',        -- draft|submitted|approved|rejected|reimbursed|cancelled
  currency       text NOT NULL DEFAULT 'INR',
  total_amount   numeric(12,2) NOT NULL DEFAULT 0,
  distance_km    numeric(10,2),                         -- claimed mileage distance
  gps_derived_km numeric(10,2),                         -- distance measured from the GPS trail
  approver_id    uuid,                                  -- current pending approver (up the hierarchy)
  current_level  integer NOT NULL DEFAULT 1,
  submitted_at   timestamptz,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  review_note    text,
  ai_summary     text,                                  -- one-line approver brief
  ai_flags       jsonb,                                 -- [{ code, severity, detail }]
  reimbursed_at  timestamptz,
  reimbursed_ref text,
  created_by     uuid,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_claims_user   ON public.expense_claims (org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_expense_claims_status ON public.expense_claims (org_id, status);
CREATE INDEX IF NOT EXISTS idx_expense_claims_approver ON public.expense_claims (approver_id, status);

CREATE TABLE IF NOT EXISTS public.expense_claim_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id       uuid NOT NULL,
  org_id         uuid NOT NULL,
  category       text NOT NULL,                         -- mileage|travel|food|lodging|fuel|toll|misc
  item_date      date,
  description    text,
  amount         numeric(12,2) NOT NULL DEFAULT 0,
  distance_km    numeric(10,2),                         -- for mileage items
  from_location  text,
  to_location    text,
  merchant       text,
  receipt_url    text,
  ai_extracted   jsonb,                                 -- raw OCR fields from the receipt scan
  flagged        boolean NOT NULL DEFAULT false,
  flag_reason    text,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_items_claim ON public.expense_claim_items (claim_id);

-- Multi-level approval trail (one row per hierarchy level the claim visits).
CREATE TABLE IF NOT EXISTS public.expense_approvals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id   uuid NOT NULL,
  org_id     uuid NOT NULL,
  level      integer NOT NULL,
  approver_id uuid,
  status     text NOT NULL DEFAULT 'pending',           -- pending|approved|rejected
  note       text,
  decided_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_approvals_claim ON public.expense_approvals (claim_id);
CREATE INDEX IF NOT EXISTS idx_expense_approvals_approver ON public.expense_approvals (approver_id, status);

-- FKs for PostgREST embedding.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_expense_item_claim') THEN
    ALTER TABLE public.expense_claim_items
      ADD CONSTRAINT fk_expense_item_claim FOREIGN KEY (claim_id) REFERENCES public.expense_claims(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_expense_approval_claim') THEN
    ALTER TABLE public.expense_approvals
      ADD CONSTRAINT fk_expense_approval_claim FOREIGN KEY (claim_id) REFERENCES public.expense_claims(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE public.expense_policies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_claims       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_claim_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_approvals    ENABLE ROW LEVEL SECURITY;

INSERT INTO public.modules (id, name, description, package, is_universal) VALUES
  ('field_expenses', 'Field Expenses', 'Field expense & travel claims with auto-mileage and hierarchy approvals', 'field_force', false)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, package=EXCLUDED.package, is_universal=EXCLUDED.is_universal;
