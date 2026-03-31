-- Manually creating the missing profile for user '3456789012'
INSERT INTO public.users (id, name, mobile, role, org_id)
VALUES (
  '06a5e354-c2fb-4f18-8c11-1bf0e05a21b9', 
  'sub admin', 
  '3456789012', 
  'sub_admin', 
  (SELECT id FROM public.organizations LIMIT 1)
)
ON CONFLICT (id) DO UPDATE SET 
  name = EXCLUDED.name,
  mobile = EXCLUDED.mobile,
  role = EXCLUDED.role;
