-- ============================================================================
-- Distribution Module — UPI payment proof image
-- ============================================================================
-- Adds payments.upi_image_url so a field user can attach a UPI screenshot/photo
-- (from gallery/camera) when collecting a UPI payment. Additive + idempotent.
-- The URL must come from our signed-upload flow (kind=upi); the API validates
-- that, so no CHECK constraint is added here (keeps legacy rows valid).
-- ============================================================================

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS upi_image_url text NULL;

COMMENT ON COLUMN public.payments.upi_image_url IS
    'Signed-upload URL (kind=upi) of the UPI payment proof image. Optional.';

-- PostgREST caches the schema; reload so the new column is exposed immediately.
NOTIFY pgrst, 'reload schema';
