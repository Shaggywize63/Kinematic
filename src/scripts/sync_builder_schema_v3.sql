-- Synchronize builder_questions schema with latest Form Builder features
-- Resolves: "Could not find the 'camera_only' column" error

ALTER TABLE builder_questions 
  ADD COLUMN IF NOT EXISTS keyboard_type TEXT DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS image_count INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS camera_only BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS depends_on_id UUID REFERENCES builder_questions(id),
  ADD COLUMN IF NOT EXISTS depends_on_value TEXT,
  ADD COLUMN IF NOT EXISTS is_consent BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_config JSONB DEFAULT '{}';

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
