-- ============================================================================
-- AI Planogram Execution Engine — schema migration
-- ============================================================================
-- Adds tables that power shelf recognition, planogram compliance, AI
-- recommendations, the continuous-learning feedback loop, and analytics.
-- All tables enforce multi-tenant isolation via org_id and (where relevant)
-- client_id; RLS policies should be added in a follow-up migration.
-- ============================================================================

-- A versioned planogram (the brand's "expected" shelf layout)
CREATE TABLE IF NOT EXISTS public.planograms (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    client_id       uuid        NULL,
    name            text        NOT NULL,
    category        text        NULL,                -- e.g. "Beverages"
    store_format    text        NULL,                -- modern_trade | general_trade | hyper
    source_url      text        NULL,                -- original PDF/image
    layout          jsonb       NOT NULL DEFAULT '{}'::jsonb,
                                                     -- {shelves:[{index,sku_id,sku_name,facings,position}]}
    expected_skus   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    version         int         NOT NULL DEFAULT 1,
    is_active       boolean     NOT NULL DEFAULT true,
    created_by      uuid        NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planograms_org      ON public.planograms (org_id);
CREATE INDEX IF NOT EXISTS idx_planograms_client   ON public.planograms (client_id);
CREATE INDEX IF NOT EXISTS idx_planograms_active   ON public.planograms (is_active) WHERE is_active;

-- Maps a planogram to one or more outlets/stores. A store may rotate planograms.
CREATE TABLE IF NOT EXISTS public.planogram_assignments (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    planogram_id    uuid        NOT NULL REFERENCES public.planograms(id) ON DELETE CASCADE,
    store_id        uuid        NULL,
    zone_id         uuid        NULL,
    city_id         uuid        NULL,
    valid_from      date        NOT NULL DEFAULT current_date,
    valid_to        date        NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planogram_assignments_lookup
    ON public.planogram_assignments (org_id, store_id, valid_from);

-- A single shelf capture from a field rep, with raw image, GPS, and timing
CREATE TABLE IF NOT EXISTS public.planogram_captures (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    client_id       uuid        NULL,
    fe_id           uuid        NOT NULL,
    store_id        uuid        NULL,
    visit_id        uuid        NULL,
    planogram_id    uuid        NULL REFERENCES public.planograms(id) ON DELETE SET NULL,
    image_url       text        NOT NULL,
    image_width     int         NULL,
    image_height    int         NULL,
    capture_lat     double precision NULL,
    capture_lng     double precision NULL,
    angle_score     real        NULL,                -- 0..1, framing quality
    blur_score      real        NULL,                -- 0..1, image quality
    glare_score     real        NULL,                -- 0..1, lighting quality
    device_meta     jsonb       NULL,
    captured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planogram_captures_org_store ON public.planogram_captures (org_id, store_id);
CREATE INDEX IF NOT EXISTS idx_planogram_captures_fe        ON public.planogram_captures (fe_id, captured_at DESC);

-- AI vision result for a capture: detected SKUs, bounding boxes, model confidences
CREATE TABLE IF NOT EXISTS public.planogram_recognition (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id          uuid        NOT NULL REFERENCES public.planogram_captures(id) ON DELETE CASCADE,
    org_id              uuid        NOT NULL,
    detected_skus       jsonb       NOT NULL DEFAULT '[]'::jsonb,
                                                     -- [{sku_id, sku_name, facings, shelf_index,
                                                     --   bbox:[x,y,w,h], confidence, is_competitor}]
    shelf_map           jsonb       NULL,            -- normalized shelf grid
    overall_confidence  real        NOT NULL DEFAULT 0,
    model_versions      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    needs_review        boolean     NOT NULL DEFAULT false,
    raw_response        jsonb       NULL,
    processed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planogram_recognition_capture ON public.planogram_recognition (capture_id);

-- Compliance score for a (capture, planogram) pair
CREATE TABLE IF NOT EXISTS public.planogram_compliance (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL,
    client_id           uuid        NULL,
    capture_id          uuid        NOT NULL REFERENCES public.planogram_captures(id) ON DELETE CASCADE,
    planogram_id        uuid        NOT NULL REFERENCES public.planograms(id) ON DELETE CASCADE,
    store_id            uuid        NULL,
    fe_id               uuid        NULL,
    score               real        NOT NULL,        -- 0..100
    presence_score      real        NOT NULL,        -- % expected SKUs present
    facing_score        real        NOT NULL,        -- weighted facings deviation
    position_score      real        NOT NULL,        -- shelf+adjacency match
    competitor_share    real        NOT NULL DEFAULT 0,
    missing_skus        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    misplaced_skus      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    facing_deltas       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    recommendations     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planogram_compliance_org_store_time
    ON public.planogram_compliance (org_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_planogram_compliance_planogram
    ON public.planogram_compliance (planogram_id, created_at DESC);

-- Manual-correction feedback (human-in-the-loop) — feeds the learning loop
CREATE TABLE IF NOT EXISTS public.planogram_feedback (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL,
    capture_id          uuid        NOT NULL REFERENCES public.planogram_captures(id) ON DELETE CASCADE,
    corrected_by        uuid        NOT NULL,
    corrections         jsonb       NOT NULL DEFAULT '[]'::jsonb,
                                                     -- [{sku_id, action:add|remove|relabel, bbox, note}]
    notes               text        NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planogram_feedback_capture ON public.planogram_feedback (capture_id);

COMMENT ON TABLE public.planograms             IS 'Brand planograms (expected layouts).';
COMMENT ON TABLE public.planogram_assignments  IS 'Maps a planogram to outlets/zones with validity window.';
COMMENT ON TABLE public.planogram_captures     IS 'Raw shelf captures from field reps.';
COMMENT ON TABLE public.planogram_recognition  IS 'AI vision detections for a capture.';
COMMENT ON TABLE public.planogram_compliance   IS 'Compliance score and gap analysis.';
COMMENT ON TABLE public.planogram_feedback     IS 'Human corrections feeding the AI learning loop.';
