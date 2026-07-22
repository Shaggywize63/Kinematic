-- =============================================================================
-- Nominee register — DPDP §14 (right to nominate).
-- =============================================================================
-- DPDP §14 lets a Data Principal nominate another individual to exercise their
-- rights in the event of the principal's death or incapacity. This records that
-- nomination against a subject (lead/contact/employee). Since data principals do
-- not have a self-service login here, nominations are captured by authorised
-- staff on the principal's instruction (actor_user_id), mirroring the consent
-- ledger. A nomination is withdrawable (revoked_at) rather than deleted.
--
-- Apply to BOTH Supabase projects (Tata `lnvxqjqfsxvtjvbzphou` + Kinematic
-- `clldjlojtmrrpozydqxk`). Service-role only → RLS on, no policy = deny.
-- =============================================================================

create table if not exists crm_nominees (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  client_id     uuid,

  subject_type  text not null check (subject_type in ('lead','contact','employee')),
  subject_id    uuid not null,

  nominee_name         text not null,
  nominee_relationship text,
  nominee_contact      text,               -- phone / email of the nominee

  actor_user_id uuid,                       -- staff member who captured it
  notes         text,

  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid
);

comment on table crm_nominees is 'DPDP §14 nominee register: a nominee to exercise a Data Principal''s rights on death/incapacity.';

create index if not exists ix_crm_nominees_subject
  on crm_nominees (org_id, subject_type, subject_id) where revoked_at is null;

alter table crm_nominees enable row level security;  -- deny-by-default; service-role bypasses
