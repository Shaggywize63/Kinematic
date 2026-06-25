-- Security alerts — mock-location and VPN violations reported by the
-- mobile apps. Populated by POST /api/v1/misc/security/alert; read by
-- the dashboard's /dashboard/security-alerts page; the controller also
-- fans out notifications to the rep's direct supervisor + every
-- city_manager/admin in the org.

CREATE TABLE IF NOT EXISTS public.security_alerts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  -- Client scoping mirrors leads/deals/contacts/accounts.
  client_id   uuid,
  user_id     uuid        NOT NULL,
  type        text        NOT NULL CHECK (type IN ('MOCK_LOCATION','VPN_DETECTED')),
  -- Free-form action verb the app sends — ATTENDANCE_CHECK_IN,
  -- LEAD_CREATE, FORM_SUBMISSION, APP_LAUNCH, etc.
  action      varchar(100) NOT NULL,
  -- GPS coords at violation. Null for VPN-only events caught before
  -- a location fix lands (e.g. app launch).
  lat         double precision,
  lng         double precision,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_alerts_org_created
  ON public.security_alerts(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_alerts_user_created
  ON public.security_alerts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_alerts_org_type
  ON public.security_alerts(org_id, type);

ALTER TABLE public.security_alerts ENABLE ROW LEVEL SECURITY;

-- Service-role only: every read/write goes through the backend
-- (`supabaseAdmin`). Anon/auth roles have no policy and no access.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='security_alerts'
      AND policyname='service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.security_alerts
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
