-- ── SUPABASE ONE-TIME SETUP FOR KINEMATIC AI ──────────────────────

-- This function allows the backend AI to execute raw SQL scripts (migrations)
-- and search across all organizations for debugging purposes.
-- Security Note: This is defined as 'SECURITY DEFINER', but should normally 
-- only be callable by the 'service_role' key which bypasses RLS.

CREATE OR REPLACE FUNCTION public.exec_sql(sql_query TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql_query;
END;
$$;

COMMENT ON FUNCTION public.exec_sql IS 'Enables Kinematic AI to perform automated database migrations and system-wide audits.';
