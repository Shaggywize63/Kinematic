-- Leave management + attendance regularization + approval flows.
-- Applied to both Supabase projects. RLS enabled (deny-by-default) on every
-- table — the API is service-role-only, so this closes direct anon/authenticated
-- access without affecting the backend (per the security-advisor hardening).

-- ── Leave types (admin-configured catalogue) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.leave_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  client_id         uuid,
  name              text NOT NULL,
  code              text,
  is_paid           boolean NOT NULL DEFAULT true,
  annual_quota      numeric NOT NULL DEFAULT 0,     -- entitled days per year (0 = unlimited/LOP)
  allow_half_day    boolean NOT NULL DEFAULT true,
  max_carry_forward numeric NOT NULL DEFAULT 0,
  requires_attachment boolean NOT NULL DEFAULT false, -- e.g. medical certificate
  color             text,
  is_active         boolean NOT NULL DEFAULT true,
  position          int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── Holidays (org calendar; leave day-count skips these + weekends) ────────
CREATE TABLE IF NOT EXISTS public.holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  client_id    uuid,
  holiday_date date NOT NULL,
  name         text NOT NULL,
  is_optional  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_holidays_org_date ON public.holidays (org_id, holiday_date);

-- ── Per-user opening balance / carry-forward / manual adjustment ──────────
-- Live "used"/"pending" are computed from leave_requests; this table only holds
-- the opening (carry-forward) + admin adjustments per (user, type, year).
CREATE TABLE IF NOT EXISTS public.leave_balances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  user_id       uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  year          int  NOT NULL,
  opening       numeric NOT NULL DEFAULT 0,
  adjustment    numeric NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_balance ON public.leave_balances (user_id, leave_type_id, year);

-- ── Leave requests (the approval-flow core) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.leave_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  client_id      uuid,
  user_id        uuid NOT NULL,
  leave_type_id  uuid NOT NULL,
  from_date      date NOT NULL,
  to_date        date NOT NULL,
  half_day_start boolean NOT NULL DEFAULT false,
  half_day_end   boolean NOT NULL DEFAULT false,
  days           numeric NOT NULL DEFAULT 0,
  reason         text,
  contact_number text,
  attachment_url text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approver_id    uuid,                 -- intended approver (requester's supervisor)
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leave_req_user   ON public.leave_requests (org_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_req_approver ON public.leave_requests (org_id, approver_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_req_dates  ON public.leave_requests (org_id, from_date, to_date);

-- ── Attendance regularization requests ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_regularizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  client_id             uuid,
  user_id               uuid NOT NULL,
  att_date              date NOT NULL,
  type                  text NOT NULL CHECK (type IN ('missing_checkin','missing_checkout','wrong_time','on_duty','wfh')),
  requested_checkin_at  timestamptz,
  requested_checkout_at timestamptz,
  reason                text,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approver_id           uuid,
  decided_by            uuid,
  decided_at            timestamptz,
  decision_note         text,
  attendance_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_att_reg_user     ON public.attendance_regularizations (org_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_att_reg_approver ON public.attendance_regularizations (org_id, approver_id, status);

-- Deny-by-default RLS (service-role backend bypasses; closes direct API access).
ALTER TABLE public.leave_types                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_balances             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_regularizations ENABLE ROW LEVEL SECURITY;
