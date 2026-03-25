-- Migration to fix route_plans unique constraint
-- Run this in the Supabase SQL Editor

-- 1. Drop existing unique constraint if it exists
-- This constraint was preventing multiple activities for the same FE on the same day.
ALTER TABLE route_plans DROP CONSTRAINT IF EXISTS route_plans_user_id_plan_date_key;

-- 2. Add new unique constraint including activity_id
-- This allows one plan per (FE + Date + Activity) combination.
ALTER TABLE route_plans ADD CONSTRAINT route_plans_user_id_plan_date_activity_id_key 
UNIQUE (user_id, plan_date, activity_id);

-- 3. Refresh schema cache in Supabase Dashboard:
-- Settings -> API -> PostgREST -> Reload Schema Cache
