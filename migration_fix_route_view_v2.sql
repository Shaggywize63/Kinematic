-- Migration to include activity_id and fe_email in route plan views
-- Run this in the Supabase SQL Editor

-- 1. Drop the existing view first
DROP VIEW IF EXISTS v_route_plan_daily;

-- 2. Create the view again with the new columns
CREATE VIEW v_route_plan_daily AS
SELECT 
    rp.*,
    u.name as fe_name,
    u.email as fe_email, -- ADDED THIS
    u.employee_id as fe_employee_id,
    u.mobile as fe_mobile,
    z.name as zone_name,
    c.name as city_name,
    a.name as activity_name
FROM route_plans rp
LEFT JOIN users u ON rp.user_id = u.id
LEFT JOIN zones z ON u.zone_id = z.id
LEFT JOIN cities c ON z.city_id = c.id
LEFT JOIN activities a ON rp.activity_id = a.id;

-- 3. Reload schema cache after running this:
-- Settings -> API -> PostgREST -> Reload Schema Cache
