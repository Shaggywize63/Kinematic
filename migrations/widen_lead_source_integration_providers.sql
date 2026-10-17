-- Align crm_lead_source_integrations.provider CHECK with the code's ProviderId union.
--
-- The original constraint only allowed web_form / generic_webhook / meta_lead_ads /
-- google_ads / zoho, but the backend has since added salesforce, email_inbound,
-- ivr_missed_call and call_recording (see src/services/crm/integrations/providers/types.ts
-- and integrations.controller PUSH_PROVIDERS). call_recording in particular is required
-- for the IVR / Conversation-Analysis path (telephony.service reads the org's
-- provider='call_recording' integration config). Without this widening the row cannot be
-- inserted and IVR click-to-call has no config to read. Additive + idempotent (only widens
-- the allowed set). Apply to every Supabase project the backend serves (default/Tata + kinematic),
-- then NOTIFY pgrst to reload the schema cache.
ALTER TABLE public.crm_lead_source_integrations
  DROP CONSTRAINT IF EXISTS crm_lead_source_integrations_provider_check;
ALTER TABLE public.crm_lead_source_integrations
  ADD CONSTRAINT crm_lead_source_integrations_provider_check
  CHECK (provider = ANY (ARRAY[
    'web_form','generic_webhook','meta_lead_ads','google_ads','zoho',
    'salesforce','email_inbound','ivr_missed_call','call_recording'
  ]));

-- NOTIFY pgrst, 'reload schema';
