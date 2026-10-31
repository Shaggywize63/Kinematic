-- Per-client isolation for Form Builder forms.
--
-- Adds a nullable client_id to builder_forms so a form can be scoped to a
-- single client (e.g. the DVGPL Retailer Survey) instead of being visible to
-- every client in the org. The backend read filters (GET /api/v1/builder/forms
-- and GET /api/v1/forms/templates) return `client_id IS NULL OR client_id =
-- <caller's client>`, so:
--   • existing forms (client_id NULL) stay org-shared — ZERO behaviour change;
--   • a form stamped with a client_id is visible ONLY to that client's
--     dashboard pickers and that client's mobile reps.
--
-- Additive and idempotent (safe to re-run). Run via the one-off ECS migrate
-- task pattern in CLAUDE.md, then reload the PostgREST schema cache.

ALTER TABLE public.builder_forms
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);

CREATE INDEX IF NOT EXISTS idx_builder_forms_client_id
  ON public.builder_forms(client_id);

-- PostgREST caches the schema; make the new column visible to the REST API.
NOTIFY pgrst, 'reload schema';
