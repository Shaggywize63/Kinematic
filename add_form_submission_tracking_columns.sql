-- Add missing tracking columns to form_submissions for better visibility
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Index for analytics
CREATE INDEX IF NOT EXISTS idx_form_submissions_lat_lng ON public.form_submissions(latitude, longitude) WHERE latitude IS NOT NULL;
