-- ── Organization Entity Name Update ───────────────────────────

-- Update organization name from Hindustan Field Co. to Horizonn Tech Studio
UPDATE public.organisations 
SET name = 'Horizonn Tech Studio' 
WHERE name = 'Hindustan Field Co.';

-- Verify the update
SELECT id, name FROM public.organisations WHERE name = 'Horizonn Tech Studio';
