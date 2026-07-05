-- Conversation Intelligence — move the pilot from Tata Tiscon to the Kinematic
-- tenant. Requested: keep the feature Kinematic-only for now; Tata is pushed
-- later (a one-line re-enable — see the bottom of this file).
--
-- Gating is per Supabase project (each tenant is its own project). So this is
-- a two-sided data flip:
--   * TATA project     `lnvxqjqfsxvtjvbzphou` — REVOKE (disable client grant +
--                       strip the role permission). The client_modules row is
--                       kept (enabled=false) so the later push is a single flip.
--   * KINEMATIC project `clldjlojtmrrpozydqxk` — GRANT to the Kinematic client
--                       `7ecd47d7-9268-4ea2-a8ce-384978c13667` + internal roles.
--                       Module + private `conversation-audio` bucket already
--                       existed there (registered in conversation_intel_module.sql).
--
-- requireModuleAccess('crm_conversation_intel') needs BOTH the client entitlement
-- (client_modules → v_client_enabled_modules, which keys on `enabled IS TRUE`)
-- AND the caller's org-role permission — hence both halves flip on each side.
--
-- Applied live via MCP on 2026-07-05. Verified afterwards:
--   Tata:     in_view=0, roles_with_perm=0, client grant enabled=false.
--   Kinematic: Kinematic client in_view=1, roles_with_perm=24; SRS TATA Steel
--              and Kinematic Demo clients in_view=0 (Kinematic client only).

-- ===========================================================================
-- TATA project (`lnvxqjqfsxvtjvbzphou`) — REVOKE
-- ===========================================================================

-- 1) Disable the client entitlement (row preserved for an easy re-grant later).
update client_modules set enabled = false
  where client_id = 'a1f67468-526e-4734-be3a-2cb132cc2804'
    and module_id = 'crm_conversation_intel';

-- 2) Strip the role-permission half from every role that had it.
update org_roles
  set permissions       = array_remove(permissions, 'crm_conversation_intel'),
      permissions_write = array_remove(coalesce(permissions_write,'{}'), 'crm_conversation_intel')
  where 'crm_conversation_intel' = any(permissions)
     or 'crm_conversation_intel' = any(coalesce(permissions_write,'{}'));

-- ===========================================================================
-- KINEMATIC project (`clldjlojtmrrpozydqxk`) — GRANT to the Kinematic client
-- ===========================================================================

-- 1) Grant the client entitlement (Kinematic client only; not Demo / SRS TATA).
insert into client_modules (client_id, module_id, enabled, source, granted_at)
  values ('7ecd47d7-9268-4ea2-a8ce-384978c13667','crm_conversation_intel', true, 'manual', now())
  on conflict (client_id, module_id) do update set enabled = true;

-- 2) Grant the role-permission half to internal roles (Distributor roles excluded).
update org_roles
  set permissions = case when 'crm_conversation_intel' = any(permissions) then permissions
                         else array_append(permissions,'crm_conversation_intel') end,
      permissions_write = case when 'crm_conversation_intel' = any(coalesce(permissions_write,'{}')) then coalesce(permissions_write,'{}')
                               else array_append(coalesce(permissions_write,'{}'),'crm_conversation_intel') end
  where name not ilike '%distributor%'
    and (not ('crm_conversation_intel' = any(permissions))
         or not ('crm_conversation_intel' = any(coalesce(permissions_write,'{}'))));

-- ===========================================================================
-- LATER: push to Tata. Re-run conversation_intel_module.sql against the Tata
-- project, OR just flip the two halves back on:
--   update client_modules set enabled = true
--     where client_id = 'a1f67468-526e-4734-be3a-2cb132cc2804'
--       and module_id = 'crm_conversation_intel';
--   -- + re-add 'crm_conversation_intel' to the internal roles (step 3 of
--   --   conversation_intel_module.sql).
-- ===========================================================================
