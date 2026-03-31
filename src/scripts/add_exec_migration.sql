-- Adding a second helper for general migrations (INSERT, UPDATE, CREATE)
CREATE OR REPLACE FUNCTION public.exec_migration(sql_query TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql_query;
END;
$$;
