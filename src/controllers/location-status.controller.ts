/**
 * PATCH /api/v1/users/location-status
 *
 * The "I have no fix — here's my permission state" report. When a rep turns
 * location off (or never grants it), the app can't send coordinates, so the
 * normal PATCH /users/status heartbeat (which requires lat/lng) goes silent.
 * Without this the dashboard can't tell "off" from "app closed / dead battery".
 *
 * The device reports its permission + services state here (NO coordinates).
 * We map it to a coarse `location_status` on the users row and bump
 * `location_status_updated_at` only when the value actually CHANGES, so the
 * dashboard can render "Location off since 09:42". The last real GPS fix stays
 * untouched in last_latitude / last_longitude / last_location_updated_at and is
 * shown as a clearly-labelled STALE point.
 *
 * This is deliberately honest: there is no way to read a device's location when
 * the user has turned it off, and this endpoint does not try to. It records the
 * fact that it is off.
 */
import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { clientHasFlag } from '../lib/clientFlags';
import { AuthRequest } from '../types';
import { asyncHandler, AppError, sendSuccess } from '../utils';
import { notifyUsers, resolveManagers } from '../services/notify';
import { logger } from '../lib/logger';

// The coarse statuses that mean "this rep can't be tracked right now" — a real
// field-force problem a supervisor should hear about. 'on' and 'unknown' (not
// yet asked) are NOT alerted.
const PROBLEM_STATUSES = new Set(['denied', 'services_off', 'restricted']);

const STATUS_LABEL: Record<string, string> = {
  denied: 'turned location permission OFF',
  services_off: 'turned Location Services OFF',
  restricted: 'has location restricted on their device',
};

/**
 * When a rep's location goes dark, tell their supervisor (and org managers as a
 * fallback) — a live notification so a manager can follow up, instead of only a
 * silent badge on the dashboard. Best-effort and fire-and-forget: it must never
 * fail the status write. Deduped by the caller only firing on a real transition
 * INTO a problem state (`changed === true`), so a rep who stays off doesn't
 * re-alert on every heartbeat.
 */
async function notifyLocationOff(
  orgId: string | null | undefined,
  rep: { id: string; name?: string | null; supervisor_id?: string | null; client_id?: string | null },
  status: string,
): Promise<void> {
  if (!orgId) return;
  try {
    const recipients = await resolveManagers(orgId, {
      supervisorId: rep.supervisor_id ?? null,
      clientId: rep.client_id ?? null,
    });
    const repName = rep.name || 'A field rep';
    await notifyUsers(recipients, {
      orgId,
      kind: 'location_off',
      title: 'Location tracking off',
      body: `${repName} ${STATUS_LABEL[status] || 'is not sharing location'}.`,
      data: { rep_id: rep.id, location_status: status },
    }, { exclude: rep.id });
  } catch (e: any) {
    logger.warn(`[location-status] supervisor notify failed: ${e?.message || e}`);
  }
}

// Client-reported permission, normalised across iOS + Android vocabularies.
const bodySchema = z.object({
  // iOS: authorizedAlways/authorizedWhenInUse → granted; denied; restricted;
  //      notDetermined → not_determined.
  // Android: fine/coarse granted → granted; permanently denied → denied;
  //          not asked → not_determined.
  permission: z.enum(['granted', 'denied', 'restricted', 'not_determined']),
  // Device-level Location Services master switch (Settings → Location).
  services_enabled: z.boolean().optional().default(true),
  // Full/precise vs reduced (iOS)/approximate (Android). Optional.
  precise: z.boolean().optional(),
});

// Same live-tracking kill switch used by updateUserStatus: tenants that opted
// out of continuous tracking don't get their status rows written either.
const LIVE_TRACKING_DISABLED_CLIENT_IDS = new Set<string>([]);

// permission + services → the coarse status the dashboard reasons about.
function deriveStatus(permission: string, servicesEnabled: boolean): string {
  if (permission === 'denied') return 'denied';
  if (permission === 'restricted') return 'restricted';
  if (permission === 'not_determined') return 'unknown';
  // granted:
  return servicesEnabled ? 'on' : 'services_off';
}

export const updateLocationStatus = asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  if (user.client_id && (LIVE_TRACKING_DISABLED_CLIENT_IDS.has(user.client_id) || await clientHasFlag(user.client_id, 'disable_live_tracking'))) {
    res.status(204).end();
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.errors[0]?.message || 'Invalid location status', 'VALIDATION_ERROR');
  }
  const { permission, services_enabled, precise } = parsed.data;
  const status = deriveStatus(permission, services_enabled);
  const now = new Date().toISOString();

  // Read the current status so we only move location_status_updated_at on a
  // real transition — that timestamp is the "off since" the dashboard shows.
  // Pull the rep's name/supervisor/org so we can alert managers on a transition
  // without a second round-trip.
  const { data: current, error: readErr } = await supabaseAdmin
    .from('users')
    .select('location_status, name, supervisor_id, org_id, client_id')
    .eq('id', user.id)
    .maybeSingle();
  if (readErr) throw new AppError(500, readErr.message, 'DB_ERROR');

  const changed = (current?.location_status ?? null) !== status;

  const update: Record<string, unknown> = { location_status: status };
  if (precise !== undefined) update.location_precise = precise;
  if (changed) update.location_status_updated_at = now;

  const { error } = await supabaseAdmin.from('users').update(update).eq('id', user.id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // On a real transition INTO a problem state, alert the rep's supervisor.
  // Fire-and-forget so it never delays or fails the status write.
  if (changed && PROBLEM_STATUSES.has(status)) {
    notifyLocationOff(current?.org_id ?? user.org_id, {
      id: user.id,
      name: current?.name,
      supervisor_id: current?.supervisor_id,
      client_id: current?.client_id ?? user.client_id,
    }, status).catch(() => {});
  }

  sendSuccess(res, { location_status: status, changed }, 'Location status updated');
});
