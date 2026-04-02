-- Add columns to users table for live tracking and battery monitoring
ALTER TABLE users ADD COLUMN IF NOT EXISTS battery_percentage INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_latitude DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_longitude DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_location_updated_at TIMESTAMPTZ;

-- Add battery_percentage to work_activity table
ALTER TABLE work_activity ADD COLUMN IF NOT EXISTS battery_percentage INTEGER;
