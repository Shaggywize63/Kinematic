-- PERF (2026-10 audit): the push dispatcher polls `notifications` for unsent rows every 60 s per project
-- (src/services/notifications.service.ts: .is('sent_at', null).gte('created_at', …).order('created_at').limit(200)).
-- No index covers that predicate, so every tick is a sequential scan. Live pg_stat_user_tables since the last stats reset:
--   Tata DB:      notifications 239,595 rows, 331,310 seq scans, 22,962,715,127 tuples read by seq scans
--   Kinematic DB: notifications  12,406 rows,  53,858 seq scans,    506,794,195 tuples read by seq scans
-- A partial index holds only the (normally empty) unsent rows, so the poll becomes an index probe and costs ~nothing.
--
-- CONCURRENTLY: no write lock on a hot table. Must NOT run inside a transaction block. Safe to re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_unsent
  ON public.notifications (created_at)
  WHERE sent_at IS NULL;

-- Optional follow-ups after the above (pick up with EXPLAIN on real data):
--   idx_notifications_broadcast_id is never used in the Tata DB (1.7 MB) — candidate to drop.
--   alertScans.service.ts filters notifications by data->>'kind' + created_at: add
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_kind_created ON public.notifications ((data->>'kind'), created_at);
--   if those scans become hot.
-- NOTIFY pgrst, 'reload schema';  -- not required for an index
