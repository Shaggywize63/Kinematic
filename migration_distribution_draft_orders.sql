-- ============================================================================
-- Distribution AI — Draft orders (Replenishment agent · Approve → draft order)
-- ============================================================================
-- A draft order is a reviewable REPLENISHMENT PLAN for one distributor
-- (SKU + projected next-30d qty), authored by the replenishment agent when the
-- sales head approves a suggestion. It is deliberately price-free and does NOT
-- enter the outlet-centric orders/pricing/GST/scheme flow — so the live
-- `orders` ledger the velocity engine reads stays clean. Lifecycle:
--   open  →  dismissed              (head declines)
--   open  →  converted             (head places the real order in Orders)
-- Accessed only via the service-role backend; RLS on, no policies (deny-all).
-- Applied to both the Kinematic and Tata projects, matching distribution_agents.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.distribution_draft_orders (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL,
    distributor_id      uuid        NULL,
    distributor_name    text        NULL,
    source              text        NOT NULL DEFAULT 'replenishment_agent',
    status              text        NOT NULL DEFAULT 'open'
                                    CHECK (status IN ('open','dismissed','converted')),
    total_units         integer     NOT NULL DEFAULT 0,
    items               jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{sku_id,name,suggested_qty,last30,prior30,trendPct}]
    rationale           text        NULL,
    converted_order_id  uuid        NULL,
    created_by          uuid        NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dist_draft_orders_org_status
    ON public.distribution_draft_orders (org_id, status, created_at DESC);

ALTER TABLE public.distribution_draft_orders ENABLE ROW LEVEL SECURITY;
