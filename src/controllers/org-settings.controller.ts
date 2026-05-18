import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, AppError, sendSuccess } from '../utils';

/**
 * Admin-facing org settings controller.
 *
 * Today only the FE location-ping cadence is exposed; future per-org
 * toggles can land here without touching the giant misc.controller.
 */

// Whitelisted cadence values — mirrors the picker on the dashboard
// and the clamp range on the Android client. A bare SQL edit can land
// any int here, but the API layer rejects anything outside this set.
const ALLOWED_CADENCE_SECONDS = [300, 600, 900]; // 5 / 10 / 15 min
const DEFAULT_CADENCE_SECONDS = 600;

function parseCadenceFromJsonbValue(raw: unknown): number {
  if (typeof raw === 'number' && raw > 0) return raw;
  if (raw && typeof raw === 'object' && typeof (raw as { value?: number }).value === 'number' && (raw as { value: number }).value > 0) {
    return (raw as { value: number }).value;
  }
  return DEFAULT_CADENCE_SECONDS;
}

/**
 * GET /api/v1/org-settings/location-ping-interval
 *
 * Returns the caller org's current cadence. Defaults to 600 (10 min)
 * when no row exists — keeps the picker functional even on orgs that
 * pre-date the seed migration.
 */
export const getLocationPingInterval = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('org_settings')
    .select('value, updated_at')
    .eq('org_id', org_id)
    .eq('key', 'location_ping_interval_seconds')
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  sendSuccess(res, {
    location_ping_interval_seconds: parseCadenceFromJsonbValue((data as any)?.value),
    updated_at: (data as any)?.updated_at ?? null,
    allowed_values: ALLOWED_CADENCE_SECONDS,
  });
});

/**
 * PATCH /api/v1/org-settings/location-ping-interval
 *
 * Body: { value: 300 | 600 | 900 }
 *
 * Upserts the row. The Supabase JS upsert helper can't target our
 * partial unique index by name, so we use a SELECT-then-UPDATE-or-INSERT
 * pattern — single row contention is negligible here.
 */
export const setLocationPingInterval = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id, id: user_id } = req.user!;
  const requested = Number(req.body?.value);

  if (!ALLOWED_CADENCE_SECONDS.includes(requested)) {
    throw new AppError(
      400,
      `Cadence must be one of: ${ALLOWED_CADENCE_SECONDS.join(', ')} (seconds)`,
      'INVALID_VALUE',
    );
  }

  const { data: existing, error: selErr } = await supabaseAdmin
    .from('org_settings')
    .select('id')
    .eq('org_id', org_id)
    .eq('key', 'location_ping_interval_seconds')
    .maybeSingle();
  if (selErr) throw new AppError(500, selErr.message, 'DB_ERROR');

  const now = new Date().toISOString();
  if (existing?.id) {
    const { error: updErr } = await supabaseAdmin
      .from('org_settings')
      .update({ value: requested, updated_by: user_id, updated_at: now })
      .eq('id', existing.id);
    if (updErr) throw new AppError(500, updErr.message, 'DB_ERROR');
  } else {
    const { error: insErr } = await supabaseAdmin
      .from('org_settings')
      .insert({
        org_id,
        key: 'location_ping_interval_seconds',
        value: requested,
        updated_by: user_id,
      });
    if (insErr) throw new AppError(500, insErr.message, 'DB_ERROR');
  }

  sendSuccess(res, {
    location_ping_interval_seconds: requested,
    updated_at: now,
    note: 'FEs pick up the new cadence on their next login or /auth/me refresh.',
  });
});
