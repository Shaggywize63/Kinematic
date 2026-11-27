-- Support tickets: customer feedback (CSAT) on a finished ticket.
--
-- The customer rates how the ticket was handled once it is resolved, closed or not planned, with an
-- optional comment. Stored on the row (one rating per ticket, re-submittable), and recorded on the
-- timeline as a `feedback` event so the team sees it in the thread.
--
-- Additive and idempotent. Kinematic project only (every ticket lives in SUPPORT_PROJECT).
BEGIN;

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS csat_rating  smallint,
  ADD COLUMN IF NOT EXISTS csat_comment text,
  ADD COLUMN IF NOT EXISTS csat_at      timestamptz;

ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_csat_rating_check;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_csat_rating_check
  CHECK (csat_rating IS NULL OR (csat_rating >= 1 AND csat_rating <= 5));

-- The timeline gains a fourth entry kind.
ALTER TABLE public.support_ticket_events DROP CONSTRAINT IF EXISTS support_ticket_events_kind_check;
ALTER TABLE public.support_ticket_events
  ADD CONSTRAINT support_ticket_events_kind_check
  CHECK (kind IN ('created', 'status', 'comment', 'feedback'));

-- Only rated tickets matter for a CSAT report, so keep the index partial.
CREATE INDEX IF NOT EXISTS idx_support_tickets_csat
  ON public.support_tickets (csat_rating, csat_at DESC) WHERE csat_rating IS NOT NULL;

COMMIT;
NOTIFY pgrst, 'reload schema';
