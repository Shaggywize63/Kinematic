-- Per-segment scope for custom field definitions.
--
-- A lead form has a B2C branch and a B2B branch (is_b2c on the lead). Built-in
-- fields already scope per branch via crm_settings.config.field_overrides
-- (@b2c / @b2b), but custom fields had no such scope and therefore rendered on
-- BOTH branches. This column lets one client run distinct custom-field sets for
-- its two customer types — e.g. an agri client capturing FARMERS (B2C: crop,
-- land size, irrigation) vs DISTRIBUTORS/RETAILERS (B2B: GST, dealer licence,
-- categories handled) — without any per-client code.
--
--   'both' (default) → shown on every lead form (and all non-lead entities)
--   'b2c'            → shown only on the B2C branch
--   'b2b'            → shown only on the B2B branch
--
-- Backward-compatible: every existing row defaults to 'both', so current forms
-- are unchanged. Only meaningful for entity_type='lead'; ignored elsewhere
-- (contact/account/deal/activity have no B2C/B2B split).
--
-- Applied to the Kinematic project database ("kinematic" on the
-- kinematic-mumbai-test RDS instance) on 2026-10-03. Idempotent.
-- The backend reads crm_custom_field_defs with select('*') (not an explicit
-- column list), so any project DB that has NOT had this column added simply
-- treats every field as applies_to='both' — i.e. per-segment scoping is a
-- no-op there and nothing breaks. Only the Kinematic project uses per-segment
-- custom fields today, so the column is required only there.
ALTER TABLE crm_custom_field_defs
  ADD COLUMN IF NOT EXISTS applies_to text NOT NULL DEFAULT 'both';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_custom_field_defs_applies_to_chk'
  ) THEN
    ALTER TABLE crm_custom_field_defs
      ADD CONSTRAINT crm_custom_field_defs_applies_to_chk
      CHECK (applies_to IN ('both', 'b2c', 'b2b'));
  END IF;
END $$;
