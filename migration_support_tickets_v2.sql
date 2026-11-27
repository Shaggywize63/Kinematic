-- Support tickets v2 — the ticketing module every tenant gets by default.
--
-- What changes:
--   * `category` becomes the ticket TYPE, with the taxonomy the product needs: how-to, issue, bug,
--     change request, new module, data correction, billing, access request, training, other.
--     The two old names that no longer fit are migrated (data → data_correction,
--     feature_request → new_module); the service still accepts the old names on input.
--   * `status` gains `triaged`, `release_pending` and `rejected`.
--   * `platforms` (text[]) records where the customer hit it — web / android / ios / whatsapp / other.
--   * `area` records which part of the product it is about (generic Kinematic modules, never a
--     per-client column — a client's own taxonomy belongs in custom fields).
--   * `first_response_at` stamps the team's first reply, so SLA reporting has something to measure.
--
-- Additive and idempotent. Kinematic project only (every ticket lives in SUPPORT_PROJECT).
BEGIN;

-- ── New columns ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS platforms         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS area              text,
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz;

-- ── Category: widen first, then migrate the two renamed values ────────────────────────────────────
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_category_check;
UPDATE public.support_tickets SET category = 'data_correction' WHERE category = 'data';
UPDATE public.support_tickets SET category = 'new_module'      WHERE category = 'feature_request';
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_category_check CHECK (category IN (
    'how_to', 'issue', 'bug', 'change_request', 'new_module',
    'data_correction', 'billing', 'access_request', 'training', 'other'
  ));

-- ── Status: three new ones ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_status_check;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_status_check CHECK (status IN (
    'open', 'triaged', 'in_progress', 'waiting_on_customer', 'release_pending',
    'resolved', 'closed', 'rejected'
  ));

-- ── Platforms: only the values the product offers ─────────────────────────────────────────────────
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_platforms_check;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_platforms_check CHECK (
    platforms <@ ARRAY['web', 'android', 'ios', 'whatsapp', 'other']::text[]
  );

-- ── Indexes for the new list filters ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_support_tickets_category  ON public.support_tickets (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_area      ON public.support_tickets (area, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_platforms ON public.support_tickets USING gin (platforms);

COMMIT;
NOTIFY pgrst, 'reload schema';
