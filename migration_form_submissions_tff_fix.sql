-- Migration to add converted flag and date to form_submissions
-- This ensures TFF count can be reliably calculated

ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS is_converted BOOLEAN DEFAULT TRUE;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;

-- Backfill existing rows
UPDATE form_submissions SET date = submitted_at::DATE WHERE date IS NULL;
UPDATE form_submissions SET is_converted = TRUE WHERE is_converted IS NULL;
