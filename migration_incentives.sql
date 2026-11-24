-- Incentive management: a configurable per-client commission on sales orders.
--
-- Two tables, both additive and idempotent:
--   incentive_rules   — what a client pays: rate, basis, and which order status earns it.
--                       The rate is NOT hard-coded anywhere in the code; a client with no
--                       active rule accrues nothing, so enabling the module == creating a rule.
--   incentive_entries — one row per order (UNIQUE on order_id, so accrual is idempotent and
--                       a repeated approve can never double-pay). Reversed rather than deleted
--                       when an order is cancelled, so the history stays auditable.

CREATE TABLE IF NOT EXISTS public.incentive_rules (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  client_id   uuid,
  name        text        NOT NULL DEFAULT 'Sales incentive',
  rate_pct    numeric(6,3) NOT NULL DEFAULT 2,
  -- 'taxable_value' = net of GST and discounts (the usual commercial basis);
  -- 'grand_total'   = GST-inclusive.
  basis       text        NOT NULL DEFAULT 'taxable_value',
  -- Which point in placed -> approved -> invoiced earns the money.
  earn_on     text        NOT NULL DEFAULT 'approved',
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incentive_rules_basis_check   CHECK (basis   IN ('taxable_value','grand_total')),
  CONSTRAINT incentive_rules_earn_on_check CHECK (earn_on IN ('placed','approved','invoiced')),
  CONSTRAINT incentive_rules_rate_check    CHECK (rate_pct >= 0 AND rate_pct <= 100)
);

-- At most one ACTIVE rule per org + client, so accrual never has to pick between two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incentive_rules_active_scope
  ON public.incentive_rules (org_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;

CREATE TABLE IF NOT EXISTS public.incentive_entries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL,
  client_id       uuid,
  order_id        uuid        NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  salesman_id     uuid        NOT NULL,
  rule_id         uuid        REFERENCES public.incentive_rules(id),
  basis           text        NOT NULL,
  basis_amount    numeric(14,2) NOT NULL DEFAULT 0,
  rate_pct        numeric(6,3)  NOT NULL DEFAULT 0,
  amount          numeric(14,2) NOT NULL DEFAULT 0,
  -- earned  -> accrued and payable
  -- reversed-> the order was cancelled after it had earned
  -- paid    -> settled in payroll / by hand
  status          text        NOT NULL DEFAULT 'earned',
  earned_at       timestamptz NOT NULL DEFAULT now(),
  reversed_at     timestamptz,
  reversal_reason text,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incentive_entries_status_check CHECK (status IN ('earned','reversed','paid'))
);

-- One entry per order: makes accrual idempotent under retries and double-approves.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incentive_entries_order ON public.incentive_entries (order_id);
CREATE INDEX IF NOT EXISTS idx_incentive_entries_rep
  ON public.incentive_entries (org_id, salesman_id, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_incentive_entries_scope
  ON public.incentive_entries (org_id, client_id, status, earned_at DESC);

-- updated_at triggers, matching the CRM tables' pattern.
CREATE OR REPLACE FUNCTION public.incentives_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_incentive_rules_updated_at ON public.incentive_rules;
  CREATE TRIGGER trg_incentive_rules_updated_at BEFORE UPDATE ON public.incentive_rules
    FOR EACH ROW EXECUTE FUNCTION public.incentives_set_updated_at();
  DROP TRIGGER IF EXISTS trg_incentive_entries_updated_at ON public.incentive_entries;
  CREATE TRIGGER trg_incentive_entries_updated_at BEFORE UPDATE ON public.incentive_entries
    FOR EACH ROW EXECUTE FUNCTION public.incentives_set_updated_at();
END $$;
