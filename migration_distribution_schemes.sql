-- ============================================================================
-- Distribution Module — Schemes engine (M3)
-- ============================================================================
-- schemes (versioned, JSON rules) + scheme_application_log (proof of compute).
-- Editing inserts a new version row; orders pin scheme.id + version forever.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.schemes (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    client_id       uuid        NULL,
    code            text        NOT NULL,
    name            text        NOT NULL,
    type            text        NOT NULL,                    -- QPS | SLAB_DISCOUNT | BXGY | VALUE_DISCOUNT
    targeting       jsonb       NOT NULL DEFAULT '{}'::jsonb,
                                                              -- {brand_ids:[],category_ids:[],sku_ids:[],
                                                              --  customer_classes:[],outlet_ids:[],routes:[]}
    rules           jsonb       NOT NULL DEFAULT '{}'::jsonb,
                                                              -- type-specific config
    priority        int         NOT NULL DEFAULT 100,         -- lower = applied first
    stackable       boolean     NOT NULL DEFAULT false,
    valid_from      date        NOT NULL DEFAULT current_date,
    valid_to        date        NULL,
    version         int         NOT NULL DEFAULT 1,
    is_active       boolean     NOT NULL DEFAULT true,
    created_by      uuid        NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, code, version)
);
CREATE INDEX IF NOT EXISTS idx_schemes_active ON public.schemes (org_id, is_active, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_schemes_targeting_gin ON public.schemes USING GIN (targeting);

-- Append-only audit of every scheme application during pricing.
CREATE TABLE IF NOT EXISTS public.scheme_application_log (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    order_id        uuid        NULL,
    scheme_id       uuid        NOT NULL,
    scheme_version  int         NOT NULL,
    engine_version  text        NOT NULL,
    inputs          jsonb       NOT NULL,                    -- cart slice at compute time
    outputs         jsonb       NOT NULL,                    -- discount / free goods / value applied
    applied_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheme_log_order  ON public.scheme_application_log (order_id);
CREATE INDEX IF NOT EXISTS idx_scheme_log_scheme ON public.scheme_application_log (scheme_id, scheme_version);

COMMENT ON TABLE public.schemes                 IS 'Versioned trade schemes; orders pin (scheme_id, version) at compute.';
COMMENT ON TABLE public.scheme_application_log  IS 'Append-only proof of every scheme application; replayable.';
