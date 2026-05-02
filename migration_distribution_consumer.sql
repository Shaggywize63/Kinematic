-- ============================================================================
-- Distribution Module — Consumer step (M3)
-- ============================================================================
-- secondary_sales (off-take capture) closes the loop with the existing
-- planograms module to deliver step 5 (Consumer — on-shelf, in-hand).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.secondary_sales (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    client_id       uuid        NULL,
    outlet_id       uuid        NOT NULL,
    sku_id          uuid        NOT NULL,
    qty             int         NOT NULL CHECK (qty > 0),
    period_start    date        NOT NULL,
    period_end      date        NOT NULL,
    source          text        NOT NULL DEFAULT 'manual',     -- manual | estimated | qr
    evidence_url    text        NULL,
    captured_by     uuid        NULL,
    notes           text        NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, outlet_id, sku_id, period_start, period_end, source)
);
CREATE INDEX IF NOT EXISTS idx_secondary_sales_outlet  ON public.secondary_sales (outlet_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_secondary_sales_sku     ON public.secondary_sales (sku_id, period_start DESC);

COMMENT ON TABLE public.secondary_sales IS 'Outlet-level secondary sales (off-take). Joins to planograms for compliance.';
