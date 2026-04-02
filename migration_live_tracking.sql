-- 1. Create work_activity table if it doesn't exist
-- This table tracks historical user locations and activities for live reporting
CREATE TABLE IF NOT EXISTS public.work_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    client_id UUID,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    attendance_id UUID,
    activity_type TEXT NOT NULL, -- 'CHECK_IN', 'CHECK_OUT', 'HEARTBEAT', 'FORM_SUBMIT', etc.
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    battery_percentage INTEGER,
    captured_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Add columns to users table for live tracking and battery monitoring
-- This stores the latest known status for quick retrieval on the live dashboard
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS battery_percentage INTEGER;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_latitude DOUBLE PRECISION;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_longitude DOUBLE PRECISION;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_location_updated_at TIMESTAMPTZ;

-- 3. Ensure battery_percentage exists on work_activity if the table existed but column didn't
ALTER TABLE public.work_activity ADD COLUMN IF NOT EXISTS battery_percentage INTEGER;

-- 4. Enable RLS and add default policy for visibility
ALTER TABLE public.work_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.work_activity;
CREATE POLICY "Allow all for authenticated users" ON public.work_activity
    FOR ALL USING (true); -- Broad visibility for internal tool
