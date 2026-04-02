-- Fix Zone Unique Constraint to allow multiple clients to have zones with same names
-- Existing constraint was too strict (org_id + name), blocking different clients from using common names like 'North'

ALTER TABLE public.zones DROP CONSTRAINT IF EXISTS zones_org_id_name_key;

-- Create a more flexible index that includes client_id context
-- This ensures name uniqueness within the same organization AND the same client
-- Null client_id (generic org zones) are still treated collectively as one 'null client'
CREATE UNIQUE INDEX IF NOT EXISTS zones_org_client_name_unique_idx ON public.zones (
  org_id, 
  name, 
  (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
);

COMMENT ON INDEX zones_org_client_name_unique_idx IS 'Ensures zone names are unique for each client within an organization.';
