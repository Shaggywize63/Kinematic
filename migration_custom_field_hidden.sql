-- Adds a `hidden` boolean column to crm_custom_field_defs so admins can
-- toggle individual custom fields off (drop from create / edit forms)
-- without deleting them — values already stored on records are preserved
-- and flipping back on restores the field in the UI. Mirrors the same
-- `hidden` flag the field-override system supports for built-in fields
-- (kept in crm_settings.config.field_overrides).
--
-- Default is false so existing rows keep their current behaviour.

ALTER TABLE public.crm_custom_field_defs
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
