-- Account journey: account updates (by contact person), several field executives on one
-- activity, "product interested" + filled-form link on an activity, quotation number on a deal.
-- Additive and idempotent. Apply to the Kinematic tenant DB, then NOTIFY pgrst, 'reload schema';
-- Every feature here is gated to connected-B2B clients (Spark & Ray) in the API, so a tenant
-- whose database has not run this file is never touched.
begin;

-- 1. Recent updates on an account, optionally attributed to a contact person.
create table if not exists crm_account_updates (
  id         uuid        primary key default gen_random_uuid(),
  org_id     uuid        not null,
  client_id  uuid,
  account_id uuid        not null references crm_accounts(id) on delete cascade,
  contact_id uuid        references crm_contacts(id) on delete set null,
  body       text        not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists crm_account_updates_account_idx
  on crm_account_updates (account_id, created_at desc) where deleted_at is null;
alter table crm_account_updates enable row level security;   -- no policies: service role only

-- 2. More than one assignee on an activity. crm_activities.assigned_to stays the PRIMARY assignee
--    (so every existing report keeps working); this table lists everyone assigned, primary included.
create table if not exists crm_activity_assignees (
  activity_id uuid        not null references crm_activities(id) on delete cascade,
  user_id     uuid        not null,
  org_id      uuid        not null,
  client_id   uuid,
  created_at  timestamptz not null default now(),
  primary key (activity_id, user_id)
);
create index if not exists crm_activity_assignees_user_idx on crm_activity_assignees (user_id, created_at desc);
alter table crm_activity_assignees enable row level security;

-- 3. "Product interested" and the filled form (by its serial, e.g. SRPR2627-12) on an activity.
alter table crm_activities add column if not exists product_ids uuid[];
alter table crm_activities add column if not exists form_submission_id uuid
  references form_submissions(id) on delete set null;
create index if not exists crm_activities_form_submission_idx
  on crm_activities (form_submission_id) where form_submission_id is not null;

-- 4. A quotation number on a deal.
alter table crm_deals add column if not exists quotation_no text;
create index if not exists crm_deals_quotation_idx
  on crm_deals (client_id, quotation_no) where quotation_no is not null;

commit;
notify pgrst, 'reload schema';
