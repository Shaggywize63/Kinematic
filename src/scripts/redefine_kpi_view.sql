-- Redefine v_daily_kpis to include client_id for strict multi-tenant isolation
DROP VIEW IF EXISTS public.v_daily_kpis;

CREATE VIEW public.v_daily_kpis AS
SELECT 
    att.org_id,
    att.client_id,
    att.date,
    COUNT(DISTINCT att.user_id) AS executives_active,
    COUNT(DISTINCT CASE WHEN fs.id IS NOT NULL THEN att.user_id END) AS executives_submitted,
    COUNT(fs.id) AS total_engagements,
    SUM(CASE WHEN fs.is_converted THEN 1 ELSE 0 END) AS total_conversions,
    ROUND(AVG(att.total_hours)::numeric, 1) AS avg_hours_worked
FROM 
    public.attendance att
LEFT JOIN 
    public.form_submissions fs ON att.user_id = fs.user_id AND att.date = fs.date
GROUP BY 
    att.org_id, att.client_id, att.date;

-- Grant access
GRANT SELECT ON public.v_daily_kpis TO authenticated;
GRANT SELECT ON public.v_daily_kpis TO service_role;
