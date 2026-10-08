/**
 * Guards for the location heartbeat (PATCH /users/status).
 *
 * 1. Duplicates. A phone whose tracking service registered several location listeners (a leak in the
 *    Android app: one more per app open / login / check-in) sends the SAME fix 10+ times in the same
 *    second, every cycle. Rajkamal's 4 phones wrote 19k rows in a week instead of ~2.7k. Installed apps keep
 *    doing it until they update, so the server drops a repeat of the exact same fix from the same user
 *    that arrives within DUPLICATE_WINDOW_MS. The check-and-set below is synchronous, so a burst of
 *    concurrent requests sees the first one's entry — a DB read-then-insert could not.
 * 2. Null Island. The app sends 0,0 for events it has no fix for (login). 0,0 is not a position anyone
 *    works at; storing it would park the rep in the Gulf of Guinea on the live map.
 */
export const DUPLICATE_WINDOW_MS = 20_000;
const SWEEP_AFTER_MS = 5 * 60_000;

interface Seen { at: number; lat: number; lng: number }

const lastByUser = new Map<string, Seen>();
let lastSweep = 0;

/** True when (lat,lng) is the "no fix" placeholder. */
export function isNullIsland(lat: number, lng: number): boolean {
  return lat === 0 && lng === 0;
}

/**
 * Records this heartbeat and says whether it repeats the previous one for the same user (same fix,
 * within the window). Moving users and users who reappear later are never treated as duplicates.
 */
export function isDuplicateHeartbeat(userId: string, lat: number, lng: number, now: number = Date.now()): boolean {
  if (now - lastSweep > SWEEP_AFTER_MS) {
    for (const [k, v] of lastByUser) if (now - v.at > SWEEP_AFTER_MS) lastByUser.delete(k);
    lastSweep = now;
  }
  const prev = lastByUser.get(userId);
  const dup = !!prev && now - prev.at < DUPLICATE_WINDOW_MS && prev.lat === lat && prev.lng === lng;
  // A duplicate does not extend the window, so a stuck phone still gets one row every window.
  if (!dup) lastByUser.set(userId, { at: now, lat, lng });
  return dup;
}

/** Test helper. */
export function resetHeartbeatGuard(): void {
  lastByUser.clear();
  lastSweep = 0;
}
