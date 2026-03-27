-- Migration to add visitor_role and visitor_name to visit_logs
-- This allows FEs to log visits FROM specific roles themselves.

ALTER TABLE IF EXISTS visit_logs 
  ADD COLUMN IF NOT EXISTS visitor_role TEXT,
  ADD COLUMN IF NOT EXISTS visitor_name TEXT;

-- Update indices
CREATE INDEX IF NOT EXISTS idx_visit_logs_visitor_role ON visit_logs(visitor_role);
