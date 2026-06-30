-- Dedup ledger for time-based automations (lead_idle / deal_stalled /
-- task_overdue). The scheduler "claims" (automation_id, entity_id, window_key)
-- before firing; the unique index makes the claim atomic so a rule fires at
-- most once per idle/stall/overdue episode, even with multiple app instances
-- or overlapping scheduler ticks. window_key is anchored on the entity's
-- relevant timestamp (last_activity_at / updated_at / due_at) so the rule
-- re-fires only after the entity is actually touched again.

CREATE TABLE IF NOT EXISTS public.crm_automation_event_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL,
  entity_id     uuid NOT NULL,
  window_key    text NOT NULL,
  fired_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_event
  ON public.crm_automation_event_log (automation_id, entity_id, window_key);
CREATE INDEX IF NOT EXISTS idx_automation_event_fired
  ON public.crm_automation_event_log (fired_at);
