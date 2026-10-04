-- Finance module (Zoho-Invoice-style billing): customers, items, quotes, invoices,
-- payments received, numbering, activity trail.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database (`tata`) — only run there if explicitly asked.
--
-- Tables are prefixed finance_* because `invoices`, `invoice_items`, `payments`
-- and `ledger_entries` already exist for the Distribution module.
--
-- Tenancy: every row carries org_id + client_id (client_id NULL = the org's own
-- books). All access goes through the backend (service role); RLS is enabled with
-- no policies so anon/authenticated roles cannot read or write directly.
--
-- Access: master admin only for now (see src/middleware/financeAccess.ts). The
-- `finance` module below is non-universal and never auto-granted, so it can later
-- be shared with a client by inserting a client_modules row.

-- ── Settings (one row per org + client scope) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_settings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL,
  client_id               uuid,
  business_name           text,
  email                   text,
  phone                   text,
  website                 text,
  address_line1           text,
  address_line2           text,
  city                    text,
  state                   text,
  state_code              text,            -- 2-digit GST state code, drives CGST+SGST vs IGST
  pincode                 text,
  country                 text NOT NULL DEFAULT 'India',
  gstin                   text,
  pan                     text,
  logo_url                text,
  currency                text NOT NULL DEFAULT 'INR',
  fiscal_year_start_month int  NOT NULL DEFAULT 4 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  invoice_prefix          text NOT NULL DEFAULT 'INV-',
  invoice_next_number     int  NOT NULL DEFAULT 1,
  quote_prefix            text NOT NULL DEFAULT 'QT-',
  quote_next_number       int  NOT NULL DEFAULT 1,
  payment_prefix          text NOT NULL DEFAULT 'PAY-',
  payment_next_number     int  NOT NULL DEFAULT 1,
  number_padding          int  NOT NULL DEFAULT 6,
  default_payment_terms_days int NOT NULL DEFAULT 0,
  default_notes           text,
  default_terms           text,
  bank_details            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- account_name, account_number, ifsc, bank_name, branch, upi_id
  template                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- accent_color, show_logo, show_bank_details, signature_name, footer_text
  email_subject_template  text,
  email_body_template     text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_settings_scope_uq
  ON public.finance_settings (org_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── Customers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  client_id        uuid,
  customer_type    text NOT NULL DEFAULT 'business' CHECK (customer_type IN ('business','individual')),
  salutation       text,
  first_name       text,
  last_name        text,
  company_name     text,
  display_name     text NOT NULL,
  email            text,
  work_phone       text,
  mobile           text,
  language         text NOT NULL DEFAULT 'English',
  currency         text NOT NULL DEFAULT 'INR',
  gst_treatment    text,                   -- registered_regular | registered_composition | unregistered | consumer | overseas | sez
  gstin            text,
  place_of_supply  text,                   -- 2-digit state code
  pan              text,
  tax_preference   text NOT NULL DEFAULT 'taxable' CHECK (tax_preference IN ('taxable','exempt')),
  payment_terms_days int NOT NULL DEFAULT 0,
  billing_address  jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_persons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  remarks          text,
  portal_enabled   boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS finance_customers_scope_idx ON public.finance_customers (org_id, client_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_customers_name_idx  ON public.finance_customers (org_id, lower(display_name));

-- ── Items ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  name           text NOT NULL,
  item_type      text NOT NULL DEFAULT 'goods' CHECK (item_type IN ('goods','service')),
  unit           text,
  hsn_sac        text,
  tax_preference text NOT NULL DEFAULT 'taxable' CHECK (tax_preference IN ('taxable','exempt')),
  gst_rate       numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_rate >= 0 AND gst_rate <= 100),
  selling_price  numeric(14,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  description    text,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid,
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS finance_items_scope_idx ON public.finance_items (org_id, client_id) WHERE deleted_at IS NULL;

-- ── Documents (invoices + quotes share one table) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  client_id             uuid,
  doc_type              text NOT NULL CHECK (doc_type IN ('invoice','quote')),
  number                text NOT NULL,
  reference_number      text,                 -- order number / PO
  subject               text,
  customer_id           uuid REFERENCES public.finance_customers(id),
  customer_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- name, email, gstin, gst_treatment at issue time
  bill_to               jsonb NOT NULL DEFAULT '{}'::jsonb,
  ship_to               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- invoice: draft | sent | partially_paid | paid | void       (overdue is derived)
  -- quote:   draft | sent | accepted | declined | invoiced | expired
  status                text NOT NULL DEFAULT 'draft',
  issue_date            date NOT NULL DEFAULT CURRENT_DATE,
  due_date              date,
  expiry_date           date,
  payment_terms_days    int  NOT NULL DEFAULT 0,
  place_of_supply       text,
  seller_state_code     text,
  subtotal              numeric(14,2) NOT NULL DEFAULT 0,
  discount_total        numeric(14,2) NOT NULL DEFAULT 0,
  taxable_value         numeric(14,2) NOT NULL DEFAULT 0,
  cgst                  numeric(14,2) NOT NULL DEFAULT 0,
  sgst                  numeric(14,2) NOT NULL DEFAULT 0,
  igst                  numeric(14,2) NOT NULL DEFAULT 0,
  tax_total             numeric(14,2) NOT NULL DEFAULT 0,
  adjustment            numeric(14,2) NOT NULL DEFAULT 0,
  adjustment_label      text,
  round_off             numeric(14,2) NOT NULL DEFAULT 0,
  total                 numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid           numeric(14,2) NOT NULL DEFAULT 0,
  balance               numeric(14,2) NOT NULL DEFAULT 0,
  notes                 text,
  terms                 text,
  share_token           text UNIQUE,
  sent_at               timestamptz,
  last_sent_to          text,
  viewed_at             timestamptz,
  voided_at             timestamptz,
  source_quote_id       uuid,
  converted_invoice_id  uuid,
  created_by            uuid,
  updated_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_documents_number_uq
  ON public.finance_documents (org_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), doc_type, number)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_documents_list_idx     ON public.finance_documents (org_id, client_id, doc_type, issue_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_documents_customer_idx ON public.finance_documents (customer_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.finance_document_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES public.finance_documents(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL,
  position       int  NOT NULL DEFAULT 0,
  item_id        uuid,
  name           text NOT NULL,
  description    text,
  hsn_sac        text,
  quantity       numeric(14,3) NOT NULL DEFAULT 1,
  unit           text,
  rate           numeric(14,2) NOT NULL DEFAULT 0,
  discount_pct   numeric(5,2)  NOT NULL DEFAULT 0,
  gst_rate       numeric(5,2)  NOT NULL DEFAULT 0,
  taxable_value  numeric(14,2) NOT NULL DEFAULT 0,
  cgst           numeric(14,2) NOT NULL DEFAULT 0,
  sgst           numeric(14,2) NOT NULL DEFAULT 0,
  igst           numeric(14,2) NOT NULL DEFAULT 0,
  total          numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS finance_document_items_doc_idx ON public.finance_document_items (document_id, position);

-- ── Payments received ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  payment_number text NOT NULL,
  customer_id    uuid NOT NULL REFERENCES public.finance_customers(id),
  payment_date   date NOT NULL DEFAULT CURRENT_DATE,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  unused_amount  numeric(14,2) NOT NULL DEFAULT 0,
  mode           text NOT NULL DEFAULT 'bank_transfer' CHECK (mode IN ('cash','bank_transfer','upi','cheque','card','other')),
  reference      text,
  notes          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_payments_number_uq
  ON public.finance_payments (org_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), payment_number)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_payments_list_idx ON public.finance_payments (org_id, client_id, payment_date DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.finance_payment_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  payment_id  uuid NOT NULL REFERENCES public.finance_payments(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.finance_documents(id),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_alloc_payment_idx  ON public.finance_payment_allocations (payment_id);
CREATE INDEX IF NOT EXISTS finance_alloc_document_idx ON public.finance_payment_allocations (document_id);

-- ── Activity trail ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_document_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES public.finance_documents(id) ON DELETE CASCADE,
  event       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_events_doc_idx ON public.finance_document_events (document_id, created_at DESC);

-- ── Atomic number allocation ────────────────────────────────────────────────
-- Returns the next formatted number (e.g. INV-000007) and bumps the counter in
-- one statement so concurrent requests can't get the same number.
CREATE OR REPLACE FUNCTION public.finance_next_number(p_org uuid, p_client uuid, p_kind text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_prefix text;
  v_n      int;
  v_pad    int;
BEGIN
  IF p_kind NOT IN ('invoice','quote','payment') THEN
    RAISE EXCEPTION 'finance_next_number: unknown kind %', p_kind;
  END IF;

  INSERT INTO public.finance_settings (org_id, client_id) VALUES (p_org, p_client)
  ON CONFLICT DO NOTHING;

  IF p_kind = 'invoice' THEN
    UPDATE public.finance_settings SET invoice_next_number = invoice_next_number + 1, updated_at = now()
     WHERE org_id = p_org AND client_id IS NOT DISTINCT FROM p_client
    RETURNING invoice_prefix, invoice_next_number - 1, number_padding INTO v_prefix, v_n, v_pad;
  ELSIF p_kind = 'quote' THEN
    UPDATE public.finance_settings SET quote_next_number = quote_next_number + 1, updated_at = now()
     WHERE org_id = p_org AND client_id IS NOT DISTINCT FROM p_client
    RETURNING quote_prefix, quote_next_number - 1, number_padding INTO v_prefix, v_n, v_pad;
  ELSE
    UPDATE public.finance_settings SET payment_next_number = payment_next_number + 1, updated_at = now()
     WHERE org_id = p_org AND client_id IS NOT DISTINCT FROM p_client
    RETURNING payment_prefix, payment_next_number - 1, number_padding INTO v_prefix, v_n, v_pad;
  END IF;

  RETURN v_prefix || lpad(v_n::text, v_pad, '0');
END;
$$;
REVOKE EXECUTE ON FUNCTION public.finance_next_number(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.finance_next_number(uuid, uuid, text) TO service_role;

-- ── Lock the tables to the service role ─────────────────────────────────────
ALTER TABLE public.finance_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_document_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_document_events    ENABLE ROW LEVEL SECURITY;

-- ── Allow the new package value ─────────────────────────────────────────────
-- modules.package is constrained to a fixed list (modules_package_chk), which has no 'finance'.
-- Without this the module row below is rejected and the whole migration rolls back.
ALTER TABLE public.modules DROP CONSTRAINT IF EXISTS modules_package_chk;
ALTER TABLE public.modules ADD CONSTRAINT modules_package_chk CHECK (
  package IS NULL OR package = ANY (ARRAY['field_force','distribution','crm','business','system','people','audit','finance'])
);

-- ── Register the module (non-universal; never auto-granted) ─────────────────
INSERT INTO public.modules (id, name, description, package, is_universal) VALUES
  ('finance', 'Finance', 'Invoices, quotes, customers, items, payments received and finance reports', 'finance', false)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, package=EXCLUDED.package, is_universal=EXCLUDED.is_universal;

-- ── Tell PostgREST about the new tables ─────────────────────────────────────
-- The self-hosted PostgREST (ECS) has no DDL event trigger like hosted Supabase, so it keeps serving its
-- old schema cache and every finance query fails with "not found in the schema cache" until it reloads.
-- NOTIFY is delivered when this transaction commits.
NOTIFY pgrst, 'reload schema';
