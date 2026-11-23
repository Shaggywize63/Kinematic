-- Reference documents attached to a `clients` row (e.g. a client's own product price list) — managed
-- by Kinematic's platform admins from Client Management, not by the client's own staff.
--
-- There was previously no file-attachment feature anywhere on `clients` in this codebase — only
-- text notes/updates on CRM accounts (a different entity: a tenant's own customers), or metadata-only
-- "document" rows on HRMS/candidates with no real file behind them.
--
-- The actual bytes reuse the EXISTING private-storage pipeline, not a new bucket:
--   upload:  POST /api/v1/upload/material   (already accepts application/pdf, BUCKET_MATERIALS, private)
--   read:    GET  /api/v1/media/sign         (already signs objects in BUCKET_MATERIALS, tenant-safe by
--                                              the org_id/user_id path prefix — see media.controller.ts)
-- This table only stores the metadata linking an uploaded object to a client.
--
-- Unlike crm_account_documents (migration_crm_account_documents.sql), this is NOT scoped by the calling
-- admin's own org_id/client-id filters the way CRM sub-resources are — Client Management routes already
-- operate directly by `clients.id` (see getClientModules et al.), so this table does the same.
--
-- Additive + idempotent. NOT applied automatically: the operator runs it, then NOTIFY pgrst, 'reload schema'
-- (deliberately not part of this file).
--
-- Until this is applied the API answers 503 NOT_MIGRATED on the client documents routes; everything
-- else in Client Management is unaffected.

BEGIN;

CREATE TABLE IF NOT EXISTS public.client_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        NOT NULL REFERENCES public.clients(id),
  org_id      uuid,
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

CREATE INDEX IF NOT EXISTS idx_client_documents_client ON public.client_documents (client_id) WHERE deleted_at IS NULL;

ALTER TABLE public.client_documents ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'service_role_only'
                 AND polrelid = 'public.client_documents'::regclass) THEN
    -- Client Management is platform-admin-only and always goes through supabaseAdmin (service_role,
    -- which bypasses RLS). No authenticated-role policy is defined on purpose: a client's own login
    -- (role `client`) has no business reading another client's documents, and this table carries no
    -- org_id-based tenant_isolation policy to check against anyway (org_id here is informational).
    CREATE POLICY service_role_only ON public.client_documents
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_documents TO service_role;

COMMIT;
