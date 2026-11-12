-- HRMS phase 6: the Asset register on the server (the asset catalogue and its append-only event history:
-- purchased, issued, returned, transferred, repair out/back, lost, retired) plus the function that applies one
-- state transition atomically.
--
-- Run AFTER migration_hrms_core.sql (it refers to hrms_employees; it stops with a clear message if the core
-- migration has not been applied). The other phase migrations (payroll, time, lifecycle, privacy) are independent of
-- this file; the six may be applied in any order after the core one.
--
-- Target: the Kinematic database (`kinematic` on RDS kinematic-mumbai-test; self-hosted Supabase stack on ECS).
-- NOT applied to the Tata database -- only run there if explicitly asked.
-- Apply with the one-off Fargate pattern in CLAUDE.md ("Running SQL / migrations"): pre-check, `psql -1` (single
-- transaction), verify, then PostgREST reloads its schema from the NOTIFY at the bottom.
--
-- ADDITIVE and IDEMPOTENT: every statement is IF NOT EXISTS, CREATE OR REPLACE or a guarded DO block, so running it
-- twice is a no-op. No existing table is touched.
--
-- Tenancy and data protection: exactly as the core migration. Every row carries org_id + client_id (HRMS only writes
-- client_id NULL), RLS is ENABLED with NO policies, anon / authenticated lose their privileges, only the backend's
-- service role uses these tables and the function.
--
-- Note on two column names: the dashboard's AssetEvent has fields `on` (the event date) and `by` (the actor). Both are
-- SQL reserved words, so the physical columns are `on_date` and `by_name`; the API maps them back to `on` / `by` on the
-- wire, so the shape the dashboard sees is unchanged. `by_name` also matches hrms_pay_run_audit's existing column.

-- ── Pre-check ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hrms_employees') IS NULL THEN
    RAISE EXCEPTION 'migration_hrms_core.sql must be applied before migration_hrms_assets.sql';
  END IF;
END $$;

-- ── Assets (the catalogue) ──────────────────────────────────────────────────
-- status/holder_id/condition are the CURRENT state; they only ever move through hrms_asset_apply_event (and the initial
-- hrms_asset_create), never a plain UPDATE from the API. holder_id is the current holder while status = 'issued'; it is
-- set null (not cascade) if the holder's employee row is ever hard-deleted, so the asset survives.
CREATE TABLE IF NOT EXISTS public.hrms_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  tag           text NOT NULL,
  type          text NOT NULL,
  make          text NOT NULL,
  model         text NOT NULL,
  serial        text NOT NULL,
  purchase_date date NOT NULL,
  cost          numeric(14,2) NOT NULL,
  warranty_end  date,
  condition     text NOT NULL,
  status        text NOT NULL DEFAULT 'in_stock',
  holder_id     uuid REFERENCES public.hrms_employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_assets_tag_chk       CHECK (char_length(btrim(tag)) BETWEEN 1 AND 60),
  CONSTRAINT hrms_assets_type_chk      CHECK (type IN ('laptop', 'phone', 'sim', 'vehicle', 'id_card', 'uniform', 'tool')),
  CONSTRAINT hrms_assets_make_chk      CHECK (char_length(btrim(make)) BETWEEN 1 AND 120),
  CONSTRAINT hrms_assets_model_chk     CHECK (char_length(btrim(model)) BETWEEN 1 AND 120),
  CONSTRAINT hrms_assets_serial_chk    CHECK (char_length(btrim(serial)) BETWEEN 1 AND 120),
  CONSTRAINT hrms_assets_cost_chk      CHECK (cost >= 0),
  CONSTRAINT hrms_assets_condition_chk CHECK (condition IN ('new', 'good', 'fair', 'poor', 'damaged')),
  CONSTRAINT hrms_assets_status_chk    CHECK (status IN ('in_stock', 'issued', 'in_repair', 'lost', 'retired')),
  -- an asset is held by exactly one person only while it is issued; any other status has no holder
  CONSTRAINT hrms_assets_holder_chk    CHECK (status = 'issued' OR holder_id IS NULL)
);

-- ── Asset events (append-only history) ──────────────────────────────────────
-- One line per action. status is the asset's status AFTER this event, so the history can be replayed (the dashboard's
-- replayAsset takes the last event's status/toId). An event follows its asset (CASCADE); from_id / to_id follow the
-- employees (SET NULL) so the trail survives a purged person. There is no UPDATE or DELETE path for events in the API.
CREATE TABLE IF NOT EXISTS public.hrms_asset_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  client_id  uuid,
  asset_id   uuid NOT NULL REFERENCES public.hrms_assets(id)    ON DELETE CASCADE,
  on_date    date NOT NULL,
  kind       text NOT NULL,
  from_id    uuid REFERENCES public.hrms_employees(id) ON DELETE SET NULL,
  to_id      uuid REFERENCES public.hrms_employees(id) ON DELETE SET NULL,
  condition  text,
  status     text NOT NULL,
  ack        boolean,
  note       text,
  by_name    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hrms_asset_events_kind_chk      CHECK (kind IN ('purchased', 'issued', 'returned', 'transferred', 'repair_out', 'repair_back', 'lost', 'retired')),
  CONSTRAINT hrms_asset_events_status_chk    CHECK (status IN ('in_stock', 'issued', 'in_repair', 'lost', 'retired')),
  CONSTRAINT hrms_asset_events_condition_chk CHECK (condition IS NULL OR condition IN ('new', 'good', 'fair', 'poor', 'damaged')),
  CONSTRAINT hrms_asset_events_note_chk      CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT hrms_asset_events_by_chk        CHECK (char_length(btrim(by_name)) BETWEEN 1 AND 200)
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- One tag per org (the API assigns AST-<PREFIX>-NNN by type), and one serial per org, case-insensitive (the dashboard's
-- serial clash is a lower-case compare).
CREATE UNIQUE INDEX IF NOT EXISTS hrms_assets_org_tag_uq    ON public.hrms_assets (org_id, tag);
CREATE UNIQUE INDEX IF NOT EXISTS hrms_assets_org_serial_uq ON public.hrms_assets (org_id, lower(serial));
CREATE INDEX IF NOT EXISTS hrms_assets_org_idx        ON public.hrms_assets (org_id);
CREATE INDEX IF NOT EXISTS hrms_assets_org_type_idx   ON public.hrms_assets (org_id, type);
CREATE INDEX IF NOT EXISTS hrms_assets_holder_idx     ON public.hrms_assets (holder_id) WHERE holder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hrms_asset_events_org_idx   ON public.hrms_asset_events (org_id);
CREATE INDEX IF NOT EXISTS hrms_asset_events_asset_idx ON public.hrms_asset_events (asset_id, created_at, id);
CREATE INDEX IF NOT EXISTS hrms_asset_events_from_idx  ON public.hrms_asset_events (from_id) WHERE from_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hrms_asset_events_to_idx    ON public.hrms_asset_events (to_id)   WHERE to_id   IS NOT NULL;

-- ── Create: the asset + its 'purchased' event, atomically ───────────────────
-- addAsset creates a row in stock and its first ('purchased') event. PostgREST has no transactions, so the two inserts
-- live in one function: there is never an asset without its opening event, nor an event without its asset. A duplicate
-- tag or serial rolls the whole thing back (unique index 23505; the API maps the serial index to the dashboard's plain
-- reason and retries a raced tag). Returns the new 'purchased' event's id; the API reads the asset and that event back.
CREATE OR REPLACE FUNCTION public.hrms_asset_create(
  p_org uuid, p_asset uuid, p_tag text, p_type text, p_make text, p_model text, p_serial text,
  p_purchase_date date, p_cost numeric, p_warranty_end date, p_condition text, p_on date, p_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_event uuid := gen_random_uuid();
BEGIN
  IF p_org IS NULL OR p_asset IS NULL OR p_tag IS NULL OR p_type IS NULL THEN
    RAISE EXCEPTION 'hrms_asset_create: invalid arguments' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.hrms_assets (
    id, org_id, client_id, tag, type, make, model, serial, purchase_date, cost, warranty_end, condition, status, holder_id, created_at, updated_at
  ) VALUES (
    p_asset, p_org, NULL, p_tag, p_type, p_make, p_model, p_serial, p_purchase_date, p_cost, p_warranty_end, p_condition, 'in_stock', NULL, v_now, v_now
  );

  INSERT INTO public.hrms_asset_events (
    id, org_id, client_id, asset_id, on_date, kind, from_id, to_id, condition, status, ack, note, by_name, created_at, updated_at
  ) VALUES (
    v_event, p_org, NULL, p_asset, p_on, 'purchased', NULL, NULL, p_condition, 'in_stock', NULL, 'Added to the register.',
    COALESCE(NULLIF(btrim(p_by), ''), 'Unknown'), v_now, v_now
  );

  RETURN v_event;
END;
$fn$;

-- ── Apply one state transition, atomically ──────────────────────────────────
-- The seven commands (issue, return, transfer, repair out/back, lost, retire) each: lock the asset row, check the
-- transition against the CURRENT status, append the event and move the asset's status / holder / condition -- all in one
-- transaction. The status is re-checked under the row lock, so of two concurrent issues of one asset exactly one wins
-- and the other is refused. The transition rules and the resulting event mirror the dashboard's store.ts exactly.
--   from_id is always the current holder (return, transfer, repair_out, lost); to_id is the recipient (issue, transfer).
-- Errors carry a token as the message (SQLSTATE P0001): ASSET_NOT_FOUND, ASSET_STATE (illegal transition),
-- ASSET_SAME_HOLDER (transfer to the current holder); the API maps them to the dashboard's plain reasons. Returns the
-- new event's id; the API reads the updated asset and that event back as { asset, event }.
CREATE OR REPLACE FUNCTION public.hrms_asset_apply_event(
  p_org uuid, p_asset uuid, p_kind text, p_on date, p_to_id uuid, p_condition text, p_next_status text, p_ack boolean, p_note text, p_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_asset         public.hrms_assets%ROWTYPE;
  v_now           timestamptz := clock_timestamp();
  v_from          uuid;
  v_new_status    text;
  v_new_holder    uuid;
  v_new_condition text;
  v_ev_from       uuid := NULL;
  v_ev_to         uuid := NULL;
  v_ev_condition  text := NULL;
  v_ev_ack        boolean := NULL;
  v_event         uuid := gen_random_uuid();
BEGIN
  IF p_org IS NULL OR p_asset IS NULL OR p_kind IS NULL THEN
    RAISE EXCEPTION 'hrms_asset_apply_event: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_asset FROM public.hrms_assets WHERE id = p_asset AND org_id = p_org AND client_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  v_from          := v_asset.holder_id;
  v_new_status    := v_asset.status;
  v_new_holder    := v_asset.holder_id;
  v_new_condition := v_asset.condition;

  IF p_kind = 'issued' THEN
    IF v_asset.status <> 'in_stock' THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    v_new_status := 'issued'; v_new_holder := p_to_id; v_new_condition := COALESCE(p_condition, v_asset.condition);
    v_ev_to := p_to_id; v_ev_condition := p_condition; v_ev_ack := true;
  ELSIF p_kind = 'returned' THEN
    IF v_asset.status <> 'issued' THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    IF p_next_status IS NULL OR p_next_status NOT IN ('in_stock', 'in_repair', 'retired') THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    v_new_status := p_next_status; v_new_holder := NULL; v_new_condition := COALESCE(p_condition, v_asset.condition);
    v_ev_from := v_from; v_ev_condition := p_condition;
  ELSIF p_kind = 'transferred' THEN
    IF v_asset.status <> 'issued' THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    IF v_from IS NOT DISTINCT FROM p_to_id THEN RAISE EXCEPTION 'ASSET_SAME_HOLDER' USING ERRCODE = 'P0001'; END IF;
    v_new_status := 'issued'; v_new_holder := p_to_id; v_new_condition := COALESCE(p_condition, v_asset.condition);
    v_ev_from := v_from; v_ev_to := p_to_id; v_ev_condition := p_condition; v_ev_ack := true;
  ELSIF p_kind = 'repair_out' THEN
    IF v_asset.status NOT IN ('in_stock', 'issued') THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    v_new_status := 'in_repair'; v_new_holder := NULL;  -- condition unchanged
    v_ev_from := v_from;
  ELSIF p_kind = 'repair_back' THEN
    IF v_asset.status <> 'in_repair' THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    v_new_status := 'in_stock'; v_new_holder := NULL; v_new_condition := COALESCE(p_condition, v_asset.condition);
    v_ev_condition := p_condition;
  ELSIF p_kind = 'lost' THEN
    IF v_asset.status NOT IN ('in_stock', 'issued') THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    v_new_status := 'lost'; v_new_holder := NULL;  -- condition unchanged
    v_ev_from := v_from;
  ELSIF p_kind = 'retired' THEN
    IF v_asset.status NOT IN ('in_stock', 'in_repair') THEN RAISE EXCEPTION 'ASSET_STATE' USING ERRCODE = 'P0001'; END IF;
    v_new_status := 'retired'; v_new_holder := NULL;  -- holder already null, condition unchanged
  ELSE
    RAISE EXCEPTION 'ASSET_BAD_KIND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.hrms_asset_events (
    id, org_id, client_id, asset_id, on_date, kind, from_id, to_id, condition, status, ack, note, by_name, created_at, updated_at
  ) VALUES (
    v_event, p_org, NULL, p_asset, p_on, p_kind, v_ev_from, v_ev_to, v_ev_condition, v_new_status, v_ev_ack, p_note,
    COALESCE(NULLIF(btrim(p_by), ''), 'Unknown'), v_now, v_now
  );

  UPDATE public.hrms_assets
     SET status = v_new_status, holder_id = v_new_holder, condition = v_new_condition, updated_at = v_now
   WHERE id = p_asset;

  RETURN v_event;
END;
$fn$;

-- ── Row level security: ON, no policies ─────────────────────────────────────
ALTER TABLE public.hrms_assets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrms_asset_events ENABLE ROW LEVEL SECURITY;

-- ── Privileges: only the backend (service_role) touches these ───────────────
-- Same pattern as the core / payroll / lifecycle migrations: Supabase hands anon / authenticated everything on new public
-- tables and PUBLIC may execute new functions. Guarded by role existence so the same file runs on a plain Postgres too.
DO $$
DECLARE
  t text;
  f text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hrms_assets', 'hrms_asset_events'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.hrms_asset_create(uuid, uuid, text, text, text, text, text, date, numeric, date, text, date, text)',
    'public.hrms_asset_apply_event(uuid, uuid, text, date, uuid, text, text, boolean, text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

-- PostgREST caches the schema: tell it to reload.
NOTIFY pgrst, 'reload schema';
