-- Form reference numbers (e.g. SRPR2627-1) + expense claim -> filled form link.
-- Additive and idempotent. Apply to the Kinematic tenant DB, then
--   NOTIFY pgrst, 'reload schema';
-- Numbering is opt-in per client (clients.settings.form_ref_prefix), so nothing
-- changes for a client without that setting.
begin;

-- 1. The reference on each filled form; unique per client.
alter table form_submissions add column if not exists ref_no text;
create unique index if not exists form_submissions_client_ref_no_uidx
  on form_submissions (client_id, ref_no) where ref_no is not null;

-- 2. One running counter per client per series (prefix + financial year).
create table if not exists form_ref_counters (
  client_id  uuid        not null,
  series     text        not null,
  last_value integer     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (client_id, series)
);
alter table form_ref_counters enable row level security;   -- no policies: service role only

-- Atomic: concurrent submissions can never be handed the same number.
create or replace function next_form_ref(p_client uuid, p_series text) returns integer
language sql as $$
  insert into form_ref_counters (client_id, series, last_value) values (p_client, p_series, 1)
  on conflict (client_id, series) do update
    set last_value = form_ref_counters.last_value + 1, updated_at = now()
  returning last_value;
$$;
revoke all on function next_form_ref(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function next_form_ref(uuid, text) to service_role;
  end if;
end $$;

-- 3. An expense claim can link to a filled form (shown as its reference + date).
alter table expense_claims add column if not exists form_submission_id uuid
  references form_submissions(id) on delete set null;
create index if not exists expense_claims_form_submission_idx
  on expense_claims (form_submission_id) where form_submission_id is not null;

commit;
notify pgrst, 'reload schema';
