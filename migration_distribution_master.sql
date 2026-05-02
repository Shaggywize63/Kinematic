-- ============================================================================
-- Distribution Module — Master Data
-- ============================================================================
-- Brand → Distributor → FE/Salesman → Outlet → Consumer
-- Tables:
--   brands, distributors, distributor_users, outlet_distribution_ext,
--   salesman_ext, product_distribution_ext, price_lists, price_list_items
--
-- Multi-tenant via org_id + client_id. RLS policies in
-- migration_distribution_audit_idempotency.sql; controllers also filter
-- (defence-in-depth).
-- ============================================================================

-- ── Brands ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.brands (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    client_id       uuid        NULL,
    name            text        NOT NULL,
    code            text        NOT NULL,
    legal_name      text        NULL,
    gstin           text        NULL,
    pan             text        NULL,
    state_code      text        NULL,                 -- 2-char state code (e.g. '27' for MH)
    billing_address jsonb       NOT NULL DEFAULT '{}'::jsonb,
    logo_url        text        NULL,
    is_active       boolean     NOT NULL DEFAULT true,
    created_by      uuid        NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_brands_org_active ON public.brands (org_id, is_active);

-- ── Distributors ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.distributors (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL,
    client_id           uuid        NULL,
    name                text        NOT NULL,
    code                text        NOT NULL,
    legal_name          text        NULL,
    gstin               text        NULL,
    pan                 text        NULL,
    state_code          text        NULL,
    place_of_supply     text        NULL,
    address             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    contact_name        text        NULL,
    contact_mobile      text        NULL,
    email               text        NULL,
    credit_limit        numeric(14,2) NOT NULL DEFAULT 0,
    payment_terms_days  int         NOT NULL DEFAULT 0,
    customer_class      text        NOT NULL DEFAULT 'distributor',  -- super_stockist|distributor|wholesaler
    assigned_brands     uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
    region              text        NULL,
    city_id             uuid        NULL,
    is_active           boolean     NOT NULL DEFAULT true,
    created_by          uuid        NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_distributors_org_active ON public.distributors (org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_distributors_city       ON public.distributors (city_id);

-- ── Distributor users (link distributor staff to existing users) ────────────
CREATE TABLE IF NOT EXISTS public.distributor_users (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL,
    distributor_id      uuid        NOT NULL REFERENCES public.distributors(id) ON DELETE CASCADE,
    user_id             uuid        NOT NULL,
    role                text        NOT NULL DEFAULT 'owner',     -- owner | billing | warehouse
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (distributor_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_distributor_users_user ON public.distributor_users (user_id);

-- ── Outlet extension (1:1 with stores/outlets) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.outlet_distribution_ext (
    outlet_id               uuid        PRIMARY KEY,                 -- FK to stores.id
    org_id                  uuid        NOT NULL,
    client_id               uuid        NULL,
    gstin                   text        NULL,
    outlet_class            text        NULL,                        -- A | B | C
    customer_class          text        NULL,                        -- MT | GT | HoReCa | Pharma | Wholesale
    credit_limit            numeric(14,2) NOT NULL DEFAULT 0,
    current_balance         numeric(14,2) NOT NULL DEFAULT 0,        -- mirror of ledger; advisory
    assigned_distributor_id uuid        NULL REFERENCES public.distributors(id) ON DELETE SET NULL,
    geofence_radius_m       int         NOT NULL DEFAULT 100,
    kyc_doc_url             text        NULL,
    fssai_no                text        NULL,
    drug_lic_no             text        NULL,
    state_code              text        NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outlet_dist_ext_distributor
    ON public.outlet_distribution_ext (assigned_distributor_id, customer_class);

-- ── Salesman extension (1:1 with users) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.salesman_ext (
    user_id                 uuid        PRIMARY KEY,                  -- FK to users.id
    org_id                  uuid        NOT NULL,
    assigned_distributor_id uuid        NULL REFERENCES public.distributors(id) ON DELETE SET NULL,
    daily_order_cap_value   numeric(14,2) NOT NULL DEFAULT 0,         -- 0 = unlimited
    daily_collection_cap    numeric(14,2) NOT NULL DEFAULT 0,
    single_order_cap_value  numeric(14,2) NOT NULL DEFAULT 0,
    default_route_id        uuid        NULL,
    can_book_credit         boolean     NOT NULL DEFAULT true,
    return_threshold_value  numeric(14,2) NOT NULL DEFAULT 5000,      -- > this requires supervisor
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ── Product extension (1:1 with skus) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_distribution_ext (
    sku_id                  uuid        PRIMARY KEY,                  -- FK to skus.id
    org_id                  uuid        NOT NULL,
    client_id               uuid        NULL,
    brand_id                uuid        NULL REFERENCES public.brands(id) ON DELETE SET NULL,
    hsn_code                text        NULL,
    gst_rate                numeric(5,2) NOT NULL DEFAULT 0,          -- 0 | 5 | 12 | 18 | 28
    cess_rate               numeric(5,2) NOT NULL DEFAULT 0,
    uom                     text        NOT NULL DEFAULT 'PCS',       -- PCS | CASE | KG | L
    pack_size               int         NOT NULL DEFAULT 1,
    case_size               int         NOT NULL DEFAULT 1,
    mrp                     numeric(12,2) NOT NULL DEFAULT 0,
    is_returnable           boolean     NOT NULL DEFAULT true,
    return_window_days      int         NOT NULL DEFAULT 30,
    is_chilled              boolean     NOT NULL DEFAULT false,
    is_active               boolean     NOT NULL DEFAULT true,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_dist_brand ON public.product_distribution_ext (brand_id);

-- ── Price lists (versioned) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.price_lists (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    client_id       uuid        NULL,
    name            text        NOT NULL,
    customer_class  text        NOT NULL DEFAULT 'GT',                -- MT | GT | HoReCa | etc
    region          text        NOT NULL DEFAULT 'ALL',
    valid_from      date        NOT NULL DEFAULT current_date,
    valid_to        date        NULL,
    version         int         NOT NULL DEFAULT 1,
    is_active       boolean     NOT NULL DEFAULT true,
    created_by      uuid        NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, customer_class, region, version)
);
CREATE INDEX IF NOT EXISTS idx_price_lists_active
    ON public.price_lists (org_id, customer_class, region, is_active, valid_from);

CREATE TABLE IF NOT EXISTS public.price_list_items (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    price_list_id   uuid        NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
    sku_id          uuid        NOT NULL,
    base_price      numeric(12,2) NOT NULL,
    min_qty         int         NOT NULL DEFAULT 1,
    max_qty         int         NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (price_list_id, sku_id)
);
CREATE INDEX IF NOT EXISTS idx_price_list_items_sku ON public.price_list_items (sku_id);

COMMENT ON TABLE public.brands                       IS 'Brand identities (legal entity per brand) for distribution.';
COMMENT ON TABLE public.distributors                 IS 'Distributors / super-stockists / wholesalers under each org.';
COMMENT ON TABLE public.distributor_users            IS 'Links distributor staff (in users table) to a distributor.';
COMMENT ON TABLE public.outlet_distribution_ext      IS 'Distribution-only attributes on top of stores/outlets.';
COMMENT ON TABLE public.salesman_ext                 IS 'FE caps and routing for the distribution app.';
COMMENT ON TABLE public.product_distribution_ext     IS 'GST + pack + brand attributes on top of skus.';
COMMENT ON TABLE public.price_lists                  IS 'Versioned price lists by customer-class + region.';
COMMENT ON TABLE public.price_list_items             IS 'Per-SKU price under a given price list version.';
