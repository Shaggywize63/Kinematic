-- Run this in the Supabase SQL Editor

-- 1. Check if the columns exist
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'attendance' 
AND column_name IN ('checkin_selfie_url', 'checkout_selfie_url');

-- 2. Check the 5 most recent attendance entries
SELECT id, user_id, date, status, checkin_selfie_url, checkout_selfie_url
FROM attendance
ORDER BY created_at DESC
LIMIT 5;

-- 3. If columns are missing, run the following to add them:
/*
ALTER TABLE attendance 
ADD COLUMN IF NOT EXISTS checkin_selfie_url TEXT,
ADD COLUMN IF NOT EXISTS checkout_selfie_url TEXT;
*/
