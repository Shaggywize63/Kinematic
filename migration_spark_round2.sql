-- Spark & Ray round 2: account Outcome, deal sections (pricing / product trial / approvals),
-- upcoming-activity reminders (1 week / 3 days / 1 day). Additive and idempotent. Apply to the Kinematic
-- tenant DB, then NOTIFY pgrst, 'reload schema'. Every feature here is gated to connected-B2B clients in
-- the API, so a tenant that has not run this file is never touched.
begin;

-- 1. Account outcome (required for Spark in the API).
alter table crm_accounts add column if not exists outcome text;

-- 2. Deal sections, after the quotation number.
alter table crm_deals add column if not exists pricing_quoted numeric;
alter table crm_deals add column if not exists pricing_discount_pct numeric;
alter table crm_deals add column if not exists pricing_final numeric;
alter table crm_deals add column if not exists pricing_valid_till date;
alter table crm_deals add column if not exists trial_required boolean;
alter table crm_deals add column if not exists trial_start date;
alter table crm_deals add column if not exists trial_end date;
alter table crm_deals add column if not exists trial_result text;
alter table crm_deals add column if not exists trial_notes text;
alter table crm_deals add column if not exists technical_approval_by uuid;
alter table crm_deals add column if not exists prepared_by uuid;
alter table crm_deals add column if not exists checked_by uuid;
alter table crm_deals add column if not exists supervisor_id uuid;

-- 3. Which upcoming-activity reminder (7 / 3 / 1 days before) went out for an activity, so each fires once.
create table if not exists crm_activity_reminder_log (
  activity_id uuid        not null references crm_activities(id) on delete cascade,
  offset_days int         not null,
  sent_at     timestamptz not null default now(),
  primary key (activity_id, offset_days)
);
alter table crm_activity_reminder_log enable row level security;   -- service role only

commit;
notify pgrst, 'reload schema';
