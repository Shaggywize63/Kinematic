-- Rename ambiguous constraints to unique names to resolve PostgREST ambiguity
-- Current constraints 'form_templates' and 'form_fields' collide with old table names.

DO $$ 
BEGIN
    -- 1. Rename constraint on form_submissions
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints 
               WHERE constraint_name = 'form_templates' AND table_name = 'form_submissions') THEN
        ALTER TABLE form_submissions RENAME CONSTRAINT form_templates TO fk_submission_template;
    END IF;

    -- 2. Rename constraint on form_responses
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints 
               WHERE constraint_name = 'form_fields' AND table_name = 'form_responses') THEN
        ALTER TABLE form_responses RENAME CONSTRAINT form_fields TO fk_response_field;
    END IF;
END $$;
