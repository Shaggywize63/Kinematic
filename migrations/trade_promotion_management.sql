-- Trade Promotion Management (module `distribution_promotions`)
--
-- Wave 2 of the order-management program. A trade promotion is a budgeted
-- trade-spend program (price-off, free goods, display, slotting, volume rebate,
-- visibility) run over a period against a customer/channel/SKU/distributor
-- scope, optionally linked to a scheme (the offer mechanic reps see). Distributors
-- file CLAIMS against a promotion; claims are submitted → approved → settled
-- (or rejected). The summary endpoint rolls up budget vs claimed/approved/settled
-- spend and generated sales for a simple ROI.
--
-- Applied to BOTH Supabase projects (shared backend code): Kinematic
-- (clldjlojtmrrpozydqxk, default) and Tata (lnvxqjqfsxvtjvbzphou, prod) via
-- mcp apply_migration `trade_promotion_management`. Recorded here for the repo.
--
-- Ships OFF by default: gated by requireModule('distribution_promotions'); the
-- module is registered but NOT auto-granted, so no existing tenant sees it until
-- a master admin flips the grant at onboarding.

-- ── trade_promotions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  code            text NOT NULL,
  name            text NOT NULL,
  promo_type      text NOT NULL DEFAULT 'price_off',   -- price_off|free_goods|display|slotting|volume_rebate|visibility|other
  status          text NOT NULL DEFAULT 'draft',       -- draft|active|paused|closed
  funding_source  text NOT NULL DEFAULT 'brand',       -- brand|distributor|shared
  objective       text,
  budget_amount   numeric NOT NULL DEFAULT 0,
  currency        text DEFAULT 'INR',
  valid_from      date,
  valid_to        date,
  targeting       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {customer_classes[],regions[],sku_ids[],distributor_ids[]}
  linked_scheme_id uuid,                                -- optional scheme (offer mechanic) reuse
  notes           text,
  created_by      uuid,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trade_promotions_org ON public.trade_promotions (org_id);

-- ── tp_claims ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tp_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  promotion_id    uuid NOT NULL,
  distributor_id  uuid,
  claim_no        text,
  period_from     date,
  period_to       date,
  claimed_amount  numeric NOT NULL DEFAULT 0,
  approved_amount numeric,
  status          text NOT NULL DEFAULT 'submitted',    -- submitted|approved|rejected|settled
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{url,note}]
  notes           text,
  submitted_by    uuid,
  approved_by     uuid,
  approved_at     timestamptz,
  settled_amount  numeric,
  settled_at      timestamptz,
  payment_ref     text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tp_claims_org       ON public.tp_claims (org_id);
CREATE INDEX IF NOT EXISTS idx_tp_claims_promotion ON public.tp_claims (promotion_id);

-- ── RLS: deny-all to anon/authenticated; service_role (backend) bypasses ─────
ALTER TABLE public.trade_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tp_claims        ENABLE ROW LEVEL SECURITY;
-- No policies are created on purpose: every read/write goes through the Express
-- backend on the service_role key (which bypasses RLS), and org scoping is
-- enforced in the controller. Anon/authenticated get zero rows.

-- ── Module registration (OFF by default) ─────────────────────────────────────
INSERT INTO public.modules (id, name, description, package, is_universal)
VALUES ('distribution_promotions', 'Trade Promotions',
        'Trade promotion budgets, claims & ROI', 'distribution', false)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      package = EXCLUDED.package,
      is_universal = EXCLUDED.is_universal;
