-- Conversation Intelligence — a rep records a customer conversation, we transcribe
-- it (Sarvam Saarika, with speaker diarization), analyze it with Claude (Sonnet 5),
-- and store structured insights on the lead. Consent is mandatory and captured on
-- the row (DPDP). Tenant-agnostic (org_id + client_id scoped) so it can be enabled
-- for any client; currently gated to Tata Tiscon via the `conversation_intel`
-- module (see conversation_intel_module.sql / entitlement).
--
-- Applied to BOTH Supabase projects (Tata `lnvxqjqfsxvtjvbzphou` +
-- Kinematic `clldjlojtmrrpozydqxk`). Service-role only → RLS on, no policy = deny.

create table if not exists conversation_recordings (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  client_id     uuid,
  lead_id       uuid not null references crm_leads(id) on delete cascade,
  user_id       uuid not null,                 -- the rep (Consumer Champion)

  -- Consent (DPDP) — a recording cannot be processed without it.
  consent_captured boolean not null default false,
  consent_method   text,                        -- 'in_app' | 'verbal'
  consent_at       timestamptz,

  -- Audio
  audio_path       text,                         -- storage object path (private bucket)
  duration_seconds integer,
  language         text,                         -- detected/requested language code

  -- Pipeline state: recorded → uploaded → transcribing → analyzing → complete | failed
  status        text not null default 'recorded'
                check (status in ('recorded','uploaded','transcribing','analyzing','complete','failed')),
  error         text,

  -- Results
  transcript    text,                            -- plain transcript
  diarization   jsonb,                           -- [{speaker, text, start, end}]
  insights      jsonb,                           -- structured analysis (see conversationInsights.service)
  sarvam_job_id text,                            -- Sarvam batch job id (for re-poll/debug)

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_conv_rec_lead    on conversation_recordings(lead_id, created_at desc);
create index if not exists idx_conv_rec_user     on conversation_recordings(org_id, user_id, created_at desc);
create index if not exists idx_conv_rec_org      on conversation_recordings(org_id, created_at desc);
create index if not exists idx_conv_rec_status   on conversation_recordings(status) where status not in ('complete','failed');

alter table conversation_recordings enable row level security;
