-- Van Sales / Distributor Management — Wave B
-- Distributor-level damaged/expiry register + general claims & settlements.
--
-- Applied to BOTH Supabase projects (shared backend): Kinematic
-- (clldjlojtmrrpozydqxk) and Tata (lnvxqjqfsxvtjvbzphou) via apply_migration
-- `van_sales_claims_wave_b`. Recorded here for the repo.
--
-- Damage register: goods physically damaged / expired / near-expiry HELD at a
-- distributor (distinct from `returns`, which are sales returns against an
-- invoice). Confirming an entry decrements distributor on-hand via
-- applyStockDelta(reason 'damage') and can roll into a claim.
--
-- Claims: generalises the promotion-only `tp_claims` to ALL distributor claim
-- types (damage, expiry, scheme, price-protection, freight, shortage…), with an
-- inline settlement (credit-note / adjustment). Distributor-level, so it does
-- NOT post to the outlet-scoped `ledger_entries`; rollups come from this table.
-- Two new modules ship OFF by default.

CREATE TABLE IF NOT EXISTS public.distribution_damage_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  distributor_id uuid NOT NULL,
  sku_id         uuid NOT NULL,
  batch_no       text,
  expiry_date    date,
  qty            integer NOT NULL,
  unit_value     numeric(14,2),                     -- value per unit (claim basis)
  reason         text NOT NULL,                     -- damaged|expired|near_expiry|breakage|other
  status         text NOT NULL DEFAULT 'logged',    -- logged|confirmed|claimed|written_off|rejected
  evidence_urls  text[],
  note           text,
  stock_adjusted boolean NOT NULL DEFAULT false,    -- true once on-hand was decremented
  claim_id       uuid,                              -- set once rolled into a claim
  created_by     uuid,
  confirmed_by   uuid,
  confirmed_at   timestamptz,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dmg_dist   ON public.distribution_damage_entries (org_id, distributor_id);
CREATE INDEX IF NOT EXISTS idx_dmg_sku    ON public.distribution_damage_entries (sku_id);
CREATE INDEX IF NOT EXISTS idx_dmg_status ON public.distribution_damage_entries (status);
CREATE INDEX IF NOT EXISTS idx_dmg_claim  ON public.distribution_damage_entries (claim_id);

CREATE TABLE IF NOT EXISTS public.distribution_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  distributor_id  uuid NOT NULL,
  claim_no        text,
  claim_type      text NOT NULL,                    -- damage|expiry|scheme|promotion|price_protection|freight|shortage|other
  title           text,
  description     text,
  claimed_amount  numeric(14,2) NOT NULL DEFAULT 0,
  approved_amount numeric(14,2),
  currency        text NOT NULL DEFAULT 'INR',
  status          text NOT NULL DEFAULT 'submitted', -- submitted|under_review|approved|rejected|settled
  ref_type        text,                             -- damage|promotion|manual
  ref_ids         uuid[],                           -- linked damage entries / promo id
  evidence_urls   text[],
  period_start    date,
  period_end      date,
  -- inline settlement
  settled_amount  numeric(14,2),
  settlement_ref  text,
  settlement_mode text,                             -- credit_note|bank_transfer|adjustment|cheque
  settled_by      uuid,
  settled_at      timestamptz,
  -- review
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_notes    text,
  created_by      uuid,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claims_dist   ON public.distribution_claims (org_id, distributor_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON public.distribution_claims (status);
CREATE INDEX IF NOT EXISTS idx_claims_type   ON public.distribution_claims (claim_type);

-- RLS: deny-all to anon/authenticated; the Express backend uses service_role.
ALTER TABLE public.distribution_damage_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_claims         ENABLE ROW LEVEL SECURITY;

-- Modules (OFF by default; registered but not auto-granted).
INSERT INTO public.modules (id, name, description, package, is_universal) VALUES
  ('distribution_damage', 'Damaged / Expiry Register', 'Distributor damaged & expired stock register', 'distribution', false),
  ('distribution_claims', 'Claims & Settlements',      'Distributor claims (damage/scheme/price) & settlement', 'distribution', false)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, package=EXCLUDED.package, is_universal=EXCLUDED.is_universal;
