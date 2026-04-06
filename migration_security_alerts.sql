-- SECURITY ALERTS MIGRATION
-- Table to store mock location and VPN violations

CREATE TABLE IF NOT EXISTS public.security_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- 'MOCK_LOCATION', 'VPN_DETECTED'
    action VARCHAR(100) NOT NULL, -- 'ATTENDANCE_CHECK_IN', 'FORM_SUBMISSION', etc.
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::JSONB
);

-- Enable RLS
ALTER TABLE public.security_alerts ENABLE ROW LEVEL SECURITY;

-- Policy: Admins can see all alerts in their org
CREATE POLICY "Admins can view security alerts" ON public.security_alerts
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = auth.uid()
            AND role IN ('super_admin', 'admin', 'main_admin', 'sub_admin')
            AND org_id = security_alerts.org_id
        )
    );

-- Policy: System can insert alerts (handled via service role or app logic)
-- Note: In this architecture, we use supabaseAdmin (servicerole) from the backend.
