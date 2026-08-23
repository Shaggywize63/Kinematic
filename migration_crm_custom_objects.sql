-- Custom Objects engine (applied to the Kinematic Supabase project
-- clldjlojtmrrpozydqxk via supabase migrations: crm_custom_objects_engine +
-- crm_custom_field_defs_allow_custom_object_entities). Kept here for repo
-- traceability. Additive only; Tata (default) is not touched.
--
-- User-defined CRM entity types beyond the built-in lead/contact/deal/account.
-- A custom object's fields live in crm_custom_field_defs with
-- entity_type = crm_custom_objects.key, so records reuse the existing
-- field validation / coercion / formula / lookup path (validateAndStampCustomFields).

create table if not exists public.crm_custom_objects (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  client_id    uuid,                       -- null = org-wide
  key          text not null,              -- machine key; = crm_custom_field_defs.entity_type
  label        text not null,              -- singular, e.g. "Property"
  label_plural text not null,              -- e.g. "Properties"
  icon         text,                       -- emoji
  description  text,
  is_active    boolean not null default true,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint crm_custom_objects_key_fmt check (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  unique (org_id, key)
);

create table if not exists public.crm_custom_records (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid not null references public.crm_custom_objects(id) on delete cascade,
  org_id      uuid not null,
  client_id   uuid,
  title       text,
  data        jsonb not null default '{}'::jsonb,
  owner_id    uuid,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists crm_custom_objects_org_idx
  on public.crm_custom_objects (org_id, client_id) where deleted_at is null;
create index if not exists crm_custom_records_object_idx
  on public.crm_custom_records (object_id, org_id) where deleted_at is null;
create index if not exists crm_custom_records_owner_idx
  on public.crm_custom_records (org_id, owner_id) where deleted_at is null;

alter table public.crm_custom_objects enable row level security;
alter table public.crm_custom_records enable row level security;

-- crm_custom_field_defs.entity_type CHECK previously hard-listed only the
-- built-in entities; relax it to a key pattern so custom-object keys are
-- allowed too (all built-ins still match). Additive.
alter table public.crm_custom_field_defs
  drop constraint crm_custom_field_defs_entity_type_check;
alter table public.crm_custom_field_defs
  add constraint crm_custom_field_defs_entity_type_check
  check (entity_type ~ '^[a-z][a-z0-9_]{1,48}$');
