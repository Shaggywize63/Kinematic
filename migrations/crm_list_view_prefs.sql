CREATE TABLE IF NOT EXISTS public.crm_list_view_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  client_id uuid,
  entity text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id, entity)
);

CREATE INDEX IF NOT EXISTS crm_list_view_prefs_user_org_idx ON public.crm_list_view_prefs (user_id, org_id);
