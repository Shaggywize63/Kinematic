-- Finance: business expenses/bills with GST (input tax credit) + GST details on Field Expense claim lines.
-- Additive and idempotent. After applying: NOTIFY pgrst, 'reload schema';

-- ── Business expenses / vendor bills ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  expense_date    date NOT NULL,
  vendor_name     text NOT NULL,
  vendor_gstin    text,
  bill_number     text,
  category        text NOT NULL DEFAULT 'other',
  description     text,
  place_of_supply text,                         -- 2-digit GST state code of the supplier (drives CGST+SGST vs IGST)
  gst_rate        numeric(5,2) NOT NULL DEFAULT 0,
  taxable_value   numeric(14,2) NOT NULL DEFAULT 0,
  cgst            numeric(14,2) NOT NULL DEFAULT 0,
  sgst            numeric(14,2) NOT NULL DEFAULT 0,
  igst            numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  itc_eligible    boolean NOT NULL DEFAULT true,
  itc_reason      text,                         -- why credit is not claimed (blocked / no GSTIN / personal)
  receipt_url     text,
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS finance_expenses_scope_idx
  ON public.finance_expenses (org_id, client_id, expense_date DESC) WHERE deleted_at IS NULL;
ALTER TABLE public.finance_expenses ENABLE ROW LEVEL SECURITY;

-- ── GST details on Field Expense claim lines ────────────────────────────────
-- The line `amount` is what was paid (GST included). NULL gst_rate = "no GST details given": the line is
-- not part of the GST report. gst_amount is the tax as printed on the bill (OCR / typed); when null it is
-- derived from gst_rate. The CGST/SGST/IGST split is worked out at report time from the supplier GSTIN
-- state vs the business state, so it always matches the current Finance settings.
ALTER TABLE public.expense_claim_items
  ADD COLUMN IF NOT EXISTS supplier_gstin       text,
  ADD COLUMN IF NOT EXISTS supplier_invoice_no  text,
  ADD COLUMN IF NOT EXISTS gst_rate             numeric(5,2),
  ADD COLUMN IF NOT EXISTS gst_amount           numeric(12,2),
  ADD COLUMN IF NOT EXISTS itc_eligible         boolean;
