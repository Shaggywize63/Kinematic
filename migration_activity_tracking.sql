-- Migration to add activity tracking columns to form_submissions
ALTER TABLE form_submissions 
ADD COLUMN IF NOT EXISTS check_in_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS check_out_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS check_in_gps TEXT,
ADD COLUMN IF NOT EXISTS check_out_gps TEXT;

-- Create an index to optimize duration queries if needed
CREATE INDEX IF NOT EXISTS idx_form_submissions_tracking ON form_submissions(check_in_at, check_out_at);

-- Optional: Add a comment to describe the columns
COMMENT ON COLUMN form_submissions.check_in_at IS 'Timestamp when the FE started the activity/check-in';
COMMENT ON COLUMN form_submissions.check_out_at IS 'Timestamp when the FE finished the activity/check-out';
COMMENT ON COLUMN form_submissions.check_in_gps IS 'GPS coordinates at the moment of check-in';
COMMENT ON COLUMN form_submissions.check_out_gps IS 'GPS coordinates at the moment of check-out';
