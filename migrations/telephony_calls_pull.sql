-- Telephony call log + recording-ingest dedup state.
--
-- Backs the CallerDesk "pull" reconcile (Call Report API → call_list_v2): records
-- each click-to-call we place (campid → lead + rep) so a PULLED recording lands on
-- the exact lead/rep, and dedups recording ingestion across BOTH the pull job and
-- the webhook so one call is transcribed+analyzed at most once.
--
-- Additive + idempotent (safe to re-run). No change to existing behaviour.
CREATE TABLE IF NOT EXISTS public.crm_telephony_calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  client_id        uuid,
  integration_id   uuid,
  provider         text NOT NULL DEFAULT 'callerdesk',
  -- Stable correlation key: campid for outgoing click-to-call (== call_list_v2
  -- sid_id == webhook campid), else the provider CallSid/Uniqueid for incoming.
  call_key         text NOT NULL,
  campid           text,
  call_sid         text,
  lead_id          uuid,          -- known at placement → authoritative correlation
  user_id          uuid,          -- the rep who placed the call
  customer_number  text,
  agent_number     text,
  direction        text,          -- WEBOBD (outgoing) | IVR (incoming)
  status           text NOT NULL DEFAULT 'placed',  -- placed | processing | ingested | skipped | error
  recording_id     uuid,          -- conversation_recordings.id once ingested
  detail           text,
  placed_at        timestamptz,
  ingested_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per call per tenant+provider → the dedup/idempotency guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_telephony_calls_key
  ON public.crm_telephony_calls (org_id, provider, call_key);

-- Reconcile scans by (org, status) and by lead for the detail view.
CREATE INDEX IF NOT EXISTS idx_crm_telephony_calls_status
  ON public.crm_telephony_calls (org_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_telephony_calls_lead
  ON public.crm_telephony_calls (org_id, lead_id);
