-- Run this in the Supabase SQL Editor

-- Add check-in selfie column
ALTER TABLE attendance 
ADD COLUMN IF NOT EXISTS checkin_selfie_url TEXT;

-- Add check-out selfie column
ALTER TABLE attendance 
ADD COLUMN IF NOT EXISTS checkout_selfie_url TEXT;

-- Verify columns (optional)
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'attendance';
