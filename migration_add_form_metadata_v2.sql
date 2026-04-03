-- Migration: Add Form Metadata for Advanced Logic
-- Run this in the Supabase SQL Editor

-- 1. For legacy compatibility
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS keyboard_type TEXT;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS image_count INTEGER DEFAULT 1;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS camera_only BOOLEAN DEFAULT false;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS depends_on_id TEXT;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS depends_on_value TEXT;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS is_consent BOOLEAN DEFAULT false;

-- 2. For the main Builder system
ALTER TABLE builder_questions ADD COLUMN IF NOT EXISTS keyboard_type TEXT;
ALTER TABLE builder_questions ADD COLUMN IF NOT EXISTS image_count INTEGER DEFAULT 1;
ALTER TABLE builder_questions ADD COLUMN IF NOT EXISTS camera_only BOOLEAN DEFAULT false;
ALTER TABLE builder_questions ADD COLUMN IF NOT EXISTS depends_on_id TEXT;
ALTER TABLE builder_questions ADD COLUMN IF NOT EXISTS depends_on_value TEXT;
ALTER TABLE builder_questions ADD COLUMN IF NOT EXISTS is_consent BOOLEAN DEFAULT false;

-- Index for performance on conditional lookups
CREATE INDEX IF NOT EXISTS idx_builder_questions_depends_on_id ON builder_questions(depends_on_id);
