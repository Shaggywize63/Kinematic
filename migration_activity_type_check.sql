-- Custom activity types. crm_activities.type was created with CHECK (type IN ('call','email','meeting','task','note',
-- 'sms','whatsapp')), so an activity of an admin-defined type (Settings -> Activity types) failed with
--   new row for relation "crm_activities" violates check constraint "crm_activities_type_check".
-- Replace it with a format check (the same shape the API accepts), then move rows the API saved under a carrier type
-- (type 'note' + metadata.activity_type, see src/services/crm/activityTypeFallback.ts) back to their real type.
-- Additive in effect, idempotent. After it runs: NOTIFY pgrst, 'reload schema';
ALTER TABLE public.crm_activities DROP CONSTRAINT IF EXISTS crm_activities_type_check;
ALTER TABLE public.crm_activities
  ADD CONSTRAINT crm_activities_type_check CHECK (type ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$');

UPDATE public.crm_activities
   SET type = metadata::jsonb ->> 'activity_type'
 WHERE type = 'note'
   AND metadata IS NOT NULL
   AND (metadata::jsonb ->> 'activity_type') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$';

NOTIFY pgrst, 'reload schema';
