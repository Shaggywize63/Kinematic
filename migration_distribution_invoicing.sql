-- ============================================================================
-- Distribution Module — Invoicing & Logistics (M2)
-- ============================================================================
-- invoices, invoice_items (immutable snapshot), dispatches, dispatch_lines,
-- deliveries.
--
-- Invoices are issued from approved orders. The line snapshot is captured AT
-- ISSUE TIME and never edited; cancellation creates a credit-note ledger
-- reversal in M2/M3 ledger flow.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.invoices (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                 uuid        NOT NULL,
    client_id              uuid        NULL,
    invoice_no             text        NOT NULL,                    -- DDMMYY-DIST-#####
    order_id               uuid        NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
    distributor_id         uuid        NOT NULL,
    outlet_id              uuid        NOT NULL,
    status                 text        NOT NULL DEFAULT 'issued',   -- draft | issued | cancelled
    irn                    text        NULL,
    qr_code_url            text        NULL,
    eway_bill_no           text        NULL,
    eway_bill_valid_until  timestamptz NULL,
    dispatch_id            uuid        NULL,
    place_of_supply        text        NULL,
    is_reverse_charge      boolean     NOT NULL DEFAULT false,
    subtotal               numeric(14,2) NOT NULL DEFAULT 0,
    discount_total         numeric(14,2) NOT NULL DEFAULT 0,
    scheme_total           numeric(14,2) NOT NULL DEFAULT 0,
    taxable_value          numeric(14,2) NOT NULL DEFAULT 0,
    cgst                   numeric(14,2) NOT NULL DEFAULT 0,
    sgst                   numeric(14,2) NOT NULL DEFAULT 0,
    igst                   numeric(14,2) NOT NULL DEFAULT 0,
    cess                   numeric(14,2) NOT NULL DEFAULT 0,
    round_off              numeric(6,2)  NOT NULL DEFAULT 0,
    grand_total            numeric(14,2) NOT NULL DEFAULT 0,
    pdf_url                text        NULL,
    issued_at              timestamptz NOT NULL DEFAULT now(),
    issued_by              uuid        NULL,
    cancelled_at           timestamptz NULL,
    cancelled_by           uuid        NULL,
    cancel_reason          text        NULL,
    idempotency_key        text        NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, invoice_no),
    UNIQUE (org_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_invoices_distributor ON public.invoices (org_id, distributor_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_outlet      ON public.invoices (outlet_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status      ON public.invoices (org_id, status, issued_at DESC);
-- Block re-issuing an invoice for the same order (one invoice per order; partial
-- billing would need a separate flow with explicit line splits).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_order_issued
    ON public.invoices (order_id) WHERE status <> 'cancelled';

CREATE TABLE IF NOT EXISTS public.invoice_items (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id          uuid        NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    sku_id              uuid        NOT NULL,
    sku_name            text        NULL,
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
    line_no             int         NOT NULL DEFAULT 1,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON public.invoice_items (invoice_id);

-- ── Invoice number sequence (date-stamped per distributor) ──────────────────
CREATE OR REPLACE FUNCTION public.gen_invoice_no(p_org uuid, p_dist uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_date_part text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DDMMYY');
    v_dist_code text;
    v_seq       int;
BEGIN
    SELECT code INTO v_dist_code FROM public.distributors WHERE id = p_dist LIMIT 1;
    SELECT COUNT(*) + 1 INTO v_seq
    FROM public.invoices
    WHERE org_id = p_org AND distributor_id = p_dist
      AND issued_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date;
    RETURN v_date_part || '-' || COALESCE(v_dist_code, 'DIST') || '-' || lpad(v_seq::text, 5, '0');
END;
$$;

-- ── Dispatches ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dispatches (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL,
    client_id           uuid        NULL,
    dispatch_no         text        NOT NULL,
    distributor_id      uuid        NOT NULL,
    vehicle_no          text        NULL,
    driver_name         text        NULL,
    driver_mobile       text        NULL,
    eway_bill_no        text        NULL,
    eway_bill_valid_until timestamptz NULL,
    total_value         numeric(14,2) NOT NULL DEFAULT 0,
    status              text        NOT NULL DEFAULT 'prepared',     -- prepared | out | delivered | partially_returned | cancelled
    dispatched_at       timestamptz NULL,
    delivered_at        timestamptz NULL,
    notes               text        NULL,
    created_by          uuid        NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, dispatch_no)
);
CREATE INDEX IF NOT EXISTS idx_dispatches_status ON public.dispatches (org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.dispatch_lines (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    dispatch_id     uuid        NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
    invoice_id      uuid        NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
    UNIQUE (dispatch_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_lines_invoice ON public.dispatch_lines (invoice_id);

-- ── Deliveries (POD) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deliveries (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  uuid        NOT NULL,
    invoice_id              uuid        NOT NULL UNIQUE REFERENCES public.invoices(id) ON DELETE CASCADE,
    delivered_at            timestamptz NOT NULL DEFAULT now(),
    pod_image_url           text        NOT NULL,                     -- signed-upload URL
    received_by_name        text        NULL,
    received_signature_url  text        NULL,
    gps_lat                 double precision NULL,
    gps_lng                 double precision NULL,
    notes                   text        NULL,
    delivered_by_user_id    uuid        NULL,
    created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_invoice ON public.deliveries (invoice_id);

-- ── Dispatch number sequence (per org/day) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.gen_dispatch_no(p_org uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_date_part text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD');
    v_seq       int;
BEGIN
    SELECT COUNT(*) + 1 INTO v_seq
    FROM public.dispatches
    WHERE org_id = p_org AND created_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date;
    RETURN 'DSP-' || v_date_part || '-' || lpad(v_seq::text, 5, '0');
END;
$$;

COMMENT ON TABLE public.invoices       IS 'Sales invoices issued from orders. Snapshotted line items in invoice_items.';
COMMENT ON TABLE public.invoice_items  IS 'Immutable invoice line snapshot at issue time.';
COMMENT ON TABLE public.dispatches     IS 'Vehicle dispatches; carries one or more invoices.';
COMMENT ON TABLE public.dispatch_lines IS 'Many-to-many between dispatches and invoices.';
COMMENT ON TABLE public.deliveries     IS 'POD records (photo + signature + GPS) for delivered invoices.';
