-- Create migration to add FE feedback to visit_logs
-- This file should be executed in the Supabase SQL editor.

-- Add executive_id to track who was visited
ALTER TABLE IF EXISTS visit_logs 
  ADD COLUMN IF NOT EXISTS executive_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Add columns for FE feedback
ALTER TABLE IF EXISTS visit_logs 
  ADD COLUMN IF NOT EXISTS fe_feedback TEXT,
  ADD COLUMN IF NOT EXISTS fe_feedback_at TIMESTAMPTZ;

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_visit_logs_executive ON visit_logs(executive_id);
