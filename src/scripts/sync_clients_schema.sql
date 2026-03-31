-- 1. Add missing contact_person column to clients
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS contact_person TEXT;

-- 2. Populate validated module permissions for user 3456789012
INSERT INTO public.user_module_permissions (user_id, module_id)
SELECT '06a5e354-c2fb-4f18-8c11-1bf0e05a21b9', m.id
FROM (
  SELECT unnest(ARRAY['analytics', 'inventory', 'users', 'reports']) AS id
) m
ON CONFLICT (user_id, module_id) DO NOTHING;
