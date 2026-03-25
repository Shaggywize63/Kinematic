-- Migration to include activity_id in route plan views
-- Run this in the Supabase SQL Editor

-- Update v_route_plan_daily to include activity_id and activity_name
-- This ensures the dashboard and mobile app can see which activity is linked to a plan.
CREATE OR REPLACE VIEW v_route_plan_daily AS
SELECT 
    rp.*,
    u.name as fe_name,
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

-- Reload schema cache after running this:
-- Settings -> API -> PostgREST -> Reload Schema Cache
