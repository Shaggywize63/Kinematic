-- Migration to fix foreign keys for form submissions
-- This ensures that submissions and responses point to the new Form Builder tables

-- 1. Fix template_id in form_submissions to point to builder_forms
ALTER TABLE form_submissions DROP CONSTRAINT IF EXISTS form_submissions_template_id_fkey;
ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_template_id_fkey 
    FOREIGN KEY (template_id) REFERENCES builder_forms(id) ON DELETE CASCADE;

-- 2. Fix field_id in form_responses to point to builder_questions
ALTER TABLE form_responses DROP CONSTRAINT IF EXISTS form_responses_question_id_fkey;
ALTER TABLE form_responses DROP CONSTRAINT IF EXISTS form_responses_field_id_fkey;
ALTER TABLE form_responses ADD CONSTRAINT form_responses_field_id_fkey 
    FOREIGN KEY (field_id) REFERENCES builder_questions(id) ON DELETE CASCADE;

-- 3. Ensure outlet_id exists and points to stores(id)
-- First check if it exists, if not add it. Then fix the FK.
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS outlet_id UUID;

ALTER TABLE form_submissions DROP CONSTRAINT IF EXISTS form_submissions_outlet_id_fkey;
ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_outlet_id_fkey 
    FOREIGN KEY (outlet_id) REFERENCES stores(id) ON DELETE SET NULL;
