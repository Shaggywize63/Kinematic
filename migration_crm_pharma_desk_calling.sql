-- ============================================================
-- KINEMATIC CRM — Pharma Desk-Calling + Lightweight Order Ledger
-- (Maa Mansha Pharma and any CRM client that enables the calling desk)
--
-- Additive + idempotent. Safe to run multiple times.
-- After DDL on PostgREST-backed tenants: NOTIFY pgrst, 'reload schema';
--
-- Two tables:
--   crm_daily_call_tasks  — the auto-generated daily calling list + the
--                           3-state disposition (Order Taken / Order Pending /
--                           No Order Today). One row per customer per day;
--                           previous days are NEVER overwritten (append-only
--                           history, survives employee offboarding).
--   crm_customer_orders   — a lightweight order ledger. One row per captured
--                           order, written by the desk ("Order Taken") AND by
--                           MR field visits. Single source of truth for
--                           customer-wise / MR-wise sales, RFM intelligence,
--                           and the order-based alert scans.
--
-- All timestamps are stored UTC (timestamptz); the app renders them in IST.
-- Both tables carry org_id + client_id for multi-tenant isolation.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Daily calling tasks ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_daily_call_tasks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid        NOT NULL,
  client_id         uuid,
  call_date         date        NOT NULL,
  -- The customer this call targets. customer_type lets the daily list draw
  -- from CRM accounts (established customers) and/or leads (prospects).
  customer_type     text        NOT NULL DEFAULT 'account'
                                 CHECK (customer_type IN ('account','lead')),
  customer_id       uuid        NOT NULL,
  -- Denormalised snapshot so the historical list is readable even if the
  -- customer is later renamed or removed.
  customer_name     text,
  customer_phone    text,
  -- Desk operator (tele-caller) the row is assigned to.
  assigned_operator uuid,
  -- The 3 pharma call statuses + the un-actioned 'pending' default.
  status            text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','order_taken','order_pending','no_order')),
  -- Order value captured when status = order_taken (lightweight capture).
  order_value       numeric(18,2),
  -- Link to the order-ledger row created on "Order Taken".
  order_id          uuid,
  notes             text,
  called_at         timestamptz,
  -- For the "Order Pending → did it convert?" alert: set true once a
  -- pending customer later records an order_taken (same or later day).
  pending_resolved  boolean     NOT NULL DEFAULT false,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid
);

-- One task per customer per day per client (the generator is idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_daily_call_tasks_day_customer
  ON public.crm_daily_call_tasks(org_id, client_id, call_date, customer_type, customer_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_daily_call_tasks_list
  ON public.crm_daily_call_tasks(org_id, client_id, call_date, status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_daily_call_tasks_operator
  ON public.crm_daily_call_tasks(org_id, client_id, assigned_operator, call_date)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_daily_call_tasks_customer
  ON public.crm_daily_call_tasks(org_id, client_id, customer_type, customer_id)
  WHERE deleted_at IS NULL;

-- ── Lightweight customer-order ledger ───────────────────────
CREATE TABLE IF NOT EXISTS public.crm_customer_orders (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid        NOT NULL,
  client_id         uuid,
  customer_type     text        NOT NULL DEFAULT 'account'
                                 CHECK (customer_type IN ('account','lead')),
  customer_id       uuid        NOT NULL,
  customer_name     text,
  order_date        date        NOT NULL DEFAULT CURRENT_DATE,
  order_value       numeric(18,2) NOT NULL DEFAULT 0,
  -- Where the order was captured.
  source            text        NOT NULL DEFAULT 'desk'
                                 CHECK (source IN ('desk','field','manual')),
  -- Provenance links (nullable; one or the other depending on source).
  call_task_id      uuid        REFERENCES public.crm_daily_call_tasks(id) ON DELETE SET NULL,
  visit_id          uuid,
  -- Employee who captured it (desk operator or MR). Ownership lives on the
  -- row, NOT the person — history stays with the company if they leave.
  captured_by       uuid,
  notes             text,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid
);

CREATE INDEX IF NOT EXISTS idx_crm_customer_orders_customer
  ON public.crm_customer_orders(org_id, client_id, customer_type, customer_id, order_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_customer_orders_date
  ON public.crm_customer_orders(org_id, client_id, order_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_customer_orders_captured_by
  ON public.crm_customer_orders(org_id, client_id, captured_by, order_date DESC)
  WHERE deleted_at IS NULL;

-- Late FK from the task to its order (added after both tables exist).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_call_task_order') THEN
    ALTER TABLE public.crm_daily_call_tasks
      ADD CONSTRAINT fk_call_task_order
      FOREIGN KEY (order_id) REFERENCES public.crm_customer_orders(id) ON DELETE SET NULL;
  END IF;
END $$;

-- PostgREST schema cache reload (no-op on direct-PG tenants).
NOTIFY pgrst, 'reload schema';
