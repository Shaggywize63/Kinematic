-- Global Performance Optimization Indexes
-- These indexes resolve the full table scan bottleneck affecting Analytics, Attendance, Live Tracking, and Route Plans pages.

-- Users Table
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_city ON users(city);
CREATE INDEX IF NOT EXISTS idx_users_zone_id ON users(zone_id);

-- Attendance Table
CREATE INDEX IF NOT EXISTS idx_attendance_user_id ON attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_org_id ON attendance(org_id);
CREATE INDEX IF NOT EXISTS idx_attendance_status ON attendance(status);

-- Work Activity (Live Tracking History)
CREATE INDEX IF NOT EXISTS idx_work_activity_user_id ON work_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_work_activity_org_id ON work_activity(org_id);
CREATE INDEX IF NOT EXISTS idx_work_activity_captured_at ON work_activity(captured_at);

-- Route Plans
CREATE INDEX IF NOT EXISTS idx_route_plans_user_id ON route_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_route_plans_date ON route_plans(date);
CREATE INDEX IF NOT EXISTS idx_route_plans_org_id ON route_plans(org_id);
CREATE INDEX IF NOT EXISTS idx_route_plans_status ON route_plans(status);

-- Visit Logs
CREATE INDEX IF NOT EXISTS idx_visit_logs_user_id ON visit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_client_id ON visit_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_created_at ON visit_logs(created_at);

-- Notifications & Broadcasts
CREATE INDEX IF NOT EXISTS idx_notifications_target_user_id ON notifications(target_user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);

-- Organizations & Clients
CREATE INDEX IF NOT EXISTS idx_clients_org_id ON clients(org_id);
