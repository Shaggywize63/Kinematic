-- Migration to fix builder_forms table schema
-- Run this in the Supabase SQL Editor

-- 1. Add missing columns to builder_forms
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS activity_id UUID REFERENCES activities(id) ON DELETE SET NULL;
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '📋';
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS cover_color TEXT DEFAULT '#E01E2C';
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Ensure RLS is configured (optional but recommended)
-- ALTER TABLE builder_forms ENABLE ROW LEVEL SECURITY;

-- 3. Ensure other builder tables exist with basic structure if needed
-- CREATE TABLE IF NOT EXISTS builder_pages (...);
-- CREATE TABLE IF NOT EXISTS builder_questions (...);
