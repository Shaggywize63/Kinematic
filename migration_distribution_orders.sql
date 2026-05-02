-- ============================================================================
-- Distribution Module — Orders
-- ============================================================================
-- orders, order_items
-- Idempotency-key unique on orders prevents replay double-bookings.
-- price_list_version is pinned at creation; mismatch on retry = 409.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.orders (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL,
    client_id           uuid        NULL,
    order_no            text        NOT NULL,
    outlet_id           uuid        NOT NULL,
    distributor_id      uuid        NOT NULL,
    salesman_id         uuid        NULL,
    route_visit_id      uuid        NULL,                 -- FK to existing visits/visit_logs
    status              text        NOT NULL DEFAULT 'placed',
                                                          -- draft | placed | approved | invoiced |
                                                          -- partially_invoiced | cancelled
    placed_at           timestamptz NOT NULL DEFAULT now(),
    approved_by         uuid        NULL,
    approved_at         timestamptz NULL,
    cancelled_by        uuid        NULL,
    cancelled_at        timestamptz NULL,
    cancel_reason       text        NULL,
    gps_lat             double precision NULL,
    gps_lng             double precision NULL,
    geofence_passed     boolean     NULL,
    geofence_distance_m int         NULL,
    device_meta         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    price_list_id       uuid        NOT NULL,
    price_list_version  int         NOT NULL,
    customer_class      text        NULL,
    place_of_supply     text        NULL,
    is_reverse_charge   boolean     NOT NULL DEFAULT false,
    subtotal            numeric(14,2) NOT NULL DEFAULT 0,
    discount_total      numeric(14,2) NOT NULL DEFAULT 0,
    scheme_total        numeric(14,2) NOT NULL DEFAULT 0,
    taxable_value       numeric(14,2) NOT NULL DEFAULT 0,
    cgst                numeric(14,2) NOT NULL DEFAULT 0,
    sgst                numeric(14,2) NOT NULL DEFAULT 0,
    igst                numeric(14,2) NOT NULL DEFAULT 0,
    cess                numeric(14,2) NOT NULL DEFAULT 0,
    round_off           numeric(6,2)  NOT NULL DEFAULT 0,
    grand_total         numeric(14,2) NOT NULL DEFAULT 0,
    notes               text        NULL,
    idempotency_key     text        NULL,
    created_by          uuid        NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, order_no),
    UNIQUE (org_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_orders_distributor    ON public.orders (org_id, distributor_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_salesman       ON public.orders (salesman_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_outlet_status  ON public.orders (outlet_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status         ON public.orders (org_id, status, placed_at DESC);

CREATE TABLE IF NOT EXISTS public.order_items (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            uuid        NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    sku_id              uuid        NOT NULL,
    sku_name            text        NULL,                 -- snapshot
    sku_code            text        NULL,
    hsn_code            text        NULL,
    qty                 int         NOT NULL,
    uom                 text        NOT NULL DEFAULT 'PCS',
    pack_size           int         NOT NULL DEFAULT 1,
    unit_price          numeric(12,2) NOT NULL,
    mrp                 numeric(12,2) NOT NULL DEFAULT 0,
    discount_pct        numeric(6,2)  NOT NULL DEFAULT 0,
    discount_amt        numeric(12,2) NOT NULL DEFAULT 0,
    scheme_id           uuid        NULL,
    scheme_version      int         NULL,
    is_free_good        boolean     NOT NULL DEFAULT false,
    taxable_value       numeric(14,2) NOT NULL DEFAULT 0,
    gst_rate            numeric(5,2)  NOT NULL DEFAULT 0,
    cgst                numeric(14,2) NOT NULL DEFAULT 0,
    sgst                numeric(14,2) NOT NULL DEFAULT 0,
    igst                numeric(14,2) NOT NULL DEFAULT 0,
    cess                numeric(14,2) NOT NULL DEFAULT 0,
    total               numeric(14,2) NOT NULL DEFAULT 0,
    price_list_version  int         NOT NULL,
    line_no             int         NOT NULL DEFAULT 1,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_sku   ON public.order_items (sku_id);

-- ── Order number sequence (per-org, per-day) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.gen_order_no(p_org uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_date_part text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD');
    v_seq       int;
BEGIN
    SELECT COUNT(*) + 1 INTO v_seq
    FROM public.orders
    WHERE org_id = p_org
      AND placed_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date;
    RETURN 'ORD-' || v_date_part || '-' || lpad(v_seq::text, 5, '0');
END;
$$;

COMMENT ON TABLE public.orders          IS 'Sales orders captured by FE / dashboard.';
COMMENT ON TABLE public.order_items     IS 'Line items for each order; price-list-version pinned.';
