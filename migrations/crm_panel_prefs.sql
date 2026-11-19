CREATE TABLE IF NOT EXISTS public.crm_panel_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  client_id uuid,
  page text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id, page)
);

CREATE INDEX IF NOT EXISTS crm_panel_prefs_user_org_idx ON public.crm_panel_prefs (user_id, org_id);
