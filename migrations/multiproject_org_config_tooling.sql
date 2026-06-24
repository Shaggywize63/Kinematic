-- Multi-project org-config tooling
-- =================================
-- Two routines for the "develop in a staging org, promote to the production
-- org" workflow (both orgs live in the same Supabase project):
--
--   clone_org_config(src, dst)            -- full config copy with id-remap.
--                                            Use to STAND UP a staging org from
--                                            production, or to onboard a new org.
--                                            Assumes dst has no config rows yet.
--
--   promote_org_config(src, dst, dry_run) -- upsert the SETTINGS / field-override
--                                            surface from staging -> production.
--                                            Safe to re-run; never touches
--                                            transactional data (leads/contacts/
--                                            deals/activities/users).
--
-- Only CONFIG tables are handled. Transactional tables are never read or
-- written. Both functions are SECURITY DEFINER and operate within one project.
--
-- NOTE on scope of promote_org_config: it promotes crm_settings (the field-
-- override / business config jsonb) and org_settings (key/value). STRUCTURAL
-- config (pipelines, deal stages, custom fields, products, geography) is carried
-- by clone_org_config at staging-creation time; promoting *structural* changes
-- row-by-row needs natural-key matching those tables don't all have, so it's a
-- deliberate follow-up rather than a half-safe guess.

-- ─────────────────────────────────────────────────────────────────────────
-- clone_org_config: copy every config row from src org to dst org, generating
-- fresh ids and remapping the intra-config foreign keys so the cloned graph is
-- internally consistent. Returns a jsonb map of {table: rows_inserted}.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.clone_org_config(p_src uuid, p_dst uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- ordered parents-before-children; fk = { fk_column: referenced_config_table }
  v_specs jsonb := jsonb_build_array(
    jsonb_build_object('t','crm_states',             'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_cities',             'fk', jsonb_build_object('state_id','crm_states')),
    jsonb_build_object('t','crm_blocks',             'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_pipelines',          'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_deal_stages',        'fk', jsonb_build_object('pipeline_id','crm_pipelines')),
    jsonb_build_object('t','crm_product_categories', 'fk', jsonb_build_object('parent_category_id','crm_product_categories')),
    jsonb_build_object('t','crm_products',           'fk', jsonb_build_object('category_id','crm_product_categories')),
    jsonb_build_object('t','org_roles',              'fk', jsonb_build_object('parent_id','org_roles')),
    jsonb_build_object('t','crm_lead_sources',       'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_activity_types',     'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_activity_subjects',  'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_custom_field_defs',  'fk', '{}'::jsonb),
    jsonb_build_object('t','people_directory_types', 'fk', '{}'::jsonb),
    jsonb_build_object('t','org_settings',           'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_settings',           'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_email_templates',    'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_email_alerts',       'fk', '{}'::jsonb),
    jsonb_build_object('t','crm_verified_senders',   'fk', '{}'::jsonb)
  );
  v_spec    jsonb;
  v_tbl     text;
  v_fk      jsonb;
  v_cols    text;
  v_selects text;
  v_counts  jsonb := '{}'::jsonb;
  v_n       int;
begin
  if p_src is null or p_dst is null or p_src = p_dst then
    raise exception 'clone_org_config: src and dst must be distinct, non-null org ids';
  end if;

  create temp table if not exists _idmap(tbl text, old uuid, new uuid) on commit drop;
  delete from _idmap;

  for v_spec in select * from jsonb_array_elements(v_specs) loop
    v_tbl := v_spec->>'t';
    v_fk  := v_spec->'fk';

    -- 1. allocate a new id for every src row of this table
    execute format(
      'insert into _idmap(tbl, old, new) select %L, id, gen_random_uuid() from public.%I where org_id = $1',
      v_tbl, v_tbl
    ) using p_src;

    -- 2. build the column list (minus id) and matching select expressions:
    --    org_id -> dst, remapped FKs -> mapped new id, everything else verbatim
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
           string_agg(
             case
               when column_name = 'org_id' then '$2'
               when v_fk ? column_name then
                 format('(select i.new from _idmap i where i.tbl = %L and i.old = t.%I)',
                        v_fk->>column_name, column_name)
               else format('t.%I', column_name)
             end, ', ' order by ordinal_position)
      into v_cols, v_selects
    from information_schema.columns
    where table_schema = 'public' and table_name = v_tbl
      and column_name <> 'id' and is_generated <> 'ALWAYS';

    -- 3. insert the remapped rows
    execute format(
      'insert into public.%I (id, %s) select m.new, %s from public.%I t '
      || 'join _idmap m on m.tbl = %L and m.old = t.id where t.org_id = $1',
      v_tbl, v_cols, v_selects, v_tbl, v_tbl
    ) using p_src, p_dst;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_tbl, v_n);
  end loop;

  return v_counts;
end;
$$;

revoke all on function public.clone_org_config(uuid, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- promote_org_config: upsert the settings / field-override surface from a
-- staging org into a production org. Idempotent. With p_dry_run = true (the
-- default) it makes NO changes and just returns what it WOULD do.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.promote_org_config(p_src uuid, p_dst uuid, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings_cols text;
  v_set_clause    text;
  v_crm_settings  int := 0;
  v_org_settings  int := 0;
begin
  if p_src is null or p_dst is null or p_src = p_dst then
    raise exception 'promote_org_config: src and dst must be distinct, non-null org ids';
  end if;

  -- ---- crm_settings: natural key (org_id, client_id) ----------------------
  -- Count rows that would change (new or differing) for the report.
  select count(*) into v_crm_settings
  from crm_settings s
  where s.org_id = p_src;

  if not p_dry_run then
    -- Build an explicit column list excluding identity/owner columns so we can
    -- upsert on the (org_id, client_id) natural key.
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
           string_agg(
             case when column_name in ('id','org_id','client_id','created_at')
                  then null
                  else format('%1$I = excluded.%1$I', column_name) end,
             ', ' order by ordinal_position)
      into v_settings_cols, v_set_clause
    from information_schema.columns
    where table_schema = 'public' and table_name = 'crm_settings'
      and is_generated <> 'ALWAYS' and column_name <> 'id';

    execute format(
      'insert into crm_settings (id, %1$s) '
      || 'select gen_random_uuid(), %2$s from crm_settings t where t.org_id = $1 '
      || 'on conflict (org_id, client_id) do update set %3$s',
      v_settings_cols,
      -- select expr list matching v_settings_cols, overriding org_id -> dst
      (select string_agg(
          case when column_name = 'org_id' then '$2' else format('t.%I', column_name) end,
          ', ' order by ordinal_position)
        from information_schema.columns
        where table_schema='public' and table_name='crm_settings'
          and is_generated <> 'ALWAYS' and column_name <> 'id'),
      v_set_clause
    ) using p_src, p_dst;
    get diagnostics v_crm_settings = row_count;
  end if;

  -- ---- org_settings: merge by (org_id, key) -------------------------------
  -- No unique constraint exists, so merge explicitly: update matching keys,
  -- then insert keys present in src but absent in dst.
  select count(*) into v_org_settings from org_settings where org_id = p_src;

  if not p_dry_run then
    update org_settings d
       set value = s.value, updated_at = now()
      from org_settings s
     where s.org_id = p_src and d.org_id = p_dst and d.key = s.key;

    insert into org_settings (id, org_id, key, value)
    select gen_random_uuid(), p_dst, s.key, s.value
      from org_settings s
     where s.org_id = p_src
       and not exists (select 1 from org_settings d where d.org_id = p_dst and d.key = s.key);
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'crm_settings_rows', v_crm_settings,
    'org_settings_rows', v_org_settings,
    'note', 'Promotes settings/field-overrides only. Structural config '
            || '(pipelines, stages, custom fields, products, geography) is carried '
            || 'by clone_org_config at staging creation; structural row-level promotion '
            || 'is a separate follow-up.'
  );
end;
$$;

revoke all on function public.promote_org_config(uuid, uuid, boolean) from public, anon, authenticated;
