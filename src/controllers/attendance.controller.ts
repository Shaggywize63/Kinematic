import { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin, getUserClient } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, AppError, ok, created, badRequest, conflict, notFound, forbidden, sendSuccess, todayDate, isoDate, isUUID } from '../utils';
import { isWithinGeofence } from '../lib/haversine';
import { DEMO_ORG_ID, getMockAttendanceToday } from '../utils/demoData';
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
export const checkin = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = todayDate();
  const { latitude, longitude, selfie_url, activity_id, zone_id, date: passedDate } = req.body;
  
  console.log(`[Attendance] Check-in: user=${user.id}, selfie=${selfie_url ? 'PRESENT' : 'MISSING'}`);
  if (selfie_url) console.log(`[Attendance] Selfie URL: ${selfie_url}`);
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
    console.log(`[Attendance] user=${user.id} already checked in. Returning existing record.`);
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
      // Note: We no longer block check-in based on distance for primary attendance.
      // We only record the distance for reporting purposes.
    }
  }

  console.log(`[Attendance] Inserting check-in record for ${user.id}`);
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

  if (data) {
    console.log(`[Attendance] Stored Check-in Selfie: ${data.checkin_selfie_url || 'NULL'}`);
  }
  console.log(`[Attendance] Check-in record inserted: ${!!data}`);

  if (error) { badRequest(res, error.message); return; }

  // Phase 2: Create a work_activity record on check-in to track first location
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

  // Update user's last known location immediately for live tracking
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
  
  console.log(`[Attendance] Check-out: user=${user.id}, selfie=${selfie_url ? 'PRESENT' : 'MISSING'}`);
  if (selfie_url) console.log(`[Attendance] Selfie URL: ${selfie_url}`);
  const today = todayDate();
  const attendanceDate = parseAppDate(passedDate || today);

  const { data: record, error: findError } = await supabaseAdmin
    .from('attendance')
    .select('*')
    .eq('user_id', user.id)
    .eq('date', attendanceDate)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError && findError.code !== 'PGRST116') { badRequest(res, findError.message); return; }

  if (!record) { badRequest(res, 'No check-in found for today'); return; }
  if (record.status === 'checked_out') { conflict(res, 'Already checked out today'); return; }

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
    .select()
    .single();

  if (updatedRecord) {
    console.log(`[Attendance] Stored Check-out Selfie: ${updatedRecord.checkout_selfie_url || 'NULL'}`);
  }

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

  // Clear live location on checkout (optional, but requested to stop tracking)
  await supabaseAdmin
    .from('users')
    .update({
      last_latitude: null,
      last_longitude: null,
      last_location_updated_at: updatedRecord.checkout_at
    })
    .eq('id', user.id);

  ok(res, updatedRecord, 'Checked out successfully');
});

// POST /api/v1/attendance/break/start
export const startBreak = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = dbToday();

  const { data: record } = await supabaseAdmin
    .from('attendance')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) { badRequest(res, 'Not checked in today'); return; }
  if (record.status !== 'checked_in') { conflict(res, 'Cannot start break in current status'); return; }

  await supabaseAdmin.from('attendance').update({ status: 'on_break' }).eq('id', record.id);

  const { error } = await supabaseAdmin
    .from('breaks')
    .insert({ attendance_id: record.id, user_id: user.id, started_at: new Date().toISOString() });

  if (error) { badRequest(res, error.message); return; }

  const { data: updatedRecord } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)')
    .eq('id', record.id)
    .single();

  created(res, enrichWithHours(updatedRecord), 'Break started');
});

// POST /api/v1/attendance/break/end
export const endBreak = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = dbToday();

  const { data: record } = await supabaseAdmin
    .from('attendance')
    .select('id, status, break_minutes')
    .eq('user_id', user.id)
    .eq('date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) { badRequest(res, 'Not checked in today'); return; }
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

  const { data: updatedRecord } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)')
    .eq('id', record.id)
    .single();

  ok(res, enrichWithHours(updatedRecord), 'Break ended');
});

// Helper to calculate total_hours if missing from DB (handles active shifts and historical missing data)
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
    if (durationMs < 0) durationMs += 24 * 60 * 60 * 1000; // crossover
    const hours = (durationMs / 3600000) - ((r.break_minutes || 0) / 60);
    r.total_hours = parseFloat(Math.max(0, hours).toFixed(2));
  }
  // Transform date for app display
  if (r && r.date) {
    r.date = formatAppDate(r.date);
  }
  return r;
};

// GET /api/v1/attendance/today
export const getToday = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = parseAppDate((req.query.date as string) || todayDate());

  let { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)')
    .eq('user_id', user.id)
    .eq('date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data && !error) {
    const { data: active } = await supabaseAdmin
      .from('attendance')
      .select('*, breaks(*)')
      .eq('user_id', user.id)
      .in('status', ['checked_in', 'on_break'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (active) data = active;
  }

  if (error && error.code !== 'PGRST116') { badRequest(res, error.message); return; }
  ok(res, enrichWithHours(data));
});

// GET /api/v1/attendance/history
export const getHistory = asyncHandler<AuthRequest>(async (req, res) => {
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

  if (error) { badRequest(res, error.message); return; }
  const results = (data || []).map(enrichWithHours);
  ok(res, buildPaginatedResult(results, count || 0, page, limit));
});

// GET /api/v1/attendance/team  (supervisor+)
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
    `) // Forced redeploy for hint verification c2
    .eq('org_id', user.org_id)
    .eq('date', date);

  if (isUUID(user.client_id)) {
    query = query.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    query = query.eq('client_id', req.query.client_id as string);
  }

  if (isUUID(zone_id)) query = query.eq('users.zone_id', zone_id);
  if (isUUID(user_id) || isUUID(fe_id)) query = query.eq('user_id', user_id || fe_id);

  if (city) query = query.eq('users.city', city);
  if (isUUID(city_id)) {
    const { data: cityData } = await supabaseAdmin.from('cities').select('name').eq('id', city_id).single();
    if (cityData?.name) query = query.eq('users.city', cityData.name);
  }

  if (user.role === 'supervisor') {
    const { data: teamIds } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('supervisor_id', user.id);
    const ids = (teamIds || []).map((u: { id: string }) => u.id);
    if (ids.length) query = query.in('user_id', ids);
    else { ok(res, []); return; }
  }

  const { data, error } = await query.order('checkin_at', { ascending: true, nullsFirst: false });
  if (error) { badRequest(res, error.message); return; }
  const results = (data || []).map(enrichWithHours);
  ok(res, results);
});

// POST /api/v1/attendance/override  (admin+)
export const overrideAttendance = asyncHandler<AuthRequest>(async (req, res) => {
  const admin = req.user!;
  const {
    user_id, date, status, override_reason,
    checkin_at, checkin_lat, checkin_lng, checkin_selfie_url,
    checkout_at, checkout_lat, checkout_lng, checkout_selfie_url,
    notes,
  } = req.body;

  if (!user_id || !date || !status) {
    badRequest(res, 'user_id, date and status are required');
    return;
  }

  let total_hours: number | null = null;
  if (checkin_at && checkout_at) {
    let ciMs = new Date(checkin_at).getTime();
    let coMs = new Date(checkout_at).getTime();
    if (coMs < ciMs) coMs += 24 * 60 * 60 * 1000; // midnight crossover
    total_hours = parseFloat(Math.min(Math.max((coMs - ciMs) / 3_600_000, 0), 24).toFixed(2));
  }

  // Build payload — fields to write regardless of insert or update
  const payload: any = {
    status,
    checkin_at:  checkin_at  || null,
    checkout_at: checkout_at || null,
    ...(total_hours         !== null && { total_hours }),
    ...(checkin_lat         != null  && { checkin_lat:         parseFloat(String(checkin_lat)) }),
    ...(checkin_lng         != null  && { checkin_lng:         parseFloat(String(checkin_lng)) }),
    ...(checkin_selfie_url  != null  && { checkin_selfie_url }),
    ...(checkout_lat        != null  && { checkout_lat:        parseFloat(String(checkout_lat)) }),
    ...(checkout_lng        != null  && { checkout_lng:        parseFloat(String(checkout_lng)) }),
    ...(checkout_selfie_url != null  && { checkout_selfie_url }),
    ...(notes               != null  && { notes }),
    override_reason: override_reason?.trim() || 'Manual override by admin',
    override_by:     admin.id,
    is_regularised:  true,
  };

  // Check if a record already exists for this user+date
  const { data: existing } = await supabaseAdmin
    .from('attendance')
    .select('id')
    .eq('user_id', user_id)
    .eq('date', date)
    .eq('org_id', admin.org_id)
    .maybeSingle();

  let result: any;
  if (existing?.id) {
    // UPDATE — always overwrites every field including status
    result = await supabaseAdmin
      .from('attendance')
      .update(payload)
      .eq('id', existing.id)
      .select('*, users!attendance_user_id_fkey(name, employee_id, zones(name))')
      .single();
  } else {
    // INSERT — brand new record
    result = await supabaseAdmin
      .from('attendance')
      .insert({ org_id: admin.org_id, user_id, date, ...payload })
      .select('*, users!attendance_user_id_fkey(name, employee_id, zones(name))')
      .single();
  }

  // Fallback: override_reason/override_by/is_regularised columns may not exist yet
  if (result.error && (
    result.error.message.includes('override_reason') ||
    result.error.message.includes('override_by') ||
    result.error.message.includes('is_regularised')
  )) {
    const { override_reason: _or, override_by: _ob, is_regularised: _ir, ...basePayload } = payload;
    if (existing?.id) {
      result = await supabaseAdmin.from('attendance').update(basePayload)
        .eq('id', existing.id)
        .select('*, users!user_id(name, employee_id, zones!zone_id(name))').single();
    } else {
      result = await supabaseAdmin.from('attendance').insert({ org_id: admin.org_id, user_id, date, ...basePayload })
        .select('*, users!user_id(name, employee_id, zones!zone_id(name))').single();
    }
  }

  if (result.error) { badRequest(res, result.error.message); return; }
  created(res, result.data, 'Attendance record saved');
});

// PATCH /api/v1/attendance/:id/override  (admin+)
export const updateAttendanceOverride = asyncHandler<AuthRequest>(async (req, res) => {
  const admin = req.user!;
  const {
    status, override_reason,
    checkin_at, checkin_lat, checkin_lng, checkin_selfie_url,
    checkout_at, checkout_lat, checkout_lng, checkout_selfie_url,
    notes,
  } = req.body;

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('attendance')
    .select('date, status, checkin_at, checkout_at')
    .eq('id', req.params.id)
    .eq('org_id', admin.org_id)
    .single();

  if (fetchErr || !existing) { notFound(res, 'Attendance record not found'); return; }

  const newCheckin  = checkin_at  || existing.checkin_at;
  const newCheckout = checkout_at || existing.checkout_at;

  let total_hours: number | null = null;
  if (newCheckin && newCheckout) {
    let ciMs = new Date(newCheckin).getTime();
    let coMs = new Date(newCheckout).getTime();
    if (coMs < ciMs) coMs += 24 * 60 * 60 * 1000; // midnight crossover
    total_hours = parseFloat(Math.min(Math.max((coMs - ciMs) / 3_600_000, 0), 24).toFixed(2));
  }

  // status is ALWAYS written — it is the primary purpose of an override
  // Use incoming status if provided, else keep existing
  const newStatus = status ?? existing.status;
  const updates: any = { status: newStatus };

  // Times
  if (checkin_at)           updates.checkin_at          = checkin_at;
  if (checkout_at)          updates.checkout_at         = checkout_at;
  if (total_hours !== null) updates.total_hours         = total_hours;

  // Optional location + selfie
  if (checkin_lat  != null)  updates.checkin_lat         = checkin_lat;
  if (checkin_lng  != null)  updates.checkin_lng         = checkin_lng;
  if (checkin_selfie_url)    updates.checkin_selfie_url  = checkin_selfie_url;
  if (checkout_lat != null)  updates.checkout_lat        = checkout_lat;
  if (checkout_lng != null)  updates.checkout_lng        = checkout_lng;
  if (checkout_selfie_url)   updates.checkout_selfie_url = checkout_selfie_url;
  if (notes != null)         updates.notes               = notes;

  // Columns added by migration — try with them first, fall back without
  const updatesWithMeta = {
    ...updates,
    override_reason: override_reason?.trim() || 'Manual override by admin',
    override_by:     admin.id,
    is_regularised:  true,
  };

  let result = await supabaseAdmin
    .from('attendance')
    .update(updatesWithMeta)
    .eq('id', req.params.id)
    .eq('org_id', admin.org_id)
    .select('*, users!user_id(name, employee_id, zones!zone_id(name))')
    .single();

  // If failed due to missing columns, retry with base fields only
  if (result.error && (result.error.message.includes('override_reason') || result.error.message.includes('override_by') || result.error.message.includes('is_regularised'))) {
    result = await supabaseAdmin
      .from('attendance')
      .update(updates)
      .eq('id', req.params.id)
      .eq('org_id', admin.org_id)
      .select('*, users!user_id(name, employee_id, zones!zone_id(name))')
      .single();
  }

  if (result.error) { badRequest(res, result.error.message); return; }
  ok(res, result.data, 'Attendance updated');
});
