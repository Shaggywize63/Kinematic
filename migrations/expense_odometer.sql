-- Travel allowance by vehicle, with odometer readings (agrisynx).
--
-- A mileage line can now record the vehicle used and the odometer reading before
-- and after the trip, each with a photo. The distance (after - before) and the
-- amount (distance x the vehicle's per-km rate from the policy's
-- rules.vehicle_rates) are worked out by the server.
--
-- Additive and nullable: existing claims and every client that does not send these
-- fields are unaffected. Until this has been applied, the API refuses a line that
-- carries odometer data with a clear message (ODOMETER_NOT_ENABLED) instead of
-- failing on an unknown column.
--
-- Apply with:  npm run db:migrate migrations/expense_odometer.sql
--   (or run the statements below against the project's Postgres)

ALTER TABLE public.expense_claim_items
  ADD COLUMN IF NOT EXISTS vehicle_type              text,
  ADD COLUMN IF NOT EXISTS odometer_start            numeric(12,1),
  ADD COLUMN IF NOT EXISTS odometer_end              numeric(12,1),
  ADD COLUMN IF NOT EXISTS odometer_start_photo_url  text,
  ADD COLUMN IF NOT EXISTS odometer_end_photo_url    text;

-- Both readings, when present, must be in order. NOT VALID so it never blocks the
-- migration; it is enforced for every new / updated row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_items_odometer_order_chk') THEN
    ALTER TABLE public.expense_claim_items
      ADD CONSTRAINT expense_items_odometer_order_chk
      CHECK (odometer_start IS NULL OR odometer_end IS NULL OR odometer_end >= odometer_start) NOT VALID;
  END IF;
END $$;

-- Make PostgREST pick up the new columns straight away.
NOTIFY pgrst, 'reload schema';
