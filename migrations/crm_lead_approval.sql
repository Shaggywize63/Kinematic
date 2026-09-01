-- CRM — lead approval workflow
--
-- Leads captured by a FIELD REP now enter a 'pending' approval state and notify
-- the rep's manager (their supervisor, else an admin in the org); a manager then
-- approves or rejects from the dashboard. Admin/system/inbound-created leads
-- default to 'approved', so every existing flow (imports, web forms, WhatsApp,
-- admin-created leads) is unchanged.
--
--   approval_status        pending | approved | rejected  (default 'approved')
--   approval_requested_by  the rep who captured a pending lead
--   approved_by/at         who decided, and when
--
-- Notifications reuse the existing `general` notification_type with a
-- data.kind discriminator ('lead_pending_approval' / 'lead_approval_decided'),
-- so no enum change is needed.
--
-- Applied to Kinematic (clldjlojtmrrpozydqxk) via apply_migration
-- `crm_lead_approval`. Apply to Tata before enabling there.

ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS approval_status       text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approval_requested_by uuid,
  ADD COLUMN IF NOT EXISTS approved_by           uuid,
  ADD COLUMN IF NOT EXISTS approved_at           timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_leads_approval_status_chk') THEN
    ALTER TABLE public.crm_leads
      ADD CONSTRAINT crm_leads_approval_status_chk
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_leads_approval
  ON public.crm_leads (org_id, approval_status);
