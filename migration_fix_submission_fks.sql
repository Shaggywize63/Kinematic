-- Robust migration to fix foreign key constraints for forms
-- This script drops ALL existing FKs on the target tables first to avoid naming/dependency issues.

DO $$ 
DECLARE 
    r RECORD;
BEGIN
    -- 1. Drop ALL foreign keys on form_responses
    FOR r IN (SELECT constraint_name 
              FROM information_schema.table_constraints 
              WHERE table_name = 'form_responses' 
              AND constraint_type = 'FOREIGN KEY') 
    LOOP
        EXECUTE 'ALTER TABLE form_responses DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;

    -- 2. Drop ALL foreign keys on form_submissions
    FOR r IN (SELECT constraint_name 
              FROM information_schema.table_constraints 
              WHERE table_name = 'form_submissions' 
              AND constraint_type = 'FOREIGN KEY') 
    LOOP
        EXECUTE 'ALTER TABLE form_submissions DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
END $$;

-- 3. Add the correct foreign keys
-- Link form_submissions to builder_forms
ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_template_id_fkey 
    FOREIGN KEY (template_id) REFERENCES builder_forms(id) ON DELETE CASCADE;

-- Link form_submissions to users
ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Link form_submissions to activities
ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_activity_id_fkey 
    FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE;

-- Link form_responses to form_submissions
ALTER TABLE form_responses ADD CONSTRAINT form_responses_submission_id_fkey 
    FOREIGN KEY (submission_id) REFERENCES form_submissions(id) ON DELETE CASCADE;

-- Link form_responses to builder_questions (using field_id)
ALTER TABLE form_responses ADD CONSTRAINT form_responses_field_id_fkey 
    FOREIGN KEY (field_id) REFERENCES builder_questions(id) ON DELETE CASCADE;

-- 4. Ensure metadata columns exist in form_submissions
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS outlet_id UUID REFERENCES stores(id);
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS gps TEXT;

-- 5. Ensure gps column exists in form_responses
ALTER TABLE form_responses ADD COLUMN IF NOT EXISTS gps TEXT;
