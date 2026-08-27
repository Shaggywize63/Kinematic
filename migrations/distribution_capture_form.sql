-- Distribution / Consumer Capture — configurable QR-page form
--
-- Lets an admin design the public /s/<token> registration form: enable / disable
-- / relabel the built-in fields (name, product, email, vehicle/serial) and add
-- custom fields (text / number / dropdown). One form per tenant (org), applied to
-- every outlet's QR page. Custom-field answers are stored on the registration in
-- `capture_extra` and folded into the auto-created CRM lead's notes so sales can
-- act on them.
--
-- `distribution_capture_config.fields` is an ordered jsonb array of:
--   { key, label, type, enabled, required, builtin, options? }
-- Built-in keys map to registration columns (consumer_name, consumer_email,
-- sku_id, vehicle_reg); custom keys (cf_*) land in capture_extra. Phone is always
-- present + required and is NOT part of this list.
--
-- Applied to Kinematic (clldjlojtmrrpozydqxk) via apply_migration
-- `distribution_capture_form`. Apply the SAME migration to Tata
-- (lnvxqjqfsxvtjvbzphou) before enabling consumer capture for that tenant.

CREATE TABLE IF NOT EXISTS public.distribution_capture_config (
  org_id     uuid PRIMARY KEY,
  client_id  uuid,
  fields     jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Service-role only (all access is via the Express backend); no anon policy.
ALTER TABLE public.distribution_capture_config ENABLE ROW LEVEL SECURITY;

-- Custom-field answers captured on the public page, keyed by field label.
ALTER TABLE public.distribution_consumer_registrations
  ADD COLUMN IF NOT EXISTS capture_extra jsonb;
