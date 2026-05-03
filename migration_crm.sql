-- =====================================================================
-- Kinematic CRM Module — Migration
-- Branch: claude/add-crm-module-6qLal
--
-- Adds tables, indexes, RLS policies, materialized views, and pg_cron
-- schedules for the CRM module. Mirrors patterns from migration_planograms.sql.
-- =====================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";
create extension if not exists "pg_trgm";
create extension if not exists "pg_cron";
create extension if not exists "pg_net";

-- ---------------------------------------------------------------------
-- Shared trigger (idempotent — reuse if planogram migration already created)
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- crm_pipelines
-- ---------------------------------------------------------------------
create table if not exists crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  description text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create index if not exists idx_crm_pipelines_org on crm_pipelines(org_id) where deleted_at is null;
create unique index if not exists ux_crm_pipelines_default on crm_pipelines(org_id) where is_default;
drop trigger if exists trg_crm_pipelines_updated on crm_pipelines;
create trigger trg_crm_pipelines_updated before update on crm_pipelines for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_deal_stages
-- ---------------------------------------------------------------------
create table if not exists crm_deal_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references crm_pipelines(id) on delete cascade,
  org_id uuid not null,
  name text not null,
  position int not null,
  probability numeric(5,2) not null default 50,
  stage_type text not null check (stage_type in ('open','won','lost')),
  color text default '#3b82f6',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_deal_stages_pipeline on crm_deal_stages(pipeline_id, position);
create index if not exists idx_crm_deal_stages_org on crm_deal_stages(org_id);
drop trigger if exists trg_crm_deal_stages_updated on crm_deal_stages;
create trigger trg_crm_deal_stages_updated before update on crm_deal_stages for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_lead_sources
-- ---------------------------------------------------------------------
create table if not exists crm_lead_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  type text not null default 'manual' check (type in ('csv','manual','web_form','email','api','campaign','referral','event','social','ads')),
  is_active boolean not null default true,
  cost_per_lead numeric(12,2) default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_crm_lead_sources_org_name on crm_lead_sources(org_id, lower(name));
drop trigger if exists trg_crm_lead_sources_updated on crm_lead_sources;
create trigger trg_crm_lead_sources_updated before update on crm_lead_sources for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_territories
-- ---------------------------------------------------------------------
create table if not exists crm_territories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  criteria jsonb default '{}'::jsonb,
  manager_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_territories_org on crm_territories(org_id);
drop trigger if exists trg_crm_territories_updated on crm_territories;
create trigger trg_crm_territories_updated before update on crm_territories for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_accounts (companies)
-- ---------------------------------------------------------------------
create table if not exists crm_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid,
  name text not null,
  domain citext,
  industry text,
  size text,
  annual_revenue numeric(16,2),
  phone text,
  website text,
  billing_address jsonb,
  shipping_address jsonb,
  owner_id uuid,
  territory_id uuid references crm_territories(id) on delete set null,
  parent_account_id uuid references crm_accounts(id) on delete set null,
  tags text[] default '{}',
  custom_fields jsonb default '{}'::jsonb,
  ai_summary text,
  ai_summary_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create index if not exists idx_crm_accounts_org_name on crm_accounts(org_id, lower(name)) where deleted_at is null;
create index if not exists idx_crm_accounts_org_domain on crm_accounts(org_id, domain) where deleted_at is null;
create unique index if not exists ux_crm_accounts_org_domain on crm_accounts(org_id, domain) where domain is not null and deleted_at is null;
create index if not exists idx_crm_accounts_owner on crm_accounts(org_id, owner_id);
create index if not exists idx_crm_accounts_tags on crm_accounts using gin(tags);
create index if not exists idx_crm_accounts_custom on crm_accounts using gin(custom_fields);
create index if not exists idx_crm_accounts_name_trgm on crm_accounts using gin (name gin_trgm_ops);
drop trigger if exists trg_crm_accounts_updated on crm_accounts;
create trigger trg_crm_accounts_updated before update on crm_accounts for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_contacts
-- ---------------------------------------------------------------------
create table if not exists crm_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  account_id uuid references crm_accounts(id) on delete set null,
  first_name text,
  last_name text,
  email citext,
  phone text,
  mobile text,
  title text,
  department text,
  linkedin_url text,
  owner_id uuid,
  do_not_contact boolean not null default false,
  email_opt_out boolean not null default false,
  tags text[] default '{}',
  custom_fields jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create unique index if not exists ux_crm_contacts_org_email on crm_contacts(org_id, email) where email is not null and deleted_at is null;
create index if not exists idx_crm_contacts_org_account on crm_contacts(org_id, account_id);
create index if not exists idx_crm_contacts_owner on crm_contacts(org_id, owner_id);
create index if not exists idx_crm_contacts_tags on crm_contacts using gin(tags);
create index if not exists idx_crm_contacts_custom on crm_contacts using gin(custom_fields);
drop trigger if exists trg_crm_contacts_updated on crm_contacts;
create trigger trg_crm_contacts_updated before update on crm_contacts for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_lead_assignment_rules (declared before leads to allow FK)
-- ---------------------------------------------------------------------
create table if not exists crm_lead_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  priority int not null default 100,
  is_active boolean not null default true,
  criteria jsonb default '{}'::jsonb,
  assign_to_user_id uuid,
  assign_to_team_id uuid,
  round_robin_pool jsonb,
  pipeline_id uuid references crm_pipelines(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_assignment_rules_org_priority on crm_lead_assignment_rules(org_id, priority) where is_active;
drop trigger if exists trg_crm_assignment_rules_updated on crm_lead_assignment_rules;
create trigger trg_crm_assignment_rules_updated before update on crm_lead_assignment_rules for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_leads
-- ---------------------------------------------------------------------
create table if not exists crm_leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid,
  first_name text,
  last_name text,
  email citext,
  phone text,
  company text,
  title text,
  source_id uuid references crm_lead_sources(id) on delete set null,
  status text not null default 'new' check (status in ('new','working','nurturing','qualified','unqualified','converted')),
  owner_id uuid,
  score int not null default 0,
  score_breakdown jsonb default '{}'::jsonb,
  score_updated_at timestamptz,
  last_activity_at timestamptz,
  last_contacted_at timestamptz,
  converted_at timestamptz,
  converted_contact_id uuid references crm_contacts(id) on delete set null,
  converted_account_id uuid references crm_accounts(id) on delete set null,
  converted_deal_id uuid,
  country text,
  city text,
  industry text,
  notes text,
  tags text[] default '{}',
  custom_fields jsonb default '{}'::jsonb,
  assignment_rule_id uuid references crm_lead_assignment_rules(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create index if not exists idx_crm_leads_org_status on crm_leads(org_id, status) where deleted_at is null;
create index if not exists idx_crm_leads_org_owner on crm_leads(org_id, owner_id) where deleted_at is null;
create index if not exists idx_crm_leads_org_score on crm_leads(org_id, score desc) where deleted_at is null;
create unique index if not exists ux_crm_leads_org_email_open on crm_leads(org_id, email) where email is not null and converted_at is null and deleted_at is null;
create index if not exists idx_crm_leads_tags on crm_leads using gin(tags);
create index if not exists idx_crm_leads_custom on crm_leads using gin(custom_fields);
create index if not exists idx_crm_leads_company_trgm on crm_leads using gin (company gin_trgm_ops);
drop trigger if exists trg_crm_leads_updated on crm_leads;
create trigger trg_crm_leads_updated before update on crm_leads for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_lead_history
-- ---------------------------------------------------------------------
create table if not exists crm_lead_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references crm_leads(id) on delete cascade,
  org_id uuid not null,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists idx_crm_lead_history_lead on crm_lead_history(lead_id, changed_at desc);
create index if not exists idx_crm_lead_history_org on crm_lead_history(org_id, changed_at desc);

-- ---------------------------------------------------------------------
-- crm_deals
-- ---------------------------------------------------------------------
create table if not exists crm_deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid,
  pipeline_id uuid not null references crm_pipelines(id) on delete restrict,
  stage_id uuid not null references crm_deal_stages(id) on delete restrict,
  name text not null,
  account_id uuid references crm_accounts(id) on delete set null,
  primary_contact_id uuid references crm_contacts(id) on delete set null,
  lead_id uuid references crm_leads(id) on delete set null,
  amount numeric(14,2) not null default 0,
  currency text not null default 'USD',
  expected_close_date date,
  actual_close_date date,
  probability numeric(5,2),
  win_probability_ai numeric(5,2),
  win_probability_reasoning text,
  win_probability_updated_at timestamptz,
  owner_id uuid,
  source_id uuid references crm_lead_sources(id) on delete set null,
  lost_reason text,
  next_step text,
  next_action_ai jsonb,
  next_action_updated_at timestamptz,
  tags text[] default '{}',
  custom_fields jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create index if not exists idx_crm_deals_org_stage on crm_deals(org_id, pipeline_id, stage_id) where deleted_at is null;
create index if not exists idx_crm_deals_org_owner on crm_deals(org_id, owner_id) where deleted_at is null;
create index if not exists idx_crm_deals_org_close on crm_deals(org_id, expected_close_date) where deleted_at is null;
create index if not exists idx_crm_deals_org_account on crm_deals(org_id, account_id) where deleted_at is null;
create index if not exists idx_crm_deals_tags on crm_deals using gin(tags);
drop trigger if exists trg_crm_deals_updated on crm_deals;
create trigger trg_crm_deals_updated before update on crm_deals for each row execute function set_updated_at();

-- Backfill FK from leads.converted_deal_id
do $$ begin
  if not exists (select 1 from information_schema.referential_constraints where constraint_name='crm_leads_converted_deal_id_fkey') then
    alter table crm_leads add constraint crm_leads_converted_deal_id_fkey
      foreign key (converted_deal_id) references crm_deals(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- crm_deal_history
-- ---------------------------------------------------------------------
create table if not exists crm_deal_history (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references crm_deals(id) on delete cascade,
  org_id uuid not null,
  from_stage_id uuid,
  to_stage_id uuid,
  from_amount numeric(14,2),
  to_amount numeric(14,2),
  changed_by uuid,
  changed_at timestamptz not null default now(),
  time_in_previous_stage_seconds int
);
create index if not exists idx_crm_deal_history_deal on crm_deal_history(deal_id, changed_at desc);
create index if not exists idx_crm_deal_history_org on crm_deal_history(org_id, changed_at desc);

-- ---------------------------------------------------------------------
-- crm_deal_contacts (M:N)
-- ---------------------------------------------------------------------
create table if not exists crm_deal_contacts (
  deal_id uuid not null references crm_deals(id) on delete cascade,
  contact_id uuid not null references crm_contacts(id) on delete cascade,
  role text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (deal_id, contact_id)
);

-- ---------------------------------------------------------------------
-- crm_activities (calls, meetings, emails, notes, tasks, sms)
-- ---------------------------------------------------------------------
create table if not exists crm_activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  type text not null check (type in ('call','meeting','email','note','task','sms')),
  subject text,
  body text,
  direction text check (direction in ('inbound','outbound')),
  status text not null default 'completed' check (status in ('planned','completed','cancelled')),
  due_at timestamptz,
  completed_at timestamptz,
  duration_seconds int,
  lead_id uuid references crm_leads(id) on delete cascade,
  contact_id uuid references crm_contacts(id) on delete cascade,
  account_id uuid references crm_accounts(id) on delete cascade,
  deal_id uuid references crm_deals(id) on delete cascade,
  owner_id uuid,
  assigned_to uuid,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create index if not exists idx_crm_activities_org_owner_due on crm_activities(org_id, owner_id, due_at) where deleted_at is null;
create index if not exists idx_crm_activities_lead on crm_activities(lead_id) where deleted_at is null;
create index if not exists idx_crm_activities_deal on crm_activities(deal_id) where deleted_at is null;
create index if not exists idx_crm_activities_contact on crm_activities(contact_id) where deleted_at is null;
create index if not exists idx_crm_activities_account on crm_activities(account_id) where deleted_at is null;
drop trigger if exists trg_crm_activities_updated on crm_activities;
create trigger trg_crm_activities_updated before update on crm_activities for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_notes (lightweight standalone notes)
-- ---------------------------------------------------------------------
create table if not exists crm_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  entity_type text not null check (entity_type in ('lead','contact','account','deal')),
  entity_id uuid not null,
  body text not null,
  pinned boolean not null default false,
  author_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_notes_entity on crm_notes(org_id, entity_type, entity_id);
drop trigger if exists trg_crm_notes_updated on crm_notes;
create trigger trg_crm_notes_updated before update on crm_notes for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_email_templates
-- ---------------------------------------------------------------------
create table if not exists crm_email_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  subject text not null,
  body_html text not null,
  body_text text,
  variables jsonb default '[]'::jsonb,
  category text default 'general',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists idx_crm_email_templates_org on crm_email_templates(org_id, category);
drop trigger if exists trg_crm_email_templates_updated on crm_email_templates;
create trigger trg_crm_email_templates_updated before update on crm_email_templates for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_email_logs
-- ---------------------------------------------------------------------
create table if not exists crm_email_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  template_id uuid references crm_email_templates(id) on delete set null,
  from_email text not null,
  to_email text not null,
  cc text[],
  bcc text[],
  subject text not null,
  body_html text,
  provider_message_id text,
  provider text default 'stub',
  status text not null default 'queued' check (status in ('queued','sent','delivered','opened','clicked','bounced','failed','unsubscribed')),
  lead_id uuid references crm_leads(id) on delete set null,
  contact_id uuid references crm_contacts(id) on delete set null,
  deal_id uuid references crm_deals(id) on delete set null,
  sent_by uuid,
  sent_at timestamptz,
  opened_at timestamptz,
  first_clicked_at timestamptz,
  open_count int not null default 0,
  click_count int not null default 0,
  tracking_pixel_token text unique,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_email_logs_org_sent on crm_email_logs(org_id, sent_at desc nulls last);
create index if not exists idx_crm_email_logs_provider_msg on crm_email_logs(provider_message_id);
create index if not exists idx_crm_email_logs_lead on crm_email_logs(lead_id);
create index if not exists idx_crm_email_logs_deal on crm_email_logs(deal_id);
create index if not exists idx_crm_email_logs_status_queued on crm_email_logs(status) where status = 'queued';

-- ---------------------------------------------------------------------
-- crm_lead_scores (history)
-- ---------------------------------------------------------------------
create table if not exists crm_lead_scores (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references crm_leads(id) on delete cascade,
  org_id uuid not null,
  score int not null,
  model text not null default 'heuristic_v1',
  breakdown jsonb default '{}'::jsonb,
  computed_at timestamptz not null default now()
);
create index if not exists idx_crm_lead_scores_lead on crm_lead_scores(lead_id, computed_at desc);

-- ---------------------------------------------------------------------
-- crm_campaigns
-- ---------------------------------------------------------------------
create table if not exists crm_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  type text default 'email',
  status text default 'planned' check (status in ('planned','active','paused','completed','cancelled')),
  start_date date,
  end_date date,
  budget numeric(14,2) default 0,
  actual_cost numeric(14,2) default 0,
  expected_revenue numeric(14,2) default 0,
  expected_response_rate numeric(5,2) default 0,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_campaigns_org_status on crm_campaigns(org_id, status);
drop trigger if exists trg_crm_campaigns_updated on crm_campaigns;
create trigger trg_crm_campaigns_updated before update on crm_campaigns for each row execute function set_updated_at();

create table if not exists crm_campaign_members (
  campaign_id uuid not null references crm_campaigns(id) on delete cascade,
  org_id uuid not null,
  lead_id uuid references crm_leads(id) on delete cascade,
  contact_id uuid references crm_contacts(id) on delete cascade,
  status text default 'sent',
  responded_at timestamptz,
  added_at timestamptz not null default now(),
  primary key (campaign_id, coalesce(lead_id, contact_id))
);
create index if not exists idx_crm_campaign_members_org on crm_campaign_members(org_id);

-- ---------------------------------------------------------------------
-- crm_workflow_automations
-- ---------------------------------------------------------------------
create table if not exists crm_workflow_automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  trigger_type text not null,
  trigger_config jsonb default '{}'::jsonb,
  conditions jsonb default '[]'::jsonb,
  actions jsonb default '[]'::jsonb,
  is_active boolean not null default true,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_automations_org_active on crm_workflow_automations(org_id) where is_active;
drop trigger if exists trg_crm_automations_updated on crm_workflow_automations;
create trigger trg_crm_automations_updated before update on crm_workflow_automations for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_settings (one row per org)
-- ---------------------------------------------------------------------
create table if not exists crm_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique,
  config jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_crm_settings_updated on crm_settings;
create trigger trg_crm_settings_updated before update on crm_settings for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_import_jobs
-- ---------------------------------------------------------------------
create table if not exists crm_import_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  file_name text,
  file_path text,
  total_rows int default 0,
  processed_rows int default 0,
  inserted int default 0,
  skipped int default 0,
  errors jsonb default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending','mapping','previewing','running','completed','failed')),
  mapping jsonb default '{}'::jsonb,
  sample_rows jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_import_jobs_org on crm_import_jobs(org_id, created_at desc);
drop trigger if exists trg_crm_import_jobs_updated on crm_import_jobs;
create trigger trg_crm_import_jobs_updated before update on crm_import_jobs for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- crm_custom_field_defs
-- ---------------------------------------------------------------------
create table if not exists crm_custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  entity_type text not null check (entity_type in ('lead','contact','account','deal')),
  field_key text not null,
  label text not null,
  field_type text not null check (field_type in ('text','number','boolean','date','datetime','select','multiselect','url','email')),
  options jsonb,
  required boolean not null default false,
  position int default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_crm_custom_field_defs on crm_custom_field_defs(org_id, entity_type, field_key);
drop trigger if exists trg_crm_custom_field_defs_updated on crm_custom_field_defs;
create trigger trg_crm_custom_field_defs_updated before update on crm_custom_field_defs for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- Materialized Views for analytics
-- ---------------------------------------------------------------------
create materialized view if not exists crm_mv_pipeline_value as
select
  d.org_id,
  d.pipeline_id,
  d.stage_id,
  s.name as stage_name,
  s.stage_type,
  d.owner_id,
  count(*) as deal_count,
  coalesce(sum(d.amount), 0) as total_amount,
  coalesce(sum(d.amount * coalesce(d.probability, s.probability) / 100.0), 0) as weighted_amount
from crm_deals d
join crm_deal_stages s on s.id = d.stage_id
where d.deleted_at is null and s.stage_type = 'open'
group by d.org_id, d.pipeline_id, d.stage_id, s.name, s.stage_type, d.owner_id;
create index if not exists idx_crm_mv_pipeline_value on crm_mv_pipeline_value(org_id, pipeline_id);

create materialized view if not exists crm_mv_funnel_daily as
select
  org_id,
  date_trunc('day', created_at)::date as day,
  count(*) filter (where status = 'new') as new_leads,
  count(*) filter (where status = 'qualified') as qualified_leads,
  count(*) filter (where status = 'converted') as converted_leads,
  count(*) filter (where status = 'unqualified') as unqualified_leads
from crm_leads
where deleted_at is null
group by org_id, date_trunc('day', created_at)::date;
create index if not exists idx_crm_mv_funnel_daily on crm_mv_funnel_daily(org_id, day desc);

create materialized view if not exists crm_mv_lead_source_roi as
select
  l.org_id,
  l.source_id,
  s.name as source_name,
  s.cost_per_lead,
  count(distinct l.id) as lead_count,
  count(distinct l.id) filter (where l.status = 'converted') as converted_count,
  coalesce(sum(d.amount) filter (where d.actual_close_date is not null and ds.stage_type = 'won'), 0) as revenue_won,
  coalesce(sum(s.cost_per_lead), 0) as total_cost
from crm_leads l
left join crm_lead_sources s on s.id = l.source_id
left join crm_deals d on d.lead_id = l.id and d.deleted_at is null
left join crm_deal_stages ds on ds.id = d.stage_id
where l.deleted_at is null
group by l.org_id, l.source_id, s.name, s.cost_per_lead;
create index if not exists idx_crm_mv_lead_source_roi on crm_mv_lead_source_roi(org_id);

create materialized view if not exists crm_mv_activity_heatmap as
select
  org_id,
  owner_id,
  extract(dow from coalesce(completed_at, created_at))::int as day_of_week,
  extract(hour from coalesce(completed_at, created_at))::int as hour_of_day,
  type,
  count(*) as activity_count
from crm_activities
where deleted_at is null and (completed_at is not null or status = 'completed')
group by org_id, owner_id, day_of_week, hour_of_day, type;
create index if not exists idx_crm_mv_activity_heatmap on crm_mv_activity_heatmap(org_id);

-- ---------------------------------------------------------------------
-- Row Level Security — applied uniformly
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'crm_pipelines','crm_deal_stages','crm_lead_sources','crm_territories','crm_accounts',
    'crm_contacts','crm_lead_assignment_rules','crm_leads','crm_lead_history','crm_deals',
    'crm_deal_history','crm_deal_contacts','crm_activities','crm_notes','crm_email_templates',
    'crm_email_logs','crm_lead_scores','crm_campaigns','crm_campaign_members',
    'crm_workflow_automations','crm_settings','crm_import_jobs','crm_custom_field_defs'
  ]) loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_select on %I', t);
    execute format($p$create policy tenant_isolation_select on %I for select using (org_id = (auth.jwt()->>'org_id')::uuid)$p$, t);
    execute format('drop policy if exists tenant_isolation_modify on %I', t);
    execute format($p$create policy tenant_isolation_modify on %I for all using (org_id = (auth.jwt()->>'org_id')::uuid) with check (org_id = (auth.jwt()->>'org_id')::uuid)$p$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Seed defaults helper (called on first CRM module activation per org)
-- ---------------------------------------------------------------------
create or replace function crm_seed_defaults(p_org_id uuid)
returns void language plpgsql as $$
declare
  v_pipeline_id uuid;
begin
  insert into crm_pipelines (org_id, name, description, is_default)
  values (p_org_id, 'Default Sales Pipeline', 'Auto-created default pipeline', true)
  on conflict do nothing
  returning id into v_pipeline_id;

  if v_pipeline_id is null then
    select id into v_pipeline_id from crm_pipelines where org_id = p_org_id and is_default limit 1;
  end if;

  insert into crm_deal_stages (pipeline_id, org_id, name, position, probability, stage_type, color) values
    (v_pipeline_id, p_org_id, 'New',         1, 10, 'open', '#94a3b8'),
    (v_pipeline_id, p_org_id, 'Contacted',   2, 20, 'open', '#60a5fa'),
    (v_pipeline_id, p_org_id, 'Qualified',   3, 40, 'open', '#3b82f6'),
    (v_pipeline_id, p_org_id, 'Proposal',    4, 60, 'open', '#8b5cf6'),
    (v_pipeline_id, p_org_id, 'Negotiation', 5, 80, 'open', '#f59e0b'),
    (v_pipeline_id, p_org_id, 'Won',         6,100, 'won',  '#10b981'),
    (v_pipeline_id, p_org_id, 'Lost',        7,  0, 'lost', '#ef4444')
  on conflict do nothing;

  insert into crm_lead_sources (org_id, name, type, cost_per_lead) values
    (p_org_id, 'Web Form',  'web_form', 0),
    (p_org_id, 'Manual',    'manual',   0),
    (p_org_id, 'CSV Import','csv',      0),
    (p_org_id, 'Referral',  'referral', 0),
    (p_org_id, 'Email',     'email',    0),
    (p_org_id, 'Ads',       'ads',      0)
  on conflict do nothing;

  insert into crm_settings (org_id, config) values
    (p_org_id, jsonb_build_object(
      'icp', jsonb_build_object('industries', '[]'::jsonb, 'company_sizes', '[]'::jsonb, 'titles', '[]'::jsonb),
      'scoring_weights', jsonb_build_object('title',20,'company_size',20,'source',15,'engagement',25,'recency',10,'icp',10),
      'default_pipeline_id', v_pipeline_id::text,
      'last_assigned_user', null
    ))
  on conflict (org_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------
-- pg_cron schedules — Edge Function URLs read from app config
-- (Operators must set: select set_config('app.edge_url','https://<proj>.functions.supabase.co', false);
--  and: alter database postgres set app.edge_secret = '<secret>')
-- ---------------------------------------------------------------------
do $$ begin
  perform cron.unschedule('crm-rescore-all-leads');
exception when others then null; end $$;
select cron.schedule(
  'crm-rescore-all-leads',
  '0 2 * * *',
  $$select net.http_post(
    url := current_setting('app.edge_url', true) || '/crm-rescore-all-leads',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.edge_secret', true), 'Content-Type','application/json'),
    body := '{}'::jsonb
  )$$
) where current_setting('app.edge_url', true) is not null;

do $$ begin perform cron.unschedule('crm-recompute-win-prob'); exception when others then null; end $$;
select cron.schedule(
  'crm-recompute-win-prob',
  '15 * * * *',
  $$select net.http_post(
    url := current_setting('app.edge_url', true) || '/crm-recompute-win-prob',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.edge_secret', true), 'Content-Type','application/json'),
    body := '{}'::jsonb
  )$$
) where current_setting('app.edge_url', true) is not null;

do $$ begin perform cron.unschedule('crm-refresh-analytics-mv'); exception when others then null; end $$;
select cron.schedule(
  'crm-refresh-analytics-mv',
  '*/15 * * * *',
  $$
    refresh materialized view concurrently crm_mv_pipeline_value;
    refresh materialized view concurrently crm_mv_funnel_daily;
    refresh materialized view concurrently crm_mv_lead_source_roi;
    refresh materialized view concurrently crm_mv_activity_heatmap;
  $$
);

do $$ begin perform cron.unschedule('crm-send-email-queue'); exception when others then null; end $$;
select cron.schedule(
  'crm-send-email-queue',
  '* * * * *',
  $$select net.http_post(
    url := current_setting('app.edge_url', true) || '/crm-send-email-queue',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.edge_secret', true), 'Content-Type','application/json'),
    body := '{}'::jsonb
  )$$
) where current_setting('app.edge_url', true) is not null;

do $$ begin perform cron.unschedule('crm-process-automations'); exception when others then null; end $$;
select cron.schedule(
  'crm-process-automations',
  '*/5 * * * *',
  $$select net.http_post(
    url := current_setting('app.edge_url', true) || '/crm-process-automations',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.edge_secret', true), 'Content-Type','application/json'),
    body := '{}'::jsonb
  )$$
) where current_setting('app.edge_url', true) is not null;

-- =====================================================================
-- End of CRM migration
-- =====================================================================
