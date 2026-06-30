-- Scheduled report digests — recurring (daily/weekly/monthly) emails that
-- render an analytics report and send it to a recipient list. Complements
-- crm_email_alerts (one-shot scheduled sends): these repeat on a cadence and
-- regenerate fresh report data each run. Dispatched by runDueReportDigests()
-- (in-process hourly tick + POST /api/v1/cron/dispatch-report-digests).

CREATE TABLE IF NOT EXISTS public.crm_report_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  created_by    uuid,
  name          text NOT NULL,
  report_key    text NOT NULL,                 -- key into the server-side report catalog
  config        jsonb,                         -- reserved: filters / range overrides
  frequency     text NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily','weekly','monthly')),
  send_hour     int  NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),  -- UTC
  day_of_week   int  CHECK (day_of_week BETWEEN 0 AND 6),    -- 0=Sun (weekly)
  day_of_month  int  CHECK (day_of_month BETWEEN 1 AND 28),  -- (monthly)
  to_emails     text[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The dispatcher scans for active, due schedules — index the hot path.
CREATE INDEX IF NOT EXISTS idx_report_schedules_due
  ON public.crm_report_schedules (next_run_at)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_report_schedules_org
  ON public.crm_report_schedules (org_id);
