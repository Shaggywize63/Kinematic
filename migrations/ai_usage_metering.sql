-- AI usage metering — per-call token usage for the planogram vision API, so the
-- admin Billing section can cost API usage per client over a period.
--
-- Written once per Anthropic vision call (recognizeShelf path) by
-- src/lib/aiUsageMeter.ts, which reads the request's org/client/capture context
-- from AsyncLocalStorage. Cost is NOT stored — it is computed at read time from
-- src/lib/aiPricing.ts, so a rate change re-prices history without a backfill.
--
-- Apply to the project(s) that run planogram vision (Kinematic today; Tata if it
-- ever uses it) via the standard apply_migration pattern. Idempotent.

CREATE TABLE IF NOT EXISTS public.ai_usage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  client_id          uuid,
  -- The metered feature. Only 'planogram_vision' today; kept as a column so the
  -- same table can meter other AI features later without a schema change.
  feature            text NOT NULL DEFAULT 'planogram_vision',
  model              text NOT NULL,
  -- Which capture / vision tool the call belonged to (observability; nullable so
  -- non-capture calls, e.g. planogram parse, can still be metered later).
  capture_id         uuid,
  tool               text,
  -- Raw token counts from the Anthropic response `usage` block. Cache tiers are
  -- kept separate because they price differently (write ~1.25x, read ~0.1x).
  input_tokens       integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_org_created_idx    ON public.ai_usage (org_id, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_client_created_idx ON public.ai_usage (client_id, created_at);

-- PostgREST schema reload after DDL.
NOTIFY pgrst, 'reload schema';
