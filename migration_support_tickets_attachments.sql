-- Support tickets: screenshots (and other images) attached when the ticket is raised.
--
-- Each entry is { path, bucket, name, size, content_type, uploaded_at }. The files live in the
-- SUPPORT project's own private bucket, never the customer's, so that both the customer (whose
-- data may be in any project) and a platform operator (who works in the Kinematic project) can be
-- served a signed URL for the same object. See services/support/supportAttachments.ts.
--
-- Additive and idempotent. Kinematic project only (every ticket lives in SUPPORT_PROJECT).
BEGIN;

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

-- An array, always: the service reads it with .map(), so an object here would throw at runtime.
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_attachments_check;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_attachments_check
  CHECK (jsonb_typeof(attachments) = 'array');

COMMIT;
NOTIFY pgrst, 'reload schema';
