-- Sink low-value terminal leads (unqualified, lost) to the bottom of the leads
-- list without disturbing the order of active leads.
--
-- status_rank is a STORED generated column: 0 for active leads, 1 for
-- unqualified/lost. It stays correct automatically as a lead's status changes.
-- The leads-list query ORDER BYs `status_rank ASC` first (so rank-0 active
-- leads come before rank-1 terminal ones), then the caller's chosen / default
-- sort within each group — but ONLY for projects opted in via the backend env
-- LEADS_STATUS_RANK_PROJECTS (comma-separated project keys; OFF by default).
--
-- Converted leads intentionally keep their normal position (rank 0) so reps can
-- still track the customer's history in the Leads list.
--
-- Apply per-project: run against each project DB that should get the behaviour
-- (e.g. Kinematic). Do NOT enable a project in LEADS_STATUS_RANK_PROJECTS until
-- its DB has run this migration, or the list query would ORDER BY a missing
-- column. Idempotent — safe to re-run.

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS status_rank smallint
  GENERATED ALWAYS AS (CASE WHEN status IN ('unqualified', 'lost') THEN 1 ELSE 0 END) STORED;

-- Keep the "rank, then <sort>" ORDER BY fast on large lead lists.
CREATE INDEX IF NOT EXISTS crm_leads_status_rank_idx
  ON crm_leads (status_rank);
