-- Register the Face-Recognition Attendance module in the catalog.
--
-- Non-universal + granted to NO client here = OFF by default for every tenant.
-- A master admin turns it on per client from the dashboard Clients page (which
-- writes a `client_modules` row), and requireModule('face_attendance') + the
-- dashboard sidebar + both mobile apps then read it via the enabled_modules
-- entitlement. Idempotent — safe to re-run. Apply to every Supabase project
-- the backend serves (default/Tata + kinematic).
insert into modules (id, name, description, package, is_universal)
values (
  'face_attendance',
  'Face Attendance',
  'Face-recognition selfie verification for attendance check-in / check-out (on-device 1:1 match).',
  'field_force',
  false
)
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  package     = excluded.package,
  is_universal = excluded.is_universal;
