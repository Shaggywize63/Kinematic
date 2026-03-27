-- Migration to update visit_logs with outlet_id
ALTER TABLE IF EXISTS visit_logs ADD COLUMN IF NOT EXISTS outlet_id UUID REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE IF EXISTS visit_logs ADD COLUMN IF NOT EXISTS visit_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE IF EXISTS visit_logs ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_visit_logs_org ON visit_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_visitor ON visit_logs(visitor_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_outlet ON visit_logs(outlet_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_date ON visit_logs(visit_at);
