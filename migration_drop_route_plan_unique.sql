-- Migration to allow multiple route plans for the same Activity and FE on the same date
-- 1. Drop existing unique constraint
ALTER TABLE route_plans DROP CONSTRAINT IF EXISTS route_plans_user_id_plan_date_activity_id_key;

-- 2. Verify that existing data is preserved and new duplicates are possible
-- (Optional: No action needed for preservation)
