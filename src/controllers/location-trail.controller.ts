/**
 * GET /api/v1/users/:id/location-trail?date=YYYY-MM-DD&types=HEARTBEAT,CHECK_IN
 *
 * Returns the day's GPS pings for a single FE so the dashboard's live-
 * tracking page can draw a breadcrumb polyline. Reads from the existing
 * `work_activity` table (populated by PATCH /users/status on every
 * 10-min HEARTBEAT and on every CHECK_IN / CHECK_OUT / FORM_SUBMIT).
 *
 * Org-scoped — supervisors / managers / admins can only see FEs within
 * their org. The :id in the URL must belong to req.user.org_id; the
 * query filter enforces that.
 *
 * `types` is comma-separated; defaults to HEARTBEAT,CHECK_IN,CHECK_OUT
 * so the trail starts and ends at the day's attendance points. Caller
 * can narrow to HEARTBEAT to skip the bookends.
 */
import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, AppError, sendSuccess } from '../utils';

const DEFAULT_TYPES = ['HEARTBEAT', 'CHECK_IN', 'CHECK_OUT', 'FORM_SUBMIT'];

export const getUserLocationTrail = asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
  const targetUserId = req.params.id;
  const date = (req.query.date as string | undefined) || new Date().toISOString().slice(0, 10);
  const typesParam = (req.query.types as string | undefined) ?? '';
  const types = typesParam.trim()
    ? typesParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_TYPES;

  // Validate the date param to keep the query predicate sane.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError(400, 'date must be YYYY-MM-DD', 'VALIDATION_ERROR');
  }

  const start = `${date}T00:00:00.000Z`;
  const end   = `${date}T23:59:59.999Z`;

  const { data, error } = await supabaseAdmin
    .from('work_activity')
    .select('lat, lng, battery_percentage, captured_at, activity_type')
    .eq('org_id', req.user!.org_id)
    .eq('user_id', targetUserId)
    .in('activity_type', types)
    .gte('captured_at', start)
    .lte('captured_at', end)
    .order('captured_at', { ascending: true })
    // Cap at 5000 pings per day per user — at 10-min cadence a full 24h shift
    // produces ~144 pings, so 5000 is a comfortable ceiling that also defends
    // against runaway clients pinging at 1Hz.
    .limit(5000);

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data ?? [], 'Location trail fetched');
});
