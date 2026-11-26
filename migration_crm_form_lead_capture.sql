-- Per-form "create a CRM lead on submit" toggle (Maa Mansha Pharma lead capture).
-- Additive + idempotent. When true, submitForm maps the submission's answers
-- (by each question's prefill_key / type) into a crm_lead. Default false, so no
-- existing form or tenant changes behaviour.
ALTER TABLE public.builder_forms
  ADD COLUMN IF NOT EXISTS create_lead_on_submit boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
