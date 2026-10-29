-- Admin edit of submitted reports: audit support for PATCH /forms/submissions/:id.
-- Additive + idempotent. form_submissions already has updated_at; add updated_by
-- and a per-change history table mirroring crm_lead_history / crm_deal_history.

BEGIN;

ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS updated_by uuid;

CREATE TABLE IF NOT EXISTS public.form_submission_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.form_submissions(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL,
  client_id     uuid,
  field         text,          -- a form_responses field_id, or a submission column name
  field_label   text,          -- human label when known (the builder_questions label)
  old_value     text,
  new_value     text,
  changed_by    uuid,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_sub_history_submission ON public.form_submission_history (submission_id);
CREATE INDEX IF NOT EXISTS idx_form_sub_history_org_time   ON public.form_submission_history (org_id, changed_at);

-- Mirror the tenant_isolation convention used by form_submissions / crm_* : RLS
-- on with an org_id policy (the service-role backend bypasses it), grants to
-- authenticated + service_role. Append-only, so no updated_at trigger.
ALTER TABLE public.form_submission_history ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation'
                 AND polrelid = 'public.form_submission_history'::regclass) THEN
    CREATE POLICY tenant_isolation ON public.form_submission_history
      USING (org_id = ((( SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid)
      WITH CHECK (org_id = ((( SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid);
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.form_submission_history TO authenticated, service_role;

COMMIT;
