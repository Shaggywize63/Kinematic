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
