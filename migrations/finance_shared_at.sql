-- Finance: record when an invoice/quote was first shared (public link generated).
-- Lets the "Upcoming invoices" card drop a recurring invoice once its link has been
-- shared, independent of email-send (sent_at) or customer-view (viewed_at).
-- Additive and idempotent. After applying: NOTIFY pgrst, 'reload schema';

ALTER TABLE public.finance_documents
  ADD COLUMN IF NOT EXISTS shared_at timestamptz;
