-- Per-client custom lead statuses: relax the crm_leads.status CHECK.
--
-- `crm_leads.status` was constrained to the built-in lifecycle enum
-- (new/working/nurturing/qualified/unqualified/converted/lost). Per-client
-- custom statuses (crm_settings.config.lead_statuses) are now validated in the
-- application layer (src/services/crm/leadStatuses.ts -> assertValidLeadStatus,
-- plus the Zod slug in crm.validators.ts), so the DB-level enum both duplicated
-- that check and blocked legitimate custom values (e.g. a jewellery client's
-- "interested"/"visit_planned"). Replace the fixed-enum CHECK with a safe
-- lowercase-slug guard that matches the application's rule; the real per-client
-- whitelist is enforced server-side.
--
-- Applied to the Kinematic project (clldjlojtmrrpozydqxk / RDS db "kinematic")
-- on 2026-10-02. Idempotent. The built-in values all satisfy the slug pattern,
-- so existing rows are unaffected (verified: 0 violating rows before applying).

ALTER TABLE public.crm_leads DROP CONSTRAINT IF EXISTS crm_leads_status_check;
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_status_check
  CHECK (status ~ '^[a-z][a-z0-9_]{0,63}$');
