-- ============================================================
-- KINI CREDITS — shared per-org credit cap + platform attribution.
-- Apply manually via Supabase SQL editor or psql.
--
-- This migration:
--   1. Codifies the kini_usage runtime schema (so it's checked-in).
--   2. Adds client_id, platform, request_count for per-platform reporting
--      and per-client (where applicable) attribution.
--   3. Replaces the (user_id, month) uniqueness with
--      (user_id, org_id, month, platform) so a single user using both web
--      and iOS in the same month gets two rows that sum correctly.
--   4. Adds org_settings.kini_monthly_query_limit so a tenant can override
--      the env-default cap without a code deploy.
--
-- Idempotent: all CREATE / ALTER statements gated with IF NOT EXISTS /
-- DO blocks so a re-run is a no-op.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── kini_usage ──────────────────────────────────────────────
-- Codify the existing runtime schema first; columns may already exist.
CREATE TABLE IF NOT EXISTS public.kini_usage (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL,
  org_id         uuid        NOT NULL,
  month          text        NOT NULL,            -- 'YYYY-MM' (UTC)
  query_count    int         NOT NULL DEFAULT 0,
  input_tokens   bigint      NOT NULL DEFAULT 0,
  output_tokens  bigint      NOT NULL DEFAULT 0,
  last_query_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- New columns for shared-credit + platform attribution.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'kini_usage'
                   AND column_name = 'client_id') THEN
    ALTER TABLE public.kini_usage ADD COLUMN client_id uuid NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'kini_usage'
                   AND column_name = 'platform') THEN
    ALTER TABLE public.kini_usage
      ADD COLUMN platform text NOT NULL DEFAULT 'web'
        CHECK (platform IN ('web','ios','android'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'kini_usage'
                   AND column_name = 'request_count') THEN
    ALTER TABLE public.kini_usage
      ADD COLUMN request_count int NOT NULL DEFAULT 0;
  END IF;
END$$;

-- If org_id was previously nullable, tighten it. Best-effort: skip if any
-- legacy NULLs are present so the migration doesn't fail.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'kini_usage'
               AND column_name = 'org_id'
               AND is_nullable = 'YES')
     AND NOT EXISTS (SELECT 1 FROM public.kini_usage WHERE org_id IS NULL) THEN
    ALTER TABLE public.kini_usage ALTER COLUMN org_id SET NOT NULL;
  END IF;
END$$;

-- Replace the legacy unique(user_id, month) with the platform-aware key.
-- The old constraint name is unknown across environments, so drop *any*
-- single-column-pair (user_id, month) unique index, then create the new one
-- under a stable name. Idempotent on re-run.
DO $$
DECLARE
  legacy_idx text;
BEGIN
  SELECT i.relname INTO legacy_idx
  FROM pg_index ix
  JOIN pg_class  i  ON i.oid = ix.indexrelid
  JOIN pg_class  t  ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'kini_usage'
    AND ix.indisunique
    AND (
      SELECT array_agg(a.attname ORDER BY a.attnum)
      FROM pg_attribute a
      WHERE a.attrelid = t.oid
        AND a.attnum = ANY(ix.indkey)
    ) = ARRAY['user_id','month']::name[]
  LIMIT 1;

  IF legacy_idx IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.kini_usage DROP CONSTRAINT IF EXISTS %I', legacy_idx);
    EXECUTE format('DROP INDEX IF EXISTS public.%I', legacy_idx);
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS kini_usage_user_org_month_platform_key
  ON public.kini_usage (user_id, org_id, month, platform);

CREATE INDEX IF NOT EXISTS idx_kini_usage_org_month
  ON public.kini_usage (org_id, month);
CREATE INDEX IF NOT EXISTS idx_kini_usage_org_platform_month
  ON public.kini_usage (org_id, platform, month);

-- ── org_settings ─────────────────────────────────────────────
-- Per-org overrides for KINI caps (NULL means "use env default").
CREATE TABLE IF NOT EXISTS public.org_settings (
  org_id                     uuid        PRIMARY KEY,
  kini_monthly_query_limit   int         NULL,
  kini_monthly_token_limit   bigint      NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
