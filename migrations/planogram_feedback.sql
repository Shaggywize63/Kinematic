-- planogram_feedback.sql
--
-- Detection-feedback learning loop for the redesigned planogram module — the
-- accept / "this detection is wrong" signal captured from the Captures / Review
-- queue UI (POST /api/v1/planograms/captures/:id/detection-feedback).
--
-- ALREADY APPLIED — this file is for the record only. The DDL below was applied
-- by hand to BOTH Supabase projects before this migration was committed:
--   • Kinematic (default dev/parent tenant):  clldjlojtmrrpozydqxk
--   • Tata Tiscon (production default tenant): lnvxqjqfsxvtjvbzphou
-- Every statement is guarded (IF NOT EXISTS / IF EXISTS) so re-running it is a
-- no-op.
--
-- NOTE — one table, two feedback loops. A `planogram_feedback` table already
-- existed for the human-corrections loop behind POST /captures/:id/feedback
-- (columns corrected_by / corrections / notes). Rather than a second table, the
-- detection-feedback loop SHARES it: the detection-feedback columns below are
-- added additively and the two legacy NOT NULLs are relaxed so BOTH endpoints
-- can write. `reason` is stored NULLABLE at the DB layer (the detection-feedback
-- route enforces the allowed-value set — wrong_product | not_a_product |
-- wrong_facings | wrong_price | other — in app code and returns 400 otherwise);
-- making it NOT NULL here would break the pre-existing corrections insert, which
-- does not set `reason`.

-- Fresh installs: create the superset table both loops write to. (On existing
-- installs the base table already exists via migration_planograms.sql, so this
-- is a no-op and the ALTERs below do the work.)
CREATE TABLE IF NOT EXISTS public.planogram_feedback (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid        NOT NULL,
    client_id      uuid        NULL,
    capture_id     uuid        NOT NULL REFERENCES public.planogram_captures(id) ON DELETE CASCADE,
    -- detection-feedback (accept / feedback) columns
    sku_id         text        NULL,
    bbox           jsonb       NULL,           -- [x, y, w, h] normalized 0..1 (or null)
    reason         text        NULL,           -- app-enforced enum; see note above
    correct_sku_id text        NULL,
    note           text        NULL,
    created_by     uuid        NULL,
    -- legacy human-corrections columns (POST /captures/:id/feedback)
    corrected_by   uuid        NULL,
    corrections    jsonb       NULL,
    notes          text        NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Existing installs (table already present with the legacy shape): add the new
-- detection-feedback columns.
ALTER TABLE public.planogram_feedback ADD COLUMN IF NOT EXISTS client_id      uuid;
ALTER TABLE public.planogram_feedback ADD COLUMN IF NOT EXISTS sku_id         text;
ALTER TABLE public.planogram_feedback ADD COLUMN IF NOT EXISTS bbox           jsonb;
ALTER TABLE public.planogram_feedback ADD COLUMN IF NOT EXISTS reason         text;
ALTER TABLE public.planogram_feedback ADD COLUMN IF NOT EXISTS correct_sku_id text;
ALTER TABLE public.planogram_feedback ADD COLUMN IF NOT EXISTS note           text;
ALTER TABLE public.planogram_feedback ADD COLUMN IF NOT EXISTS created_by     uuid;

-- Relax the legacy NOT NULLs so a detection-feedback row (which sets `reason`,
-- not corrections/corrected_by) can share the table. The corrections endpoint
-- still supplies both columns, so its behavior is unchanged.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'planogram_feedback'
               AND column_name = 'corrected_by') THEN
    ALTER TABLE public.planogram_feedback ALTER COLUMN corrected_by DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'planogram_feedback'
               AND column_name = 'corrections') THEN
    ALTER TABLE public.planogram_feedback ALTER COLUMN corrections DROP NOT NULL;
  END IF;
END $$;

-- Indexes: per-capture lookups + org-scoped recency.
CREATE INDEX IF NOT EXISTS idx_planogram_feedback_capture
    ON public.planogram_feedback (capture_id);
CREATE INDEX IF NOT EXISTS idx_planogram_feedback_org_created
    ON public.planogram_feedback (org_id, created_at DESC);

-- RLS + service_role policy (the API writes with the service_role key, which
-- bypasses RLS; the explicit policy mirrors the other planogram_* tables).
ALTER TABLE public.planogram_feedback ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'planogram_feedback'
                   AND policyname = 'planogram_feedback_service_role') THEN
    CREATE POLICY planogram_feedback_service_role ON public.planogram_feedback
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.planogram_feedback IS
  'Human feedback feeding the AI learning loop: legacy corrections (corrected_by/corrections/notes) and detection-level accept/feedback (sku_id/bbox/reason/correct_sku_id/note/created_by).';
