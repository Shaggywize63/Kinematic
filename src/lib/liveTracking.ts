import { clientHasFlag } from './clientFlags';

/**
 * Tenants opted out of continuous live-location tracking — pings from these clients are silently no-op'd so
 * reps don't see errors and the device's battery isn't hit by background GPS. Tata Tiscon flagged
 * battery-drain complaints; their reps use one-shot lead-create geo capture instead. New tenants opt out with
 * the data-driven `clients.settings.disable_live_tracking` flag (e.g. PASA), no code change.
 */
export const LIVE_TRACKING_DISABLED_CLIENT_IDS = new Set<string>([
  'a1f67468-526e-4734-be3a-2cb132cc2804', // Tata Tiscon
]);

/** True when this client does not use continuous live tracking (hardcoded fallback OR the data-driven flag). */
export async function isLiveTrackingDisabled(clientId: string | null | undefined): Promise<boolean> {
  if (!clientId) return false;
  return LIVE_TRACKING_DISABLED_CLIENT_IDS.has(clientId) || (await clientHasFlag(clientId, 'disable_live_tracking'));
}
