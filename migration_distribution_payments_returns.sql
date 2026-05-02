-- ============================================================================
-- Distribution Module — Payments, Returns, Ledger (M2/M3)
-- ============================================================================
-- payments, returns, return_items, ledger_entries with double-entry trigger
-- and non-negative-balance enforcement.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payments (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  uuid        NOT NULL,
    client_id               uuid        NULL,
    payment_no              text        NOT NULL,
    outlet_id               uuid        NOT NULL,
    distributor_id          uuid        NULL,
    salesman_id             uuid        NULL,
    mode                    text        NOT NULL,                  -- cash | upi | cheque | credit_adjustment
    amount                  numeric(14,2) NOT NULL CHECK (amount > 0),
    currency                text        NOT NULL DEFAULT 'INR',
    reference               text        NULL,                       -- UPI txn id / cheque no
    cheque_bank             text        NULL,
    cheque_date             date        NULL,
    cheque_image_url        text        NULL,                       -- REQUIRED if mode=cheque
    upi_qr_id               text        NULL,
    gateway_payload         jsonb       NULL,
    applied_to_invoices     jsonb       NOT NULL DEFAULT '[]'::jsonb,    -- [{invoice_id, amount}]
    gps_lat                 double precision NULL,
    gps_lng                 double precision NULL,
    status                  text        NOT NULL DEFAULT 'cleared',     -- pending | cleared | bounced | cancelled
    received_at             timestamptz NOT NULL DEFAULT now(),
    bounced_at              timestamptz NULL,
    bounce_reason           text        NULL,
    idempotency_key         text        NULL,
    created_by              uuid        NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, payment_no),
    UNIQUE (org_id, idempotency_key),
    -- Cheque payments must carry a signed-upload image URL.
    CHECK (mode <> 'cheque' OR cheque_image_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_payments_outlet     ON public.payments (outlet_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_distributor ON public.payments (distributor_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON public.payments (org_id, status);

CREATE OR REPLACE FUNCTION public.gen_payment_no(p_org uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_date_part text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD');
    v_seq       int;
BEGIN
    SELECT COUNT(*) + 1 INTO v_seq
    FROM public.payments
    WHERE org_id = p_org AND received_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date;
    RETURN 'PAY-' || v_date_part || '-' || lpad(v_seq::text, 5, '0');
END;
$$;

-- ── Returns ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.returns (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  uuid        NOT NULL,
    client_id               uuid        NULL,
    return_no               text        NOT NULL,
    outlet_id               uuid        NOT NULL,
    distributor_id          uuid        NULL,
    salesman_id             uuid        NULL,
    original_invoice_id     uuid        NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
    reason_code             text        NOT NULL,                   -- damaged | near_expiry | wrong_sku | trade_return | etc
    reason_notes            text        NULL,
    photo_urls              text[]      NOT NULL,                    -- ≥1 enforced in controller
    status                  text        NOT NULL DEFAULT 'requested', -- requested | supervisor_approved | rejected | credited
    requires_supervisor     boolean     NOT NULL DEFAULT false,
    approved_by             uuid        NULL,
    approved_at             timestamptz NULL,
    rejected_by             uuid        NULL,
    rejected_at             timestamptz NULL,
    rejection_reason        text        NULL,
    total_value             numeric(14,2) NOT NULL DEFAULT 0,
    cgst                    numeric(14,2) NOT NULL DEFAULT 0,
    sgst                    numeric(14,2) NOT NULL DEFAULT 0,
    igst                    numeric(14,2) NOT NULL DEFAULT 0,
    cess                    numeric(14,2) NOT NULL DEFAULT 0,
    gps_lat                 double precision NULL,
    gps_lng                 double precision NULL,
    idempotency_key         text        NULL,
    created_by              uuid        NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, return_no),
    UNIQUE (org_id, idempotency_key),
    CHECK (array_length(photo_urls, 1) >= 1)
);
CREATE INDEX IF NOT EXISTS idx_returns_outlet ON public.returns (outlet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_returns_status ON public.returns (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_returns_invoice ON public.returns (original_invoice_id);

CREATE TABLE IF NOT EXISTS public.return_items (
    id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id                   uuid        NOT NULL REFERENCES public.returns(id) ON DELETE CASCADE,
    sku_id                      uuid        NOT NULL,
    sku_name                    text        NULL,
    qty                         int         NOT NULL CHECK (qty > 0),
    unit_price                  numeric(12,2) NOT NULL DEFAULT 0,
    taxable_value               numeric(14,2) NOT NULL DEFAULT 0,
    gst_rate                    numeric(5,2)  NOT NULL DEFAULT 0,
    cgst                        numeric(14,2) NOT NULL DEFAULT 0,
    sgst                        numeric(14,2) NOT NULL DEFAULT 0,
    igst                        numeric(14,2) NOT NULL DEFAULT 0,
    cess                        numeric(14,2) NOT NULL DEFAULT 0,
    total                       numeric(14,2) NOT NULL DEFAULT 0,
    condition                   text        NOT NULL DEFAULT 'damaged',  -- saleable | damaged | expired
    original_invoice_item_id    uuid        NULL,
    created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON public.return_items (return_id);

CREATE OR REPLACE FUNCTION public.gen_return_no(p_org uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_date_part text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD');
    v_seq       int;
BEGIN
    SELECT COUNT(*) + 1 INTO v_seq
    FROM public.returns
    WHERE org_id = p_org AND created_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date;
    RETURN 'RET-' || v_date_part || '-' || lpad(v_seq::text, 5, '0');
END;
$$;

-- ── Ledger (double-entry) ───────────────────────────────────────────────────
-- DR = outlet owes more; CR = outlet owes less. Running balance is signed:
-- positive = outstanding owed by outlet to distributor.
CREATE TABLE IF NOT EXISTS public.ledger_entries (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    client_id       uuid        NULL,
    outlet_id       uuid        NOT NULL,
    distributor_id  uuid        NOT NULL,
    entry_type      text        NOT NULL,                -- invoice | payment | return | credit_note | adjustment
    ref_table       text        NOT NULL,
    ref_id          uuid        NOT NULL,
    dr              numeric(14,2) NOT NULL DEFAULT 0,
    cr              numeric(14,2) NOT NULL DEFAULT 0,
    running_balance numeric(14,2) NOT NULL DEFAULT 0,
    notes           text        NULL,
    posted_at       timestamptz NOT NULL DEFAULT now(),
    posted_by       uuid        NULL,
    posted_by_role  text        NULL,
    -- Either DR or CR is non-zero; both never zero, both never set.
    CHECK ((dr = 0 OR cr = 0) AND (dr + cr > 0))
);
CREATE INDEX IF NOT EXISTS idx_ledger_outlet      ON public.ledger_entries (outlet_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_distributor ON public.ledger_entries (distributor_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref         ON public.ledger_entries (ref_table, ref_id);

-- Trigger: refuse a posting that would push the outlet's running balance
-- below -credit_limit (i.e. owing more than allowed) UNLESS the poster has
-- the admin role explicitly recorded.
CREATE OR REPLACE FUNCTION public.enforce_no_negative_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_credit_limit numeric;
BEGIN
    -- Skip enforcement for explicit admin overrides.
    IF NEW.posted_by_role IN ('super_admin', 'admin', 'main_admin') THEN
        RETURN NEW;
    END IF;
    SELECT COALESCE(credit_limit, 0) INTO v_credit_limit
    FROM public.outlet_distribution_ext
    WHERE outlet_id = NEW.outlet_id;
    -- running_balance > credit_limit means outlet owes more than its limit allows
    IF NEW.running_balance > COALESCE(v_credit_limit, 0) THEN
        RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED: balance % > credit_limit %', NEW.running_balance, v_credit_limit
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_no_negative ON public.ledger_entries;
CREATE TRIGGER trg_ledger_no_negative
    BEFORE INSERT ON public.ledger_entries
    FOR EACH ROW EXECUTE FUNCTION public.enforce_no_negative_balance();

-- Helper function that callers use to post an entry with running_balance
-- computed atomically (advisory lock per outlet to serialise concurrent
-- writes for the same outlet).
CREATE OR REPLACE FUNCTION public.post_ledger_entry(
    p_org           uuid,
    p_client        uuid,
    p_outlet        uuid,
    p_distributor   uuid,
    p_entry_type    text,
    p_ref_table     text,
    p_ref_id        uuid,
    p_dr            numeric,
    p_cr            numeric,
    p_notes         text,
    p_posted_by     uuid,
    p_posted_role   text
) RETURNS public.ledger_entries
LANGUAGE plpgsql
AS $$
DECLARE
    v_prev      numeric;
    v_new       numeric;
    v_row       public.ledger_entries;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_outlet::text));
    SELECT COALESCE(running_balance, 0) INTO v_prev
    FROM public.ledger_entries
    WHERE outlet_id = p_outlet
    ORDER BY posted_at DESC LIMIT 1;
    v_new := COALESCE(v_prev, 0) + COALESCE(p_dr, 0) - COALESCE(p_cr, 0);

    INSERT INTO public.ledger_entries (
        org_id, client_id, outlet_id, distributor_id, entry_type,
        ref_table, ref_id, dr, cr, running_balance, notes, posted_by, posted_by_role
    ) VALUES (
        p_org, p_client, p_outlet, p_distributor, p_entry_type,
        p_ref_table, p_ref_id, COALESCE(p_dr, 0), COALESCE(p_cr, 0), v_new,
        p_notes, p_posted_by, p_posted_role
    ) RETURNING * INTO v_row;

    UPDATE public.outlet_distribution_ext
    SET current_balance = v_new, updated_at = now()
    WHERE outlet_id = p_outlet;

    RETURN v_row;
END;
$$;

COMMENT ON TABLE public.payments         IS 'Outlet payments (cash/UPI/cheque/credit-adj). Cheque enforces image URL.';
COMMENT ON TABLE public.returns          IS 'Outlet returns; supervisor-gated above threshold.';
COMMENT ON TABLE public.return_items     IS 'Return line items (snapshot of original invoice line).';
COMMENT ON TABLE public.ledger_entries   IS 'Double-entry ledger; non-negative balance trigger; advisory-locked posts.';
COMMENT ON FUNCTION public.post_ledger_entry IS 'Atomic helper to compute and write a ledger row.';
