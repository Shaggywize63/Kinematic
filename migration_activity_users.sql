-- Create activity_users junction table
CREATE TABLE IF NOT EXISTS public.activity_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id UUID NOT NULL REFERENCES public.activities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(activity_id, user_id)
);

-- Enable RLS
ALTER TABLE public.activity_users ENABLE ROW LEVEL SECURITY;

-- Add policies (assuming service_role bypasses as usual, but good to have)
CREATE POLICY "Allow all for authenticated users" ON public.activity_users
    FOR ALL USING (auth.role() = 'authenticated');

-- Comment
COMMENT ON TABLE public.activity_users IS 'Maps Field Executives to Activities';
