-- Migration to add missing geofencing and duration columns to route_plan_outlets
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard/project/_/editor)

-- 1. Add missing columns to route_plan_outlets table
ALTER TABLE public.route_plan_outlets 
ADD COLUMN IF NOT EXISTS is_geofenced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS geofence_radius_m INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS planned_duration_min INTEGER;

-- 2. Update the v_route_outlet_detail view (in case it is broken)
DROP VIEW IF EXISTS v_route_outlet_detail;
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
    s.lat as store_lat,
    s.lng as store_lng,
    s.store_code,
    rp.user_id,
    rp.plan_date,
    rp.activity_id,
    a.name as activity_name
FROM route_plan_outlets rpo
JOIN stores s ON rpo.store_id = s.id
JOIN route_plans rp ON rpo.route_plan_id = rp.id
LEFT JOIN activities a ON rp.activity_id = a.id;

-- 3. IMPORTANT: Reload Schema Cache
-- Go to: Supabase Dashboard -> Settings -> API -> PostgREST -> Reload Schema Cache
