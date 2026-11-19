-- Pro-rated "seat added mid-cycle" charges, queued until an admin applies them
-- to the client's next invoice (see clientBilling.service.ts). Additive,
-- idempotent — safe to re-run.
CREATE TABLE IF NOT EXISTS public.client_seat_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id          uuid,
  user_label       text NOT NULL,
  added_on         date NOT NULL,
  -- NULL cycle_* means no recurring invoice was found for this client at the
  -- time the charge was queued — prorated_amount is then the full seat price.
  cycle_start      date,
  cycle_end        date,
  cycle_days       int,
  days_charged     int,
  price_per_user   numeric NOT NULL,
  prorated_amount  numeric NOT NULL,
  status           text NOT NULL DEFAULT 'pending', -- pending | invoiced | voided
  invoice_document_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  applied_at       timestamptz
);

CREATE INDEX IF NOT EXISTS client_seat_charges_client_status_idx
  ON public.client_seat_charges (client_id, status);
