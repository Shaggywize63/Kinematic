import { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin, getUserClient } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, AppError, ok, created, badRequest, conflict, notFound, forbidden, sendSuccess, todayDate, dbToday, isoDate, isUUID, parseAppDate, formatAppDate } from '../utils';
import { isWithinGeofence } from '../lib/haversine';
import { DEMO_ORG_ID, getMockAttendanceToday } from '../utils/demoData';
import { getPagination, buildPaginatedResult } from '../utils/pagination';
import { logger } from '../lib/logger';

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
export const checkin = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = todayDate();
  const { latitude, longitude, selfie_url, activity_id, zone_id, date: passedDate } = req.body;
  
  logger.info(`[Attendance] Check-in: user=${user.id}, selfie=${selfie_url ? 'PRESENT' : 'MISSING'}`);
  
  // Enforce DD--MM--YYYY parsing
  const attendanceDate = parseAppDate(passedDate || today);

  if (latitude == null || longitude == null) return badRequest(res, 'Latitude and longitude are required');

  // Phase 1: Check existing record for the day to avoid duplicates
  const { data: existing } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)')
    .eq('user_id', user.id)
    .eq('date', attendanceDate)
    .maybeSingle();

  if (existing) {
    logger.info(`[Attendance] user=${user.id} already checked in. Returning existing record.`);
    ok(res, enrichWithHours(existing));
    return;
  }

  // Enforce selfie for field executives
  if (user.role === 'executive' && !selfie_url) {
    badRequest(res, 'Selfie is mandatory for check-in');
    return;
  }

  const resolvedZoneId = zone_id || user.zone_id;

  let distanceMetres = 0;
  if (resolvedZoneId) {
    const { data: zone } = await supabaseAdmin
      .from('zones')
      .select('meeting_lat, meeting_lng, geofence_radius, name')
      .eq('id', resolvedZoneId)
      .single();

    if (zone) {
      const { distanceMetres: dist } = isWithinGeofence(
        latitude, longitude,
        zone.meeting_lat, zone.meeting_lng,
        zone.geofence_radius
      );
      distanceMetres = dist;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('attendance')
    .insert({
      user_id: user.id,
      org_id: user.org_id,
      client_id: user.client_id,
      zone_id: resolvedZoneId,
      activity_id,
      date: attendanceDate,
      status: 'checked_in',
      checkin_at: new Date().toISOString(),
      checkin_lat: latitude,
      checkin_lng: longitude,
      checkin_selfie_url: selfie_url,
      checkin_distance_m: distanceMetres,
    })
    .select()
    .single();

  if (error) { badRequest(res, error.message); return; }

  // Phase 2: Create a work_activity record
  await supabaseAdmin.from('work_activity').insert({
    org_id: user.org_id,
    client_id: user.client_id,
    user_id: user.id,
    attendance_id: data.id,
    activity_type: 'CHECK_IN',
    lat: latitude,
    lng: longitude,
    captured_at: data.checkin_at
  });

  // Update user's last known location
  await supabaseAdmin
    .from('users')
    .update({
      last_latitude: latitude,
      last_longitude: longitude,
      last_location_updated_at: data.checkin_at
    })
    .eq('id', user.id);

  created(res, enrichWithHours(data), 'Checked in successfully');
});

// POST /api/v1/attendance/checkout
export const checkout = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { latitude, longitude, selfie_url, date: passedDate } = req.body;
  
  const today = todayDate();
  const attendanceDate = parseAppDate(passedDate || today);

  logger.info(`[Attendance] Check-out: user=${user.id}, explicitDate=${passedDate || 'NONE'}`);

  // 1. Try to find record for the specific date
  let { data: record, error: findError } = await supabaseAdmin
    .from('attendance')
    .select('*')
    .eq('user_id', user.id)
    .eq('date', attendanceDate)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // 2. FALLBACK: If no record for today, search for the most recent OPEN shift (Overnight Support)
  if (!record && !passedDate) {
    logger.info(`[Attendance] No record for today, checking for open shifts for user ${user.id}`);
    const { data: openShifts } = await supabaseAdmin
      .from('attendance')
      .select('*')
      .eq('user_id', user.id)
      .in('status', ['checked_in', 'on_break'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (openShifts && openShifts.length > 0) {
      record = openShifts[0];
      logger.info(`[Attendance] Found overnight shift from ${record.date}`);
    }
  }

  if (findError) { badRequest(res, findError.message); return; }
  if (!record) { badRequest(res, 'No check-in found. Please check in first.'); return; }
  if (record.status === 'checked_out') { conflict(res, 'Already checked out for this shift'); return; }

  // Enforce selfie for field executives
  if (user.role === 'executive' && !selfie_url) {
    badRequest(res, 'Selfie is mandatory for check-out');
    return;
  }

  const checkoutTime = new Date();
  const checkinTime = new Date(record.checkin_at!);
  const totalMinutes = Math.round((checkoutTime.getTime() - checkinTime.getTime()) / 60000);
  const workingMinutes = totalMinutes - (record.break_minutes || 0);

  const { data: updatedRecord, error } = await supabaseAdmin
    .from('attendance')
    .update({
      status: 'checked_out',
      checkout_at: checkoutTime.toISOString(),
      checkout_lat: latitude,
      checkout_lng: longitude,
      checkout_selfie_url: selfie_url,
      working_minutes: Math.max(0, workingMinutes),
      total_hours: Number((Math.max(0, workingMinutes) / 60).toFixed(2))
    })
    .eq('id', record.id)
    .select('*, breaks(*)')
    .single();

  if (error) { badRequest(res, error.message); return; }

  // Record activity
  await supabaseAdmin.from('work_activity').insert({
    org_id: user.org_id,
    client_id: user.client_id,
    user_id: user.id,
    attendance_id: record.id,
    activity_type: 'CHECK_OUT',
    lat: latitude,
    lng: longitude,
    captured_at: updatedRecord.checkout_at
  });

  // Clear live location
  await supabaseAdmin.from('users').update({
    last_latitude: null,
    last_longitude: null,
    last_location_updated_at: updatedRecord.checkout_at
  }).eq('id', user.id);

  ok(res, enrichWithHours(updatedRecord), 'Checked out successfully');
});

// POST /api/v1/attendance/break/start
export const startBreak = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = dbToday();

  // Unified lookup: today or most recent open shift
  let { data: record } = await supabaseAdmin
    .from('attendance')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('date', today)
    .maybeSingle();

  if (!record) {
    const { data: open } = await supabaseAdmin
      .from('attendance')
      .select('id, status')
      .eq('user_id', user.id)
      .eq('status', 'checked_in')
      .order('created_at', { ascending: false })
      .limit(1);
    if (open?.length) record = open[0];
  }

  if (!record) { badRequest(res, 'No active shift found to start break'); return; }
  if (record.status !== 'checked_in') { conflict(res, 'Cannot start break in current status'); return; }

  await supabaseAdmin.from('attendance').update({ status: 'on_break' }).eq('id', record.id);
  const { error } = await supabaseAdmin.from('breaks').insert({
    attendance_id: record.id,
    user_id: user.id,
    started_at: new Date().toISOString()
  });

  if (error) { badRequest(res, error.message); return; }
  const { data: updated } = await supabaseAdmin.from('attendance').select('*, breaks(*)').eq('id', record.id).single();
  created(res, enrichWithHours(updated), 'Break started');
});

// POST /api/v1/attendance/break/end
export const endBreak = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = dbToday();

  let { data: record } = await supabaseAdmin
    .from('attendance')
    .select('id, status, break_minutes')
    .eq('user_id', user.id)
    .eq('date', today)
    .maybeSingle();

  if (!record) {
    const { data: open } = await supabaseAdmin
      .from('attendance')
      .select('id, status, break_minutes')
      .eq('user_id', user.id)
      .eq('status', 'on_break')
      .order('created_at', { ascending: false })
      .limit(1);
    if (open?.length) record = open[0];
  }

  if (!record) { badRequest(res, 'No active break shift found'); return; }
  if (record.status !== 'on_break') { conflict(res, 'Not currently on break'); return; }

  const { data: openBreak } = await supabaseAdmin
    .from('breaks')
    .select('id, started_at')
    .eq('attendance_id', record.id)
    .is('ended_at', null)
    .single();

  if (!openBreak) { badRequest(res, 'No open break found'); return; }

  const endTime = new Date();
  const breakMins = Math.round((endTime.getTime() - new Date(openBreak.started_at).getTime()) / 60000);

  await supabaseAdmin.from('breaks').update({ ended_at: endTime.toISOString() }).eq('id', openBreak.id);
  await supabaseAdmin.from('attendance').update({
    status: 'checked_in',
    break_minutes: (record.break_minutes || 0) + breakMins,
  }).eq('id', record.id);

  const { data: updated } = await supabaseAdmin.from('attendance').select('*, breaks(*)').eq('id', record.id).single();
  ok(res, enrichWithHours(updated), 'Break ended');
});

const enrichWithHours = (r: any) => {
  if (r && r.total_hours == null && r.checkin_at) {
    const start = new Date(r.checkin_at).getTime();
    let end: number;

    if (r.status === 'checked_out' && r.checkout_at) {
      end = new Date(r.checkout_at).getTime();
    } else if (r.status === 'checked_in' || r.status === 'on_break') {
      end = new Date().getTime();
    } else {
      return r;
    }

    let durationMs = end - start;
    if (durationMs < 0) durationMs += 24 * 60 * 60 * 1000;
    const hours = (durationMs / 3600000) - ((r.break_minutes || 0) / 60);
    r.total_hours = parseFloat(Math.max(0, hours).toFixed(2));
  }
  if (r && r.date) r.date = formatAppDate(r.date);
  return r;
};

export const getToday = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const todayStr = parseAppDate((req.query.date as string) || todayDate());

  let { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)')
    .eq('user_id', user.id)
    .eq('date', todayStr)
    .order('created_at', { ascending: false });

  if ((!data || data.length === 0) && !error) {
    const { data: active } = await supabaseAdmin
      .from('attendance')
      .select('*, breaks(*)')
      .eq('user_id', user.id)
      .in('status', ['checked_in', 'on_break'])
      .order('created_at', { ascending: false })
      .limit(1);
    if (active?.length) data = active;
  }

  if (error) { badRequest(res, error.message); return; }
  let record = (data && data.length > 0) ? data[0] : null;

  if (data && data.length > 1) {
    const toDelete = data.slice(1).map(r => r.id);
    supabaseAdmin.from('attendance').delete().in('id', toDelete);
  }

  ok(res, enrichWithHours(record));
});

export const getHistory = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as string, req.query.limit as string);
  const { data, error, count } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)', { count: 'exact' })
    .eq('user_id', user.id)
    .order('date', { ascending: false })
    .range(from, to);

  if (error) { badRequest(res, error.message); return; }
  const results = (data || []).map(enrichWithHours);
  ok(res, buildPaginatedResult(results, count || 0, page, limit));
});

export const getTeamToday = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = dbToday();
  const date = parseAppDate((req.query.date as string) || today);
  const { zone_id, city, city_id, user_id, fe_id } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('attendance')
    .select(`
      id, user_id, org_id, client_id, zone_id, date, status,
      checkin_at, checkin_lat, checkin_lng, checkin_selfie_url, checkin_address, checkin_distance_m,
      checkout_at, checkout_lat, checkout_lng, checkout_selfie_url,
      total_hours, break_minutes, working_minutes, notes,
      is_regularised, created_at, updated_at,
      users!attendance_user_id_fkey(name, employee_id, city, zone_id, zones!zone_id(name))
    `)
    .eq('org_id', user.org_id)
    .eq('date', date);

  if (isUUID(user.client_id)) query = query.eq('client_id', user.client_id);
  if (isUUID(zone_id)) query = query.eq('users.zone_id', zone_id);
  if (isUUID(user_id) || isUUID(fe_id)) query = query.eq('user_id', user_id || fe_id);

  const { data, error } = await query.order('checkin_at', { ascending: true, nullsFirst: false });
  if (error) { badRequest(res, error.message); return; }
  ok(res, (data || []).map(enrichWithHours));
});

export const overrideAttendance = asyncHandler<AuthRequest>(async (req, res) => {
  const admin = req.user!;
  const { user_id, date, status, override_reason, checkin_at, checkout_at, notes } = req.body;

  let total_hours: number | null = null;
  if (checkin_at && checkout_at) {
    let ciMs = new Date(checkin_at).getTime();
    let coMs = new Date(checkout_at).getTime();
    if (coMs < ciMs) coMs += 24 * 60 * 60 * 1000;
    total_hours = parseFloat(Math.min(Math.max((coMs - ciMs) / 3_600_000, 0), 24).toFixed(2));
  }

  const payload: any = {
    status,
    checkin_at: checkin_at || null,
    checkout_at: checkout_at || null,
    ...(total_hours !== null && { total_hours }),
    notes,
    override_reason: override_reason || 'Admin override',
    override_by: admin.id,
    is_regularised: true,
  };

  const { data, error } = await supabaseAdmin.from('attendance').upsert({
    user_id, date, org_id: admin.org_id, ...payload
  }, { onConflict: 'user_id,date' }).select().single();

  if (error) { badRequest(res, error.message); return; }
  created(res, data, 'Attendance saved');
});

export const updateAttendanceOverride = asyncHandler<AuthRequest>(async (req, res) => {
  const admin = req.user!;
  const { status, override_reason, checkin_at, checkout_at, notes } = req.body;

  const { data: updated, error } = await supabaseAdmin
    .from('attendance')
    .update({ status, checkin_at, checkout_at, notes, override_reason, override_by: admin.id, is_regularised: true })
    .eq('id', req.params.id)
    .select().single();

  if (error) { badRequest(res, error.message); return; }
  ok(res, updated, 'Attendance updated');
});
