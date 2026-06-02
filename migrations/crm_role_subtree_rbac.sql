-- Role-tree hierarchy RBAC for CRM data visibility.
--
-- Tenants model their org hierarchy as a tree of *designations* in
-- org_roles (org_roles.parent_id), and assign each user an org_role_id.
-- users.supervisor_id is left empty, so the older user_subtree_ids()
-- function (which walks supervisor_id) returns only the caller and never
-- reflects the configured hierarchy.
--
-- role_subtree_user_ids(p_user_id) returns the caller plus every user whose
-- designation is a descendant of the caller's designation in the role tree,
-- scoped to the same org and (when set) client. A manager therefore sees
-- DOWN the tree only — never up to their own supervisor, never sideways to a
-- sibling branch. Frontline 'own'-scoped reps are capped to themselves in the
-- application layer (hierarchy.service.ts) before this function is consulted.
--
-- STABLE + called via the service role (RLS bypassed), so no SECURITY DEFINER
-- is required. UNION (not UNION ALL) dedupes and terminates even if a role
-- tree somehow contains a cycle.

CREATE OR REPLACE FUNCTION public.role_subtree_user_ids(p_user_id uuid)
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
AS $function$
  WITH RECURSIVE me AS (
    SELECT id, org_id, client_id, org_role_id
    FROM public.users
    WHERE id = p_user_id
  ),
  role_tree AS (
    -- Seed: the caller's own designation.
    SELECT r.id
    FROM public.org_roles r
    JOIN me ON r.id = me.org_role_id
    WHERE r.deleted_at IS NULL
    UNION
    -- Walk DOWN: every role whose parent is already in the set.
    SELECT c.id
    FROM public.org_roles c
    JOIN role_tree rt ON c.parent_id = rt.id
    WHERE c.deleted_at IS NULL
  )
  SELECT DISTINCT u.id AS user_id
  FROM public.users u, me
  WHERE u.org_id = me.org_id
    AND (me.client_id IS NULL OR u.client_id = me.client_id)
    AND (
      u.id = me.id
      OR u.org_role_id IN (SELECT id FROM role_tree)
    );
$function$;

-- Enabling this for a specific client is a deliberate, post-deploy go-live
-- step (it changes what live users see). Do NOT enable it in this migration.
-- Once the application code above is deployed and QA'd, run e.g.:
--
--   UPDATE public.clients
--   SET settings = jsonb_set(coalesce(settings, '{}'::jsonb),
--                            '{uses_hierarchy_rbac}', 'true'::jsonb)
--   WHERE id = '<client_id>';
