-- Migration to fix v_route_outlet_detail view for multiple plans
-- Run this in the Supabase SQL Editor

-- 1. Drop existing view
DROP VIEW IF EXISTS v_route_outlet_detail;

-- 2. Create the view again with strict plan-id joining
-- This ensures outlets are correctly linked to their parent plans regardless of how many plans an FE has per day.
CREATE VIEW v_route_outlet_detail AS
SELECT 
    rpo.id,
    rpo.route_plan_id,
    rpo.store_id,
    rpo.org_id,
    rpo.visit_order,
    rpo.status,
    rpo.target_type,
    rpo.target_notes,
    rpo.target_value,
    rpo.geofence_radius_m,
    rpo.planned_duration_min,
    rpo.checkin_at,
    rpo.checkout_at,
    rpo.checkin_lat,
    rpo.checkin_lng,
    rpo.checkin_distance_m,
    rpo.photo_url,
    rpo.is_geofenced,
    s.name as store_name,
    s.address as store_address,
    s.latitude as store_lat,
    s.longitude as store_lng,
    s.store_code,
    rp.user_id,
    rp.plan_date,
    rp.activity_id,
    a.name as activity_name
FROM route_plan_outlets rpo
JOIN stores s ON rpo.store_id = s.id
JOIN route_plans rp ON rpo.route_plan_id = rp.id
LEFT JOIN activities a ON rp.activity_id = a.id;

-- 3. Reload schema cache after running this:
-- Supabase Dashboard -> Settings -> API -> PostgREST -> Reload Schema Cache
