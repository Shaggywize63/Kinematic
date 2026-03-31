-- Updating the exec_sql helper to return query results
CREATE OR REPLACE FUNCTION public.exec_sql(sql_query TEXT)
RETURNS SETOF json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY EXECUTE 'SELECT row_to_json(t) FROM (' || sql_query || ') t';
END;
$$;
