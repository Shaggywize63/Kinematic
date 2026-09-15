-- ============================================================================
-- Outlet visit frequency / priority (module: route_optimization)
--
-- The "Outlet Priorities" editor (dashboard /route-priorities) and the route
-- optimizer read/write this table via getOutletFrequency / upsertOutletFrequency
-- (src/controllers/route-plan.controller.ts) and route-suggestion.service.ts,
-- but NO migration ever created it — phaseb_beat_route_modules.sql only
-- registered the modules. So GET /route-plans/outlet-frequency returned
-- 400 (relation "outlet_visit_frequency" does not exist), which made the whole
-- Outlet Priorities page fail to open. This creates the table with exactly the
-- columns the code reads/writes.
--
-- One row per (org, store). Upsert is done read-then-write in the controller,
-- but the UNIQUE index below also makes it safe under concurrency and lets a
-- future ON CONFLICT path work.
--
-- Idempotent (IF NOT EXISTS) so it can be applied to any project (Kinematic +
-- Tata) safely and re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.outlet_visit_frequency (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  store_id        uuid NOT NULL,
  frequency       text,                 -- daily|weekly|fortnightly|biweekly|monthly|quarterly
  priority        text,                 -- high|medium|low
  preferred_day   integer,              -- 0-6 (preferred day of week), optional
  target_value    numeric,             -- optional per-outlet target (e.g. order value)
  last_visited_at timestamptz,          -- read by the optimizer for overdue detection
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One cadence/priority row per outlet per org (the controller upserts on this).
CREATE UNIQUE INDEX IF NOT EXISTS uq_outlet_freq_org_store
  ON public.outlet_visit_frequency (org_id, store_id);

-- Fast org-scoped listing.
CREATE INDEX IF NOT EXISTS idx_outlet_freq_org
  ON public.outlet_visit_frequency (org_id);

-- RLS: deny-all to anon/authenticated; the Express backend uses service_role
-- (matches every other distribution/route table in this schema).
ALTER TABLE public.outlet_visit_frequency ENABLE ROW LEVEL SECURITY;
