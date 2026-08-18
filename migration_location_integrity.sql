-- GPS-spoof / location-integrity signals.
--
-- The apps already detect mock GPS (Android Location.isMock, iOS
-- isSimulatedBySoftware) and report a violation to /misc/security/alert, but
-- nothing persists the per-fix integrity signal for analysis, and there is no
-- server-side teleport check. This adds:
--   • the client-reported mock flag + horizontal accuracy on every ping and
--     on the attendance check-in/out fix, and
--   • a server-derived `is_suspect` flag + reason (set by the heartbeat handler
--     when a ping teleports at an impossible speed vs the previous fix).
--
-- Additive + nullable only — existing check-in / heartbeat behaviour is
-- unchanged when the apps don't send the new fields. Apply to every Supabase
-- project the backend serves (default/Tata + kinematic).

alter table public.work_activity
  add column if not exists is_mock       boolean,
  add column if not exists accuracy_m    numeric,
  add column if not exists is_suspect    boolean,
  add column if not exists suspect_reason text;

alter table public.attendance
  add column if not exists checkin_is_mock     boolean,
  add column if not exists checkin_accuracy_m  numeric,
  add column if not exists checkout_is_mock    boolean,
  add column if not exists checkout_accuracy_m numeric;

comment on column public.work_activity.is_suspect is 'Server-flagged: this ping teleported at an impossible speed vs the previous fix (likely spoof).';
