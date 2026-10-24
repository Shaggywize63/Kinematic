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

/**
 * Location is tracked ONLY between check-in and check-out. A heartbeat from someone with no open shift (a phone whose
 * tracking service outlived a check-out, one started at login, a stale app build) keeps its battery / device sync but
 * is never stored as a position, so it can't appear on the live map or in the trail.
 *
 * Applies to anyone whose client uses attendance; a client without the `attendance` module (complete entitlement list)
 * has no check-in to key on and keeps today's behaviour. TRACK_ONLY_ON_SHIFT=off restores the old "any ping" rule.
 */
export function requiresOpenShift(user: { enabled_modules?: string[] | null; entitlements_strict?: boolean | null } | undefined): boolean {
  if ((process.env.TRACK_ONLY_ON_SHIFT || '').trim().toLowerCase() === 'off') return false;
  if (!user) return false;
  return user.entitlements_strict !== true || (user.enabled_modules ?? []).includes('attendance');
}

const offShiftLogged = new Map<string, number>();
const OFF_SHIFT_LOG_EVERY_MS = 60 * 60_000;

/** True at most once an hour per user — keeps the "ignored an off-shift ping" log line readable. */
export function shouldLogOffShift(userId: string, now = Date.now()): boolean {
  const prev = offShiftLogged.get(userId);
  if (prev !== undefined && now - prev < OFF_SHIFT_LOG_EVERY_MS) return false;
  offShiftLogged.set(userId, now);
  return true;
}

/** Test helper. */
export function resetOffShiftLog(): void { offShiftLogged.clear(); }
