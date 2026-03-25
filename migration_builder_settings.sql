-- Migration to add settings columns to builder_forms
-- Run this in the Supabase SQL Editor

ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS requires_photo BOOLEAN DEFAULT FALSE;
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS requires_gps BOOLEAN DEFAULT TRUE;
ALTER TABLE builder_forms ADD COLUMN IF NOT EXISTS allow_offline BOOLEAN DEFAULT FALSE;

-- Update builder.routes.ts to allow these columns in POST/PATCH (I will do this in the code)
