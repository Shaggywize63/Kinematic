-- Migration to fix route_plans table schema
-- Run this in the Supabase SQL Editor

-- 1. Add missing activity_id column to route_plans
ALTER TABLE route_plans ADD COLUMN IF NOT EXISTS activity_id UUID REFERENCES activities(id) ON DELETE SET NULL;

-- 2. Add an index for faster lookups (optional)
CREATE INDEX IF NOT EXISTS idx_route_plans_activity_id ON route_plans(activity_id);

-- 3. You may also need to refresh the schema cache after running this:
-- Supabase Dashboard -> Settings -> API -> PostgREST -> Reload Schema Cache
