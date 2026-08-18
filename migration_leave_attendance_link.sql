-- Leave ↔ attendance stitching + year-end carry-forward support.
--
-- The leave engine (leave_types / holidays / leave_requests / leave_balances)
-- was already built but dormant: an approved leave never showed up on the
-- attendance sheet (the rep read as "absent"), and there was no way to carry a
-- leftover balance into the next year. This migration adds the two DB pieces
-- the activation needs:
--
--   1. an `on_leave` attendance status, and a `leave_request_id` link so an
--      auto-generated leave-day row can be traced back to its request and
--      safely removed if the leave is later cancelled — WITHOUT ever touching
--      a real check-in (leave_request_id is null on real rows), and
--   2. a unique key on leave_balances(org_id,user_id,leave_type_id,year) so the
--      carry-forward job can idempotently upsert the opening balance.
--
-- Additive + idempotent. Apply to every Supabase project the backend serves
-- (default/Tata + kinematic).

-- 1. New attendance status (enum value add is idempotent via IF NOT EXISTS).
alter type public.attendance_status add value if not exists 'on_leave';

-- 2. Link a leave-day attendance row back to its request.
alter table public.attendance
  add column if not exists leave_request_id uuid references public.leave_requests(id) on delete set null;

create index if not exists idx_attendance_leave_request
  on public.attendance(leave_request_id) where leave_request_id is not null;

-- 3. Idempotent carry-forward: one opening balance per (user, type, year).
create unique index if not exists uq_leave_balances_user_type_year
  on public.leave_balances(org_id, user_id, leave_type_id, year);

comment on column public.attendance.leave_request_id is 'Set on rows auto-generated from an approved leave request; null on real check-ins. Used to reverse the auto-mark on cancel.';
