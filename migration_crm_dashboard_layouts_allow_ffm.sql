-- Allow the Field-Force analytics grid to persist its layout under page='ffm'.
-- Previously the CHECK only permitted 'analytics'/'overview', so the FFM save
-- returned "page must be 'analytics' or 'overview'". Idempotent + additive:
-- existing rows/values remain valid. Applied to both Supabase projects
-- (Kinematic clldjlojtmrrpozydqxk + Tata lnvxqjqfsxvtjvbzphou).
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid='public.crm_dashboard_layouts'::regclass and contype='c'
     and pg_get_constraintdef(oid) like '%page%';
  if c is not null then
    execute 'alter table public.crm_dashboard_layouts drop constraint '||quote_ident(c);
  end if;
  alter table public.crm_dashboard_layouts
    add constraint crm_dashboard_layouts_page_check
    check (page in ('analytics','overview','ffm'));
end $$;
