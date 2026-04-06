-- DEVICE INFORMATION MIGRATION
-- Add columns to users and work_activity to track device metadata

-- 1. Update users table for the latest device status
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS device_model VARCHAR(100);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS device_brand VARCHAR(100);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS os_version VARCHAR(50);

-- 2. Update work_activity table for historical tracking
ALTER TABLE public.work_activity ADD COLUMN IF NOT EXISTS device_model VARCHAR(100);
ALTER TABLE public.work_activity ADD COLUMN IF NOT EXISTS device_brand VARCHAR(100);
ALTER TABLE public.work_activity ADD COLUMN IF NOT EXISTS os_version VARCHAR(50);

-- Add comments for documentation
COMMENT ON COLUMN public.users.device_model IS 'The hardware model of the device (e.g., Pixel 6 Pro)';
COMMENT ON COLUMN public.users.device_brand IS 'The manufacturer of the device (e.g., Google)';
COMMENT ON COLUMN public.users.os_version IS 'The Android OS version (e.g., 14)';
