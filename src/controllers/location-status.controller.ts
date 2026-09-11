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
  const { data: current, error: readErr } = await supabaseAdmin
    .from('users')
    .select('location_status')
    .eq('id', user.id)
    .maybeSingle();
  if (readErr) throw new AppError(500, readErr.message, 'DB_ERROR');

  const changed = (current?.location_status ?? null) !== status;

  const update: Record<string, unknown> = { location_status: status };
  if (precise !== undefined) update.location_precise = precise;
  if (changed) update.location_status_updated_at = now;

  const { error } = await supabaseAdmin.from('users').update(update).eq('id', user.id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  sendSuccess(res, { location_status: status, changed }, 'Location status updated');
});
