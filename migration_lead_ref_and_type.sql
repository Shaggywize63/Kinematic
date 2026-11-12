-- Lead numbers (e.g. SR/LD/2627-12) + lead type (requirement | discussion) on crm_leads.
-- Additive and idempotent. NOT applied automatically: the operator runs it on the Kinematic tenant DB, then sends
--   NOTIFY pgrst, 'reload schema';
-- (deliberately not part of this file).
--
-- Numbering is opt-in in code: only connected-B2B clients (Spark & Ray) get a ref_no, prefix from
-- clients.settings.lead_ref_prefix (default SR/LD). Until this runs, lead create/edit keep working (the API retries
-- without the two new columns) and POST /api/v1/crm/leads/ref-numbers/backfill answers 503 NOT_MIGRATED.
begin;

-- 1. The lead number and the lead type.
alter table crm_leads add column if not exists ref_no    text;
alter table crm_leads add column if not exists lead_type text;

-- lead_type is one of two values (or empty). Added idempotently: ADD CONSTRAINT has no IF NOT EXISTS.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'crm_leads_lead_type_check' and conrelid = 'crm_leads'::regclass
  ) then
    alter table crm_leads
      add constraint crm_leads_lead_type_check
      check (lead_type is null or lead_type in ('requirement', 'discussion'));
  end if;
end $$;

-- 2. A lead number is unique per org + client (leads without a client share the all-zero key).
create unique index if not exists crm_leads_org_client_ref_no_uidx
  on crm_leads (org_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), ref_no)
  where ref_no is not null;

-- Fast lookup by number (search, exact filter, email-subject trace).
create index if not exists crm_leads_ref_no_idx
  on crm_leads (ref_no) where ref_no is not null;

-- 3. One running counter per client per series (prefix + financial year, e.g. 'SR/LD/2627').
create table if not exists lead_ref_counters (
  client_id  uuid        not null,
  series     text        not null,
  last_value bigint      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (client_id, series)
);
alter table lead_ref_counters enable row level security;   -- no policies: service role only

-- Atomic: concurrent creates can never be handed the same number.
create or replace function next_lead_ref(p_client uuid, p_series text) returns bigint
language sql as $$
  insert into lead_ref_counters (client_id, series, last_value) values (p_client, p_series, 1)
  on conflict (client_id, series) do update
    set last_value = lead_ref_counters.last_value + 1, updated_at = now()
  returning last_value;
$$;
revoke all on function next_lead_ref(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function next_lead_ref(uuid, text) to service_role;
  end if;
end $$;

commit;
