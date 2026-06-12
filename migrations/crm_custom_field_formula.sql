-- Add formula support to crm_custom_field_defs.
--
-- A custom field with field_type='formula' carries a `formula`
-- expression (a string) that the backend evaluates on every read of
-- the parent entity, stamping the computed value into the entity's
-- custom_fields JSONB. The supported language is arithmetic
-- (+, -, *, /, parentheses) plus the four functions IF / MIN / MAX /
-- ROUND, with {field_key} references to other custom fields.
--
-- Example: total_revenue = {price} * {qty}
--          tier         = IF({total} > 100000, 1, 0)
--          margin       = ROUND(({revenue} - {cost}) / {revenue} * 100, 1)

ALTER TABLE public.crm_custom_field_defs
  ADD COLUMN IF NOT EXISTS formula TEXT;
