/**
 * Public app-version endpoint. The iOS + Android apps hit this on launch to
 * learn the latest published build and the minimum supported build, so an
 * install that is behind what's live on the store can nudge the user to
 * update (soft prompt) or, if it's below the minimum, force an update
 * (hard gate).
 *
 * NO auth — mounted before the global requireAuth gate in app.ts (same
 * pattern as the other public routes: integrations webhook, kini/public…).
 *
 * Values are env-driven so a new release can bump them WITHOUT a code
 * deploy — set APP_IOS_LATEST_VERSION / APP_ANDROID_LATEST_VERSION the
 * moment a new build goes live on the store. The defaults equal the
 * versions shipping today, so with no env vars set the endpoint is inert
 * (latest == installed → no prompt) and can never advertise a version that
 * isn't on the store yet (which would lock every user behind an
 * un-satisfiable update).
 *
 *   Env (all optional):
 *     APP_IOS_LATEST_VERSION      e.g. "1.1.0"  (default "1.0.0")
 *     APP_IOS_MIN_VERSION         e.g. "1.0.0"  (default "0.0.0" → never forces)
 *     APP_IOS_STORE_URL           App Store link
 *     APP_ANDROID_LATEST_VERSION  e.g. "1.1.0"  (default "1.0.0")
 *     APP_ANDROID_MIN_VERSION     e.g. "1.0.0"  (default "0.0.0" → never forces)
 *     APP_ANDROID_STORE_URL       Play Store link
 *     APP_UPDATE_MESSAGE          optional custom copy shown in the dialog
 */
import { Router, Request, Response } from 'express';

const router: Router = Router();

const DEFAULT_IOS_STORE_URL =
  'https://apps.apple.com/app/kinematic/id0000000000';
const DEFAULT_ANDROID_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.kinematic.app';

interface PlatformVersion {
  latest_version: string;
  minimum_version: string;
  store_url: string;
  message: string | null;
}

function platformConfig(
  prefix: 'APP_IOS' | 'APP_ANDROID',
  defaultStoreUrl: string,
): PlatformVersion {
  return {
    latest_version: process.env[`${prefix}_LATEST_VERSION`] || '1.0.0',
    // Permissive default — never forces an update unless an admin sets it.
    minimum_version: process.env[`${prefix}_MIN_VERSION`] || '0.0.0',
    store_url: process.env[`${prefix}_STORE_URL`] || defaultStoreUrl,
    message: process.env.APP_UPDATE_MESSAGE || null,
  };
}

router.get('/version', (_req: Request, res: Response) => {
  // Short cache — a version bump propagates within a few minutes without
  // hammering the endpoint on every cold start.
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    ios: platformConfig('APP_IOS', DEFAULT_IOS_STORE_URL),
    android: platformConfig('APP_ANDROID', DEFAULT_ANDROID_STORE_URL),
  });
});

export default router;
