-- Account location columns. The Kinematic tenant's crm_accounts was created without them, so a save that included
-- an address failed with "Could not find the 'address_line1' column of 'crm_accounts' in the schema cache".
-- Additive and idempotent. Run, then: NOTIFY pgrst, 'reload schema';
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS address_line2 text;
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS city          text;
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS state         text;
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS postal_code   text;
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS country       text DEFAULT 'India';
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS email         text;

-- Accounts created while a column was missing kept what the rep typed in custom_fields.location; copy it across.
UPDATE public.crm_accounts a SET
  address_line1 = COALESCE(a.address_line1, a.custom_fields #>> '{location,address_line1}'),
  address_line2 = COALESCE(a.address_line2, a.custom_fields #>> '{location,address_line2}'),
  city          = COALESCE(a.city,          a.custom_fields #>> '{location,city}'),
  state         = COALESCE(a.state,         a.custom_fields #>> '{location,state}'),
  postal_code   = COALESCE(a.postal_code,   a.custom_fields #>> '{location,postal_code}'),
  country       = COALESCE(a.country,       a.custom_fields #>> '{location,country}'),
  email         = COALESCE(a.email,         a.custom_fields #>> '{location,email}')
WHERE a.custom_fields ? 'location';

NOTIFY pgrst, 'reload schema';
