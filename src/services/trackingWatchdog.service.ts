/**
 * Tracking watchdog — keeps live tracking alive without asking anyone to change a phone setting.
 *
 * Phones (Motorola/Xiaomi/Oppo/Android 12+) kill a background location service, and the app can't always
 * restart itself from the background. Android DOES let a high-priority FCM message start it again, so every
 * few minutes this finds reps who are CHECKED IN but whose last fix is stale and sends their phone a silent,
 * data-only `tracking_wakeup`. The app's FCM handler restarts LocationTrackingService (which sends an
 * immediate heartbeat); nothing is shown to the user and no notification row is written.
 *
 * Deliberately conservative:
 *   - only checked-in, not checked-out reps (today, IST), active, with an Android push token;
 *   - skips tenants that opted out of live tracking (Tata hardcoded, `disable_live_tracking` flag);
 *   - "stale" = no fix for max(30 min, 2x the org's ping cadence), so a healthy phone is never woken and a
 *     long configured cadence is respected;
 *   - at most one wake-up per rep per 30 min, and a bounded number per run.
 */
import { supabaseAdmin } from '../lib/supabase';
import { messaging } from '../lib/firebase';
import { logger } from '../lib/logger';
import { isLiveTrackingDisabled } from '../lib/liveTracking';
import { dbToday } from '../utils';

export const WAKEUP_KIND = 'tracking_wakeup';
const DEFAULT_CADENCE_S = 600;
const STALE_FLOOR_MS = 30 * 60_000;
export const REWAKE_MS = 30 * 60_000;
const MAX_PER_RUN = 200;

const lastWoken = new Map<string, number>();

/** Test helper. */
export function resetTrackingWatchdog(): void { lastWoken.clear(); }

/** How long a rep may go without a fix before we nudge the phone. */
export function staleAfterMs(cadenceSeconds: number): number {
  return Math.max(STALE_FLOOR_MS, 2 * cadenceSeconds * 1000);
}

function cadenceFrom(raw: unknown): number {
  if (typeof raw === 'number' && raw > 0) return raw;
  if (raw && typeof raw === 'object' && typeof (raw as any).value === 'number' && (raw as any).value > 0) return (raw as any).value;
  return DEFAULT_CADENCE_S;
}

export interface WatchdogResult { checked: number; stale: number; sent: number; failed: number; credential_error: boolean }

export async function runTrackingWatchdog(opts: { now?: number } = {}): Promise<WatchdogResult> {
  const now = opts.now ?? Date.now();
  const result: WatchdogResult = { checked: 0, stale: 0, sent: 0, failed: 0, credential_error: false };
  if (!messaging) return result; // push is not configured: nothing to wake anyone with

  // Reps checked in today and not checked out.
  const { data: att, error: attErr } = await supabaseAdmin
    .from('attendance')
    .select('user_id')
    .eq('date', dbToday())
    .not('checkin_at', 'is', null)
    .is('checkout_at', null)
    .limit(2000);
  if (attErr) { logger.warn(`[tracking-watchdog] attendance query failed: ${attErr.message}`); return result; }
  const userIds = Array.from(new Set(((att ?? []) as Array<{ user_id: string | null }>).map((a) => a.user_id).filter((x): x is string => !!x)));
  if (userIds.length === 0) return result;

  const { data: users, error: uErr } = await supabaseAdmin
    .from('users')
    .select('id, org_id, client_id, fcm_token, last_location_updated_at')
    .in('id', userIds)
    .eq('is_active', true)
    .is('deleted_at', null)
    .not('fcm_token', 'is', null);
  if (uErr) { logger.warn(`[tracking-watchdog] users query failed: ${uErr.message}`); return result; }
  const reps = (users ?? []) as Array<{ id: string; org_id: string | null; client_id: string | null; fcm_token: string | null; last_location_updated_at: string | null }>;
  result.checked = reps.length;
  if (reps.length === 0) return result;

  // Each org's configured ping cadence.
  const orgIds = Array.from(new Set(reps.map((r) => r.org_id).filter((x): x is string => !!x)));
  const cadenceByOrg = new Map<string, number>();
  if (orgIds.length) {
    const { data: rows } = await supabaseAdmin.from('org_settings').select('org_id, value').eq('key', 'location_ping_interval_seconds').in('org_id', orgIds);
    for (const r of (rows ?? []) as Array<{ org_id: string; value: unknown }>) cadenceByOrg.set(r.org_id, cadenceFrom(r.value));
  }

  const disabledByClient = new Map<string, boolean>();
  for (const rep of reps) {
    if (result.sent >= MAX_PER_RUN) break;
    if (!rep.fcm_token) continue;

    if (rep.client_id) {
      if (!disabledByClient.has(rep.client_id)) disabledByClient.set(rep.client_id, await isLiveTrackingDisabled(rep.client_id));
      if (disabledByClient.get(rep.client_id)) continue;
    }

    const lastFix = rep.last_location_updated_at ? Date.parse(rep.last_location_updated_at) : 0;
    const cadence = (rep.org_id && cadenceByOrg.get(rep.org_id)) || DEFAULT_CADENCE_S;
    if (lastFix && now - lastFix < staleAfterMs(cadence)) continue;
    result.stale++;

    const prev = lastWoken.get(rep.id);
    if (prev && now - prev < REWAKE_MS) continue;
    lastWoken.set(rep.id, now);

    try {
      await messaging.send({
        token: rep.fcm_token,
        // DATA-ONLY + high priority: the only kind of push Android lets (re)start a foreground service from the
        // background. A short TTL: a wake-up that arrives hours later is pointless.
        data: { kind: WAKEUP_KIND },
        android: { priority: 'high', ttl: 10 * 60_000, collapseKey: WAKEUP_KIND },
      });
      result.sent++;
    } catch (err: any) {
      result.failed++;
      const msg = String(err?.errorInfo?.code || err?.message || err);
      if (msg.includes('app/invalid-credential') || msg.includes('authentication-error') || msg.includes('third-party-auth-error')) {
        // Our own credential is rejected: every send will fail. Stop; the push dispatcher already logs this loudly.
        result.credential_error = true;
        break;
      }
      if (msg.includes('registration-token-not-registered')) {
        await supabaseAdmin.from('users').update({ fcm_token: null }).eq('id', rep.id);
      } else {
        logger.warn(`[tracking-watchdog] wake-up to ${rep.id} failed: ${msg}`);
      }
    }
  }

  if (result.sent > 0) logger.info(`[tracking-watchdog] woke ${result.sent} stale phone(s) (checked ${result.checked}, stale ${result.stale})`);
  return result;
}
