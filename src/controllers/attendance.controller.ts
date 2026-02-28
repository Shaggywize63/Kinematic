import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin, getUserClient } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, conflict, notFound, forbidden } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { isWithinGeofence } from '../lib/haversine';
import { getPagination, buildPaginatedResult } from '../utils/pagination';

const checkinSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  selfie_url: z.string().url().optional(),
  activity_id: z.string().uuid().optional(),
  zone_id: z.string().uuid().optional(),
});

const checkoutSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  selfie_url: z.string().url().optional(),
});

// POST /api/v1/attendance/checkin
export const checkin = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = checkinSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { latitude, longitude, selfie_url, activity_id, zone_id } = body.data;
  const today = new Date().toISOString().split('T')[0];

  // Check already checked in today
  const { data: existing } = await supabaseAdmin
    .from('attendance')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  if (existing) return conflict(res, 'Already checked in today');

  // Resolve zone — from body or user profile
  const resolvedZoneId = zone_id || user.zone_id;

  // Validate geo-fence if zone found
  let distanceMetres = 0;
  if (resolvedZoneId) {
    const { data: zone } = await supabaseAdmin
      .from('zones')
      .select('meeting_lat, meeting_lng, geofence_radius, name')
      .eq('id', resolvedZoneId)
      .single();

    if (zone) {
      const { withinFence, distanceMetres: dist } = isWithinGeofence(
        latitude, longitude,
        zone.meeting_lat, zone.meeting_lng,
        zone.geofence_radius
      );
      distanceMetres = dist;

      if (!withinFence) {
        return badRequest(res,
          `You are ${dist}m away from ${zone.name}. Must be within ${zone.geofence_radius}m to check in.`,
          { distance: dist, required: zone.geofence_radius }
        );
      }
    }
  }

  const { data, error } = await supabaseAdmin
    .from('attendance')
    .insert({
      user_id: user.id,
      org_id: user.org_id,
      zone_id: resolvedZoneId,
      activity_id,
      date: today,
      status: 'checked_in',
      checkin_at: new Date().toISOString(),
      checkin_lat: latitude,
      checkin_lng: longitude,
      checkin_selfie_url: selfie_url,
      checkin_distance_m: distanceMetres,
    })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Checked in successfully');
});

// POST /api/v1/attendance/checkout
export const checkout = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = checkoutSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { latitude, longitude, selfie_url } = body.data;
  const today = new Date().toISOString().split('T')[0];

  const { data: record } = await supabaseAdmin
    .from('attendance')
    .select('id, status, checkin_at, break_minutes')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  if (!record) return badRequest(res, 'No check-in found for today');
  if (record.status === 'checked_out') return conflict(res, 'Already checked out today');

  const checkoutTime = new Date();
  const checkinTime = new Date(record.checkin_at!);
  const totalMinutes = Math.round((checkoutTime.getTime() - checkinTime.getTime()) / 60000);
  const workingMinutes = totalMinutes - (record.break_minutes || 0);

  const { data, error } = await supabaseAdmin
    .from('attendance')
    .update({
      status: 'checked_out',
      checkout_at: checkoutTime.toISOString(),
      checkout_lat: latitude,
      checkout_lng: longitude,
      checkout_selfie_url: selfie_url,
      working_minutes: Math.max(0, workingMinutes),
    })
    .eq('id', record.id)
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return ok(res, data, 'Checked out successfully');
});

// POST /api/v1/attendance/break/start
export const startBreak = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = new Date().toISOString().split('T')[0];

  const { data: record } = await supabaseAdmin
    .from('attendance')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  if (!record) return badRequest(res, 'Not checked in today');
  if (record.status !== 'checked_in') return conflict(res, 'Cannot start break in current status');

  await supabaseAdmin.from('attendance').update({ status: 'on_break' }).eq('id', record.id);

  const { data: breakRecord, error } = await supabaseAdmin
    .from('breaks')
    .insert({ attendance_id: record.id, user_id: user.id, started_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, breakRecord, 'Break started');
});

// POST /api/v1/attendance/break/end
export const endBreak = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = new Date().toISOString().split('T')[0];

  const { data: record } = await supabaseAdmin
    .from('attendance')
    .select('id, status, break_minutes')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  if (!record) return badRequest(res, 'Not checked in today');
  if (record.status !== 'on_break') return conflict(res, 'Not currently on break');

  // Find the open break
  const { data: openBreak } = await supabaseAdmin
    .from('breaks')
    .select('id, started_at')
    .eq('attendance_id', record.id)
    .is('ended_at', null)
    .single();

  if (!openBreak) return badRequest(res, 'No open break found');

  const endTime = new Date();
  const breakMins = Math.round((endTime.getTime() - new Date(openBreak.started_at).getTime()) / 60000);

  await supabaseAdmin.from('breaks').update({ ended_at: endTime.toISOString() }).eq('id', openBreak.id);
  await supabaseAdmin.from('attendance').update({
    status: 'checked_in',
    break_minutes: (record.break_minutes || 0) + breakMins,
  }).eq('id', record.id);

  return ok(res, { break_duration_minutes: breakMins }, 'Break ended');
});

// GET /api/v1/attendance/today
export const getToday = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  if (error && error.code !== 'PGRST116') return badRequest(res, error.message);
  return ok(res, data || null);
});

// GET /api/v1/attendance/history
export const getHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(
    req.query.page as string,
    req.query.limit as string
  );

  const { data, error, count } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)', { count: 'exact' })
    .eq('user_id', user.id)
    .order('date', { ascending: false })
    .range(from, to);

  if (error) return badRequest(res, error.message);
  return ok(res, buildPaginatedResult(data || [], count || 0, page, limit));
});

// GET /api/v1/attendance/team  (supervisor+)
export const getTeamToday = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = new Date().toISOString().split('T')[0];
  const zoneId = req.query.zone_id as string | undefined;

  let query = supabaseAdmin
    .from('v_today_attendance')
    .select('*')
    .eq('org_id', user.org_id);

  if (zoneId) query = query.eq('zone_id', zoneId);
  if (user.role === 'supervisor') {
    // Supervisors only see their direct team
    const { data: teamIds } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('supervisor_id', user.id);
    const ids = (teamIds || []).map((u: { id: string }) => u.id);
    if (ids.length) query = query.in('user_id', ids);
  }

  const { data, error } = await query.order('conversions', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});
