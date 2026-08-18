-- Face-recognition attendance (on-device 1:1 match).
--
-- The apps capture a front-camera selfie (already wired), compute a face
-- embedding ON-DEVICE (iOS Core ML / Android TFLite), and:
--   • enrol once  -> store the reference embedding here
--   • each check-in -> re-embed, fetch the reference, cosine-compare on-device,
--     and send {face_score, face_verified} alongside the existing check-in.
-- The backend stays model-agnostic: it stores the embedding + the model id that
-- produced it, and only ever compares embeddings sharing the same model id
-- (enforced app-side). A rep who switches platform/model simply re-enrols.
--
-- Additive + nullable only; existing check-in/out behaviour is unchanged when
-- face verification is off. Apply to every Supabase project the backend serves
-- (default/Tata + kinematic).

-- 1. Reference enrolment: one active reference face per user.
create table if not exists public.user_face_enrollments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  client_id     uuid,
  user_id       uuid not null,
  embedding     jsonb not null,                 -- float[] feature vector
  embedding_dim int  not null,                  -- e.g. 128 / 192 / 512
  model_id      text not null,                  -- e.g. 'mobilefacenet_v1'
  selfie_url    text,                           -- reference selfie (private bucket)
  quality_score numeric,                        -- optional capture-quality 0..1
  is_active     boolean not null default true,
  enrolled_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One active enrolment per user (re-enrol replaces via upsert).
create unique index if not exists uq_face_enrollment_user_active
  on public.user_face_enrollments (user_id) where is_active;
create index if not exists ix_face_enrollment_org on public.user_face_enrollments (org_id);

-- Apps reach the DB only through the backend (service role), so lock the table
-- to the service role: RLS on, no anon/authenticated policies.
alter table public.user_face_enrollments enable row level security;

-- 2. Verification result stamped on the attendance row at check-in/out.
alter table public.attendance
  add column if not exists checkin_face_verified  boolean,
  add column if not exists checkin_face_score      numeric,
  add column if not exists checkout_face_verified  boolean,
  add column if not exists checkout_face_score      numeric,
  add column if not exists face_model_id            text;

comment on table  public.user_face_enrollments is 'Reference face embedding per user for on-device 1:1 attendance match.';
comment on column public.attendance.checkin_face_score is 'Cosine similarity (0..1) of the check-in selfie vs the enrolled reference, computed on-device.';
