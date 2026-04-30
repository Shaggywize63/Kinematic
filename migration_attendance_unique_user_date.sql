-- Migration: enforce one attendance row per (user_id, date)
-- Context: prevents duplicate check-ins under retry/race conditions and is the
-- target conflict for the `upsert(..., onConflict: 'user_id,date')` in
-- attendance.controller.ts checkin().

BEGIN;

-- Step 1: De-duplicate existing rows. Keep the earliest checkin per user/date,
-- merge in any non-null checkout/selfie/break fields from later rows, and
-- delete the rest. We use a CTE with row_number ordered by checkin_at NULLS
-- LAST then created_at so the canonical row is the one with the actual data.
WITH ranked AS (
  SELECT id,
         user_id,
         date,
         row_number() OVER (
           PARTITION BY user_id, date
           ORDER BY checkin_at NULLS LAST, created_at ASC
         ) AS rn
  FROM attendance
),
merge_target AS (
  SELECT user_id, date, id AS keeper_id
  FROM ranked
  WHERE rn = 1
),
merge_source AS (
  SELECT a.id,
         a.user_id,
         a.date,
         a.checkout_at,
         a.checkout_lat,
         a.checkout_lng,
         a.checkout_selfie_url,
         a.working_minutes,
         a.total_hours,
         a.break_minutes
  FROM attendance a
  JOIN ranked r ON r.id = a.id
  WHERE r.rn > 1
)
UPDATE attendance t
SET checkout_at         = COALESCE(t.checkout_at,         s.checkout_at),
    checkout_lat        = COALESCE(t.checkout_lat,        s.checkout_lat),
    checkout_lng        = COALESCE(t.checkout_lng,        s.checkout_lng),
    checkout_selfie_url = COALESCE(t.checkout_selfie_url, s.checkout_selfie_url),
    working_minutes     = COALESCE(t.working_minutes,     s.working_minutes),
    total_hours         = COALESCE(t.total_hours,         s.total_hours),
    break_minutes       = COALESCE(t.break_minutes,       s.break_minutes)
FROM merge_source s
JOIN merge_target mt ON mt.user_id = s.user_id AND mt.date = s.date
WHERE t.id = mt.keeper_id;

-- Step 2: drop the duplicate rows (everything with rn > 1)
DELETE FROM attendance
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY user_id, date
             ORDER BY checkin_at NULLS LAST, created_at ASC
           ) AS rn
    FROM attendance
  ) x
  WHERE rn > 1
);

-- Step 3: add the constraint
ALTER TABLE attendance
  DROP CONSTRAINT IF EXISTS attendance_user_id_date_key;

ALTER TABLE attendance
  ADD CONSTRAINT attendance_user_id_date_key UNIQUE (user_id, date);

COMMIT;
