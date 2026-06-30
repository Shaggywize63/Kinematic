-- iOS push support — store the device's native APNs token separately from the
-- Android FCM token so the dispatcher can route each platform to the right
-- transport (FCM for Android, direct APNs/HTTP-2 for iOS).
--
-- Why a separate column: the existing fcm_token column holds an FCM
-- registration token and is sent through firebase-admin. An iOS APNs device
-- token is NOT an FCM token; pushing it through FCM would fail and the
-- dispatcher would (correctly) null it as "unregistered". Keeping apns_token
-- distinct lets a user have whichever transport their device registered.
--
-- fcm_platform records which transport the user last registered with
-- ('ios' | 'android'); the notifications controller already writes it with a
-- graceful fallback when the column is missing.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS apns_token   text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS fcm_platform text;
