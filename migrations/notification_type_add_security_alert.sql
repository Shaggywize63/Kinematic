-- Add 'security_alert' to the notification_type enum.
--
-- The security-alert notification fan-out in misc.controller.ts (logSecurityAlert)
-- inserts notifications with type = 'security_alert' when a rep trips the
-- MOCK_LOCATION / VPN_DETECTED pre-flight detector. That value was never present
-- in the notification_type enum, so every such insert failed — and because the
-- fan-out is wrapped in a best-effort try/catch, the failure was swallowed:
-- the security_alert row was still recorded (visible in the Security Alerts list),
-- but the supervisor's bell/push notification never fired. So the app's
-- "your supervisor has been notified" message was only half-true.
--
-- Adding the enum value makes the existing backend code work as intended — no
-- code change required. Applied to BOTH Supabase projects (shared backend):
-- Kinematic (clldjlojtmrrpozydqxk) and Tata (lnvxqjqfsxvtjvbzphou).
--
-- Note: ALTER TYPE ... ADD VALUE cannot be used in the same transaction that
-- then inserts a row using the new value; run it on its own.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'security_alert';
