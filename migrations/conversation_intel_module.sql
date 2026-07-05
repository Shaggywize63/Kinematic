-- Register + gate the Conversation Intelligence feature.
--
-- The route is protected by requireModuleAccess('crm_conversation_intel'), which
-- checks BOTH the client entitlement (client_modules → v_client_enabled_modules)
-- AND the caller's org-role permissions. So enabling it for a client is a 3-step
-- data flip (replicable for any client): register the module, grant it to the
-- client, and add it to the client's internal roles' permissions.
--
-- Applied live to: Tata project `lnvxqjqfsxvtjvbzphou` (registered + granted to
-- Tata Tiscon a1f67468 + all internal roles). Kinematic project
-- `clldjlojtmrrpozydqxk`: module registered only (not granted — Tata-only for now).

-- 1) Catalog entry (both projects).
insert into modules (id, name, description, package, is_universal)
values ('crm_conversation_intel','Conversation Intelligence',
        'Record + AI-analyze customer calls on leads (Sarvam + KINI)','crm', false)
on conflict (id) do update set name = excluded.name, description = excluded.description;

-- 2) Grant to the client (Tata project only). Replicate by changing the client_id.
insert into client_modules (client_id, module_id, enabled, source, granted_at)
values ('a1f67468-526e-4734-be3a-2cb132cc2804','crm_conversation_intel', true, 'manual', now())
on conflict (client_id, module_id) do update set enabled = true;

-- 3) Grant to internal org-roles (Tata project only) so reps + managers pass the
--    role-permission half of requireModuleAccess. External Distributor roles excluded.
update org_roles
set permissions = case when 'crm_conversation_intel' = any(permissions) then permissions
                       else array_append(permissions,'crm_conversation_intel') end,
    permissions_write = case when 'crm_conversation_intel' = any(coalesce(permissions_write,'{}')) then coalesce(permissions_write,'{}')
                             else array_append(coalesce(permissions_write,'{}'),'crm_conversation_intel') end
where name not ilike '%distributor%'
  and (not ('crm_conversation_intel' = any(permissions))
       or not ('crm_conversation_intel' = any(coalesce(permissions_write,'{}'))));

-- 4) Private audio bucket (both projects).
insert into storage.buckets (id, name, public, file_size_limit)
values ('conversation-audio','conversation-audio', false, 52428800)
on conflict (id) do nothing;
