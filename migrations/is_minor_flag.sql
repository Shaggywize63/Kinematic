-- =============================================================================
-- Children's-data flag — DPDP §9.
-- =============================================================================
-- Persists, at capture time, whether a lead/contact was identified as a child
-- (< 18) from their date_of_birth. Derivable from DOB, but stored so that:
--   * marketing / campaign / bulk-outreach queries can EXCLUDE minors even when
--     DOB is later hidden by data-minimisation, and
--   * the dashboard can flag the record and prompt for verifiable parental
--     consent (§9(1)).
-- The scoring/LLM-rerank pipeline also excludes any row with is_minor = true
-- (no behavioural monitoring §9(3) / targeted profiling §9(4)).
--
-- Apply to BOTH Supabase projects (Tata `lnvxqjqfsxvtjvbzphou` + Kinematic
-- `clldjlojtmrrpozydqxk`). Idempotent.
-- =============================================================================

alter table crm_leads    add column if not exists is_minor boolean not null default false;
alter table crm_contacts add column if not exists is_minor boolean not null default false;

comment on column crm_leads.is_minor    is 'DPDP §9: subject identified as a child (<18) from date_of_birth at capture.';
comment on column crm_contacts.is_minor is 'DPDP §9: subject identified as a child (<18) from date_of_birth at capture.';

-- Partial indexes to make "exclude minors" filters cheap on large tables.
create index if not exists ix_crm_leads_is_minor    on crm_leads (org_id)    where is_minor;
create index if not exists ix_crm_contacts_is_minor on crm_contacts (org_id) where is_minor;
