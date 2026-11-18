-- Co-owners (additional owners) on a CRM lead / account / contact / deal.
-- Additive + idempotent. Applied at boot via exec_migration (PL/pgSQL EXECUTE) — so NO top-level
-- BEGIN/COMMIT. After apply the runner issues: NOTIFY pgrst, 'reload schema';
--
-- The record keeps its single PRIMARY owner on <table>.owner_id (unchanged). This table adds any
-- number of CO-owners — peers who also see the record in their lists and reports — without touching
-- owner_id. One shared table across the four entity types (entity_type + entity_id), so the backend
-- resolves "records I co-own" and "co-owners of this record" with one query each.

CREATE TABLE IF NOT EXISTS public.crm_record_owners (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  client_id   uuid,
  entity_type text        NOT NULL,          -- 'lead' | 'account' | 'contact' | 'deal'
  entity_id   uuid        NOT NULL,
  user_id     uuid        NOT NULL,          -- a co-owner (never the primary owner_id)
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  deleted_at  timestamptz
);

-- entity_type is one of four values. Added idempotently (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'crm_record_owners_entity_type_check' AND conrelid = 'public.crm_record_owners'::regclass) THEN
    ALTER TABLE public.crm_record_owners
      ADD CONSTRAINT crm_record_owners_entity_type_check
      CHECK (entity_type IN ('lead', 'account', 'contact', 'deal'));
  END IF;
END $$;

-- One live co-owner row per (entity, user): re-adding the same person is a no-op, never a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_record_owners_entity_user
  ON public.crm_record_owners (entity_type, entity_id, user_id) WHERE deleted_at IS NULL;
-- "records of type T that user U co-owns" — the read-scope widening.
CREATE INDEX IF NOT EXISTS idx_crm_record_owners_user
  ON public.crm_record_owners (org_id, user_id, entity_type) WHERE deleted_at IS NULL;
-- "co-owners of this record".
CREATE INDEX IF NOT EXISTS idx_crm_record_owners_entity
  ON public.crm_record_owners (entity_type, entity_id) WHERE deleted_at IS NULL;

-- RLS: the service-role backend (supabaseAdmin) bypasses RLS; enable it so no other role can read,
-- matching the sibling Spark tables (crm_lead_contacts, crm_activity_assignees).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.crm_record_owners ENABLE ROW LEVEL SECURITY';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_record_owners TO authenticated, service_role';
END $$;

NOTIFY pgrst, 'reload schema';
