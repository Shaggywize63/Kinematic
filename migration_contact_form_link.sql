-- Connect a builder form to a contact's requirement (B2B lead capture).
--
-- Each person logged on a B2B lead ("Contacts & requirements") can reference a
-- builder form so the requirement stays connected to the form that captures it.
-- Additive + idempotent: a nullable FK to builder_forms, no change to existing
-- rows or to any non-B2B flow (the column is simply left null).
--
-- Apply with the documented one-off Fargate psql pattern (pre-check → -1 apply →
-- verify → NOTIFY pgrst). See Kinematic/CLAUDE.md "Running SQL / migrations".

ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS form_id uuid REFERENCES builder_forms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_form ON crm_contacts(form_id);

-- PostgREST caches the schema; reload it so the new column is queryable.
NOTIFY pgrst, 'reload schema';
