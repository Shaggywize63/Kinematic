-- Migration: Add detailed tracking metadata to form submissions
-- This enables "Time Spent" calculations and accurate geofencing logs

-- 1. Hardening form_submissions (Ensure base columns exist first)
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS outlet_id UUID;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS outlet_name TEXT;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS check_in_at TIMESTAMPTZ;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS check_out_at TIMESTAMPTZ;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS check_in_gps TEXT;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS check_out_gps TEXT;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS gps TEXT;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

-- 2. Hardening builder_submissions (Ensure base columns exist first)
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS form_id UUID;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS outlet_id UUID;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS outlet_name TEXT;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS check_in_at TIMESTAMPTZ;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS check_out_at TIMESTAMPTZ;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS check_in_gps TEXT;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS check_out_gps TEXT;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS gps TEXT;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE builder_submissions ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

-- Indices for performance on outlet-wise grouping and date ranges
CREATE INDEX IF NOT EXISTS idx_form_subs_outlet_user_date ON form_submissions(outlet_id, user_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_builder_subs_outlet_user_date ON builder_submissions(outlet_id, user_id, submitted_at);
