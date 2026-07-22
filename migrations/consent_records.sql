-- =============================================================================
-- Consent ledger — DPDP §6 (consent) / §7 (legitimate uses) / §9 (parental).
-- =============================================================================
-- Records a demonstrable, itemised, per-purpose consent event for a data
-- principal (a CRM lead/contact, or an employee). The existing marketing_consent
-- / whatsapp_consent booleans on crm_leads/crm_contacts prove neither WHO
-- captured consent, WHEN, HOW, nor FOR WHICH purpose — this ledger does, mirroring
-- the call-recording consent pattern (conversation_recordings.consent_*) and
-- generalising it to every collection purpose.
--
-- A row is an immutable event: to withdraw consent (§6(4)-(6)) we stamp
-- withdrawn_at rather than delete, preserving the audit trail. `subject_id` is
-- nullable so consent captured at a form BEFORE the lead row exists can be linked
-- afterwards (by source/token).
--
-- Apply to BOTH Supabase projects (Tata `lnvxqjqfsxvtjvbzphou` + Kinematic
-- `clldjlojtmrrpozydqxk`). Service-role only → RLS on, no policy = deny.
-- =============================================================================

create table if not exists crm_consents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  client_id     uuid,

  subject_type  text not null check (subject_type in ('lead','contact','employee')),
  subject_id    uuid,                         -- nullable: may be linked after creation

  -- Itemised purpose, e.g. 'lead_pii' | 'marketing' | 'whatsapp' |
  -- 'gps_tracking' | 'attendance_selfie' | 'call_recording' | 'parental_guardian'
  purpose       text not null,
  consented     boolean not null default true,

  method        text not null check (method in ('in_app','web_form','verbal','imported','api')),
  source        text,                          -- screen / form / campaign that captured it
  notice_version text,                         -- which notice/policy version was shown
  actor_user_id uuid,                          -- staff member who captured it (null = self-serve)
  notes         text,

  created_at    timestamptz not null default now(),
  withdrawn_at  timestamptz,                   -- set on withdrawal (§6(4)-(6))
  withdrawn_by  uuid
);

comment on table crm_consents is 'DPDP §6/§7/§9 consent ledger: itemised, per-purpose, withdrawable consent events.';

-- Fast lookup of the current consent state for a subject+purpose.
create index if not exists ix_crm_consents_subject
  on crm_consents (org_id, subject_type, subject_id, purpose);
create index if not exists ix_crm_consents_active
  on crm_consents (org_id, subject_type, subject_id, purpose) where withdrawn_at is null;

alter table crm_consents enable row level security;  -- deny-by-default; service-role bypasses
