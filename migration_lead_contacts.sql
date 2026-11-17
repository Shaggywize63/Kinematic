-- Spark & Ray: several customer contacts on one lead, with one marked primary (nodal).
-- Additive + idempotent. Applied at boot via exec_migration (PL/pgSQL EXECUTE) — so NO
-- top-level BEGIN/COMMIT. Gated to connected-B2B clients (Spark & Ray) in the API, so a
-- tenant whose database has run this file but is not a B2B client is never written.
-- After apply the runner issues: NOTIFY pgrst, 'reload schema';
--
-- Why a join table: a lead involves several people on the customer's team (GM / DGM / AGM /
-- procurement / senior manager). crm_contacts.lead_id holds only ONE lead per contact, so it
-- cannot express "several contacts on one lead, one of them primary". Each row here links a
-- lead to a contact; exactly one is is_primary (the nodal point, which changes over the deal),
-- with an optional free-text role. The requirement/plant stay on the lead; only the people vary.

CREATE TABLE IF NOT EXISTS public.crm_lead_contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  client_id   uuid,
  lead_id     uuid        NOT NULL REFERENCES public.crm_leads(id)    ON DELETE CASCADE,
  contact_id  uuid        NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  is_primary  boolean     NOT NULL DEFAULT false,
  role        text,                 -- free text: 'Procurement', 'DGM', 'Senior Manager', ...
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz
);

-- One live link per (lead, contact): re-adding the same person updates the row, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_lead_contacts_lead_contact
  ON public.crm_lead_contacts (lead_id, contact_id) WHERE deleted_at IS NULL;
-- At most one primary (nodal) contact per lead.
CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_lead_contacts_one_primary
  ON public.crm_lead_contacts (lead_id) WHERE is_primary AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_lead_contacts_lead    ON public.crm_lead_contacts (lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_lead_contacts_contact ON public.crm_lead_contacts (contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_lead_contacts_org     ON public.crm_lead_contacts (org_id);

-- RLS: the service-role backend (supabaseAdmin) bypasses RLS; enable it so no other role can
-- read, matching the sibling Spark tables (crm_lead_product_lines, crm_activity_assignees).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.crm_lead_contacts ENABLE ROW LEVEL SECURITY';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_lead_contacts TO authenticated, service_role';
END $$;

NOTIFY pgrst, 'reload schema';
