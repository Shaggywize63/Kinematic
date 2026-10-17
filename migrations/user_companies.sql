-- Which companies (clients) a user may sell for. A rep with rows here can pick any
-- listed company per request via X-Client-Id; users with no rows are unaffected.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS public.user_companies (
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_user_companies_client ON public.user_companies (client_id);
ALTER TABLE public.user_companies ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
