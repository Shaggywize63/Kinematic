-- Form Builder Performance Optimization Indexes
-- These indexes prevent Full Table Scans when joining or filtering across the form builder schema.

-- builder_forms
CREATE INDEX IF NOT EXISTS idx_builder_forms_org_id ON builder_forms(org_id);
CREATE INDEX IF NOT EXISTS idx_builder_forms_activity_id ON builder_forms(activity_id);
CREATE INDEX IF NOT EXISTS idx_builder_forms_status ON builder_forms(status);

-- builder_pages
CREATE INDEX IF NOT EXISTS idx_builder_pages_form_id ON builder_pages(form_id);

-- builder_questions
CREATE INDEX IF NOT EXISTS idx_builder_questions_form_id ON builder_questions(form_id);
CREATE INDEX IF NOT EXISTS idx_builder_questions_page_id ON builder_questions(page_id);

-- form_submissions
CREATE INDEX IF NOT EXISTS idx_form_submissions_org_id ON form_submissions(org_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_user_id ON form_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_template_id ON form_submissions(template_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_activity_id ON form_submissions(activity_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_outlet_id ON form_submissions(outlet_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_date ON form_submissions(date);
CREATE INDEX IF NOT EXISTS idx_form_submissions_submitted_at ON form_submissions(submitted_at);

-- form_responses
CREATE INDEX IF NOT EXISTS idx_form_responses_submission_id ON form_responses(submission_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_field_id ON form_responses(field_id);
