-- Renaming fe_feedback columns to visit_response to resolve naming collisions in PostgREST
-- This should be executed in the Supabase SQL editor.

ALTER TABLE visit_logs 
  RENAME COLUMN fe_feedback TO visit_response;

ALTER TABLE visit_logs 
  RENAME COLUMN fe_feedback_at TO visit_response_at;

-- The index idx_visit_logs_executive (on executive_id) remains valid.
-- Any additional views or triggers using these columns should be updated or refreshed.
-- NOTIFY pgrst, 'reload schema';
