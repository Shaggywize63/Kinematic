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
 * GET /api/v1/org-settings/ui-flags
 * Per-org UI toggles for the caller's current org (honours super-admin
 * impersonation via req.user.org_id). Promotable via org_settings.
 */
export const getUiFlags = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data } = await supabaseAdmin
    .from('org_settings').select('key, value').eq('org_id', org_id)
    .in('key', ['ui.hide_client_filter']);
  const map: Record<string, unknown> = {};
  (data || []).forEach((r: any) => { map[r.key] = r.value; });
  const truthy = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
  sendSuccess(res, { hide_client_filter: truthy(map['ui.hide_client_filter']) });
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

// ============================================================
// CRM reminder thresholds
// ============================================================
// Per-org overrides for the 4 cadences driving public.crm_send_reminders.
// JSONB shape (all keys optional; missing ones fall back to defaults):
//   { stagnant_days, escalation_l2_days, deal_closing_days,
//     deal_overdue_escalation_days }

interface CrmReminderThresholds {
  stagnant_days: number;
  escalation_l2_days: number;
  deal_closing_days: number;
  deal_overdue_escalation_days: number;
}

const CRM_THRESHOLD_DEFAULTS: CrmReminderThresholds = {
  stagnant_days: 10,
  escalation_l2_days: 15,
  deal_closing_days: 3,
  deal_overdue_escalation_days: 3,
};

// Clamp bounds: at least 1 day on every threshold, at most 60 days. Anything
// outside this range is almost certainly a typo (zero → spam, 90+ → useless).
const CRM_THRESHOLD_MIN = 1;
const CRM_THRESHOLD_MAX = 60;

function parseCrmThresholds(raw: unknown): CrmReminderThresholds {
  if (!raw || typeof raw !== 'object') return { ...CRM_THRESHOLD_DEFAULTS };
  const r = raw as Record<string, unknown>;
  const pick = (key: keyof CrmReminderThresholds): number => {
    const v = Number(r[key]);
    return Number.isFinite(v) && v >= CRM_THRESHOLD_MIN && v <= CRM_THRESHOLD_MAX
      ? v
      : CRM_THRESHOLD_DEFAULTS[key];
  };
  return {
    stagnant_days: pick('stagnant_days'),
    escalation_l2_days: pick('escalation_l2_days'),
    deal_closing_days: pick('deal_closing_days'),
    deal_overdue_escalation_days: pick('deal_overdue_escalation_days'),
  };
}

/**
 * GET /api/v1/org-settings/crm-reminder-thresholds
 *
 * Returns the caller org's CRM reminder cadences. Missing row → defaults.
 */
export const getCrmReminderThresholds = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('org_settings')
    .select('value, updated_at')
    .eq('org_id', org_id)
    .eq('key', 'crm_reminder_thresholds')
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  sendSuccess(res, {
    thresholds: parseCrmThresholds((data as any)?.value),
    defaults: CRM_THRESHOLD_DEFAULTS,
    bounds: { min: CRM_THRESHOLD_MIN, max: CRM_THRESHOLD_MAX },
    updated_at: (data as any)?.updated_at ?? null,
  });
});

/**
 * PATCH /api/v1/org-settings/crm-reminder-thresholds
 *
 * Body: any subset of the 4 keys above. Missing keys retain the previous
 * value (or the default if no row exists yet). Out-of-range or non-numeric
 * inputs are rejected with a 400.
 */
export const setCrmReminderThresholds = asyncHandler<AuthRequest>(async (req, res) => {
  const { org_id, id: user_id } = req.user!;
  const body = (req.body ?? {}) as Partial<CrmReminderThresholds>;

  // Load current values so the merge preserves any keys the caller omits.
  const { data: existing, error: selErr } = await supabaseAdmin
    .from('org_settings')
    .select('id, value')
    .eq('org_id', org_id)
    .eq('key', 'crm_reminder_thresholds')
    .maybeSingle();
  if (selErr) throw new AppError(500, selErr.message, 'DB_ERROR');

  const current = parseCrmThresholds((existing as any)?.value);
  const proposed: CrmReminderThresholds = { ...current };

  // Validate each key the caller supplied. Reject the whole request on
  // any invalid value rather than silently dropping it (debugging is
  // much easier when partial saves fail loudly).
  for (const key of Object.keys(CRM_THRESHOLD_DEFAULTS) as (keyof CrmReminderThresholds)[]) {
    if (body[key] === undefined) continue;
    const v = Number(body[key]);
    if (!Number.isFinite(v) || v < CRM_THRESHOLD_MIN || v > CRM_THRESHOLD_MAX) {
      throw new AppError(
        400,
        `${key} must be a number between ${CRM_THRESHOLD_MIN} and ${CRM_THRESHOLD_MAX}`,
        'INVALID_VALUE',
      );
    }
    proposed[key] = v;
  }

  const now = new Date().toISOString();
  if (existing?.id) {
    const { error: updErr } = await supabaseAdmin
      .from('org_settings')
      .update({ value: proposed, updated_by: user_id, updated_at: now })
      .eq('id', existing.id);
    if (updErr) throw new AppError(500, updErr.message, 'DB_ERROR');
  } else {
    const { error: insErr } = await supabaseAdmin
      .from('org_settings')
      .insert({
        org_id,
        key: 'crm_reminder_thresholds',
        value: proposed,
        updated_by: user_id,
      });
    if (insErr) throw new AppError(500, insErr.message, 'DB_ERROR');
  }

  sendSuccess(res, {
    thresholds: proposed,
    updated_at: now,
    note: 'New thresholds take effect on the next crm-send-reminders run (daily 09:30 IST).',
  });
});
