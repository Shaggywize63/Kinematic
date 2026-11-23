-- Reference documents attached to a CRM account (price lists, contracts, spec sheets, etc).
-- There was previously no file-attachment feature anywhere on clients/accounts in this codebase —
-- only text notes/updates, or metadata-only "document" rows on HRMS/candidates with no real file behind them.
--
-- The actual bytes reuse the EXISTING private-storage pipeline, not a new bucket:
--   upload:  POST /api/v1/upload/material   (already accepts application/pdf, BUCKET_MATERIALS, private)
--   read:    GET  /api/v1/media/sign         (already signs objects in BUCKET_MATERIALS, tenant-safe by
--                                              the org_id/user_id path prefix — see media.controller.ts)
-- This table only stores the metadata linking an uploaded object to an account.
--
-- Additive + idempotent. NOT applied automatically: the operator runs it, then NOTIFY pgrst, 'reload schema'
-- (deliberately not part of this file). Conventions mirrored from migration_makes_brands.sql.
--
-- Until this is applied the API answers 503 NOT_MIGRATED on the account documents routes; everything
-- else on the account page is unaffected.

BEGIN;

CREATE TABLE IF NOT EXISTS public.crm_account_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  client_id   uuid,
  account_id  uuid        NOT NULL REFERENCES public.crm_accounts(id),
  name        text        NOT NULL,
  file_name   text        NOT NULL,
  content_type text,
  size_bytes  bigint,
  bucket      text        NOT NULL,
  path        text        NOT NULL,
  uploaded_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_account_documents_account ON public.crm_account_documents (account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_account_documents_org     ON public.crm_account_documents (org_id);

ALTER TABLE public.crm_account_documents ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation'
                 AND polrelid = 'public.crm_account_documents'::regclass) THEN
    CREATE POLICY tenant_isolation ON public.crm_account_documents
      USING (org_id = (((SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid)
      WITH CHECK (org_id = (((SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid);
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_account_documents TO authenticated, service_role;

COMMIT;
