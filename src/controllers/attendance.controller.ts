import { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin, getUserClient } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, AppError, ok, created, badRequest, conflict, notFound, forbidden, sendSuccess, todayDate, dbToday, isoDate, isUUID, scopeOwnOrg, parseAppDate, formatAppDate } from '../utils';
import { isWithinGeofence } from '../lib/haversine';
import { DEMO_ORG_ID, isDemo, getMockAttendanceToday, getMockAttendanceHistory } from '../utils/demoData';
import { getPagination } from '../utils/pagination';
import { shapeAttendanceHistory } from '../lib/attendanceHistory';
import { logger } from '../lib/logger';
import { fieldForceScopeIds } from '../services/supervisor-scope.service';
import { SUPERVISOR_OR_ABOVE_ROLES } from '../middleware/auth';
import {
  decideCapturedAt, validateSummaryRange, buildAttendanceSummary, resolveAttendanceRules, istDateOf, isValidYmd,
  type CapturedAtDecision, type AttendanceRules,
} from '../services/attendanceRules.service';
import {
  annotateLate, rulesForClient, rulesForClients, readRulesForViewer, clientIdOfUser,
  fetchClientRow, callerMayUseClient,
} from '../services/attendanceRules.store';
import { buildDayTravel } from '../services/travel.service';
import { dayTravel } from '../services/travel.store';

const checkinSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  selfie_url: z.string().url().optional(),
  activity_id: z.string().uuid().optional(),
  zone_id: z.string().uuid().optional(),
  battery_percentage: z.number().optional(),
  // Face-recognition attendance (module 'face_attendance'): the on-device 1:1
  // match result. Optional — absent for clients without the module.
  face_score: z.number().min(0).max(1).optional(),
  face_verified: z.boolean().optional(),
  face_model_id: z.string().max(128).optional(),
  // Location integrity (module-independent): client mock-GPS flag + accuracy.
  is_mock: z.boolean().optional(),
  location_accuracy_m: z.number().optional(),
  // Offline capture (client rule allow_offline_checkin + Idempotency-Key): the
  // moment the rep actually punched. See decideCapturedAt for when it is honoured.
  captured_at: z.string().optional(),
});

const checkoutSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  selfie_url: z.string().url().optional(),
  face_score: z.number().min(0).max(1).optional(),
  face_verified: z.boolean().optional(),
  face_model_id: z.string().max(128).optional(),
  is_mock: z.boolean().optional(),
  location_accuracy_m: z.number().optional(),
  captured_at: z.string().optional(),
});

// ── Offline capture ────────────────────────────────────────────────────────

/** A punch stamped further back than this is "backdated": it must not overwrite the rep's live position. */
const BACKDATED_PUNCH_MS = 5 * 60_000;

const hasIdempotencyKey = (req: AuthRequest): boolean => {
  const raw = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  return typeof key === 'string' && key.trim().length > 0;
};

/**
 * Decide whether the optional body `captured_at` replaces server time for this
 * punch. The client's `allow_offline_checkin` rule is only looked up when the
 * request could possibly qualify (captured_at AND Idempotency-Key present), so
 * ordinary punches cost nothing extra.
 */
async function resolveCapture(
  req: AuthRequest, kind: 'checkin' | 'checkout', extra: { attendanceDate?: string; notBeforeMs?: number | null },
): Promise<CapturedAtDecision> {
  const capturedAt = (req.body ?? {}).captured_at;
  const hasKey = hasIdempotencyKey(req);
  const present = capturedAt !== undefined && capturedAt !== null && capturedAt !== '';
  const allowOffline = present && hasKey
    ? (await rulesForClient(req.user?.client_id)).rules.allow_offline_checkin
    : false;
  const decision = decideCapturedAt({ capturedAt, nowMs: Date.now(), allowOffline, hasIdempotencyKey: hasKey, kind, ...extra });
  if (present && !decision.used) {
    logger.info(`[Attendance] captured_at ignored for ${kind} user=${req.user?.id}: ${decision.reason}`);
  }
  return decision;
}

/**
 * Is a selfie mandatory for this client's executives? True unless the client's
 * `attendance_rules.selfie_required` is explicitly false. Unconfigured clients,
 * a missing client and any lookup failure all read as TRUE (today's behaviour).
 */
async function selfieRequiredFor(clientId: string | null | undefined): Promise<boolean> {
  return (await rulesForClient(clientId)).rules.selfie_required !== false;
}

const isBackdated = (d: CapturedAtDecision): boolean =>
  d.used && !!d.at && Date.now() - d.at.getTime() > BACKDATED_PUNCH_MS;

// POST /api/v1/attendance/checkin
export const checkin = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-att-id', status: 'checked_in', checkin_at: new Date().toISOString() }, 'Checked in successfully (Demo)');
  
  const { latitude, longitude, selfie_url, activity_id, zone_id, battery_percentage,
          face_score, face_verified, face_model_id, is_mock, location_accuracy_m } = req.body;
  const { date: passedDate } = req.query as Record<string, string>;
  const today = isoDate(new Date());

  // Enforce DD--MM--YYYY parsing
  const attendanceDate = parseAppDate(passedDate || today);

  // Check-in is geo-stamped by design: a check-in with no fix can't be trusted
  // or geofenced, so we reject it with a machine-readable code the apps use to
  // prompt "Turn on location to check in" and deep-link to Settings.
  if (latitude == null || longitude == null) return badRequest(res, 'Turn on location to check in.', { code: 'LOCATION_REQUIRED' });

  // Idempotency + zone fetch run in parallel — neither depends on the other.
  // Saves ~150-300ms vs. sequential awaits on a typical Supabase round-trip.
  const resolvedZoneId = zone_id || user.zone_id;
  const [existingResult, zoneResult, feResult] = await Promise.all([
    supabaseAdmin
      .from('attendance')
      .select('*, breaks(*)')
      .eq('user_id', user.id)
      .eq('date', attendanceDate)
      .maybeSingle(),
    resolvedZoneId
      ? supabaseAdmin
          .from('zones')
          .select('meeting_lat, meeting_lng, geofence_radius, name')
          .eq('id', resolvedZoneId)
          .maybeSingle()                                    // was .single() — would throw on missing row
      : Promise.resolve({ data: null, error: null }),
    // The FE's own configured base location (set per user in the dashboard).
    // When present it geofences attendance against THIS point (and enforces it).
    supabaseAdmin
      .from('users')
      .select('base_lat, base_lng, geofence_radius_m')
      .eq('id', user.id)
      .maybeSingle(),
  ]);

  const existing = existingResult.data;

  if (existing) {
    logger.info(`[Attendance] user=${user.id} already has a record for ${attendanceDate}. Returning existing.`);
    const existingRecord = enrichWithHours(existing);
    await annotateLate([existingRecord], user.client_id);
    ok(res, existingRecord);
    return;
  }

  // Enforce selfie for field executives — unless the client opted out with the
  // attendance rule `selfie_required:false` (a GPS-only punch; the selfie columns
  // are nullable). The rule is only looked up when a selfie is actually missing.
  if (user.role === 'executive' && !selfie_url && await selfieRequiredFor(user.client_id)) {
    badRequest(res, 'Selfie is mandatory for check-in');
    return;
  }

  // Resolve the expected location: the FE's own base location takes priority
  // (and is ENFORCED); otherwise fall back to the assigned zone (distance is
  // only recorded, never enforced — zones frequently default to 0,0).
  let distanceMetres = 0;
  const fe = feResult.data as { base_lat?: number | null; base_lng?: number | null; geofence_radius_m?: number | null } | null;
  const hasFeFence = !!fe && fe.base_lat != null && fe.base_lng != null && (fe.geofence_radius_m ?? 0) > 0;

  if (hasFeFence) {
    const { withinFence, distanceMetres: dist } = isWithinGeofence(
      latitude, longitude, fe!.base_lat!, fe!.base_lng!, fe!.geofence_radius_m!
    );
    distanceMetres = dist;
    if (!withinFence) {
      badRequest(
        res,
        `You are about ${Math.round(dist)}m from your assigned location. Move within ${fe!.geofence_radius_m}m to check in.`
      );
      return;
    }
  } else if (zoneResult.data) {
    const { distanceMetres: dist } = isWithinGeofence(
      latitude, longitude,
      zoneResult.data.meeting_lat, zoneResult.data.meeting_lng,
      zoneResult.data.geofence_radius
    );
    distanceMetres = dist;
  }

  // Offline capture: honour the rep's own punch time only when the client allows it
  // (see decideCapturedAt); otherwise this is server time, exactly as before.
  const capture = await resolveCapture(req, 'checkin', { attendanceDate });
  const checkinAt = capture.at ?? new Date();

  // Race-safe insert: if a parallel request beat us to it, the (user_id, date)
  // unique constraint will trigger the conflict path and we return the
  // existing row instead of throwing.
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .upsert({
      user_id: user.id,
      org_id: user.org_id,
      client_id: user.client_id,
      zone_id: resolvedZoneId,
      activity_id,
      date: attendanceDate,
      status: 'checked_in',
      checkin_at: checkinAt.toISOString(),
      checkin_lat: latitude,
      checkin_lng: longitude,
      checkin_selfie_url: selfie_url,
      checkin_distance_m: distanceMetres,
      // Face-match result (only sent when the client has face_attendance on).
      ...(face_verified !== undefined && { checkin_face_verified: face_verified }),
      ...(face_score !== undefined && { checkin_face_score: face_score }),
      ...(face_model_id !== undefined && { face_model_id }),
      // Location-integrity signals (client-reported mock GPS + fix accuracy).
      ...(is_mock !== undefined && { checkin_is_mock: is_mock }),
      ...(location_accuracy_m !== undefined && { checkin_accuracy_m: location_accuracy_m }),
    }, { onConflict: 'user_id,date', ignoreDuplicates: false })
    .select('*, breaks(*)')
    .single();

  if (error) { badRequest(res, error.message); return; }

  // Respond IMMEDIATELY. The two follow-up writes below are pure telemetry
  // (work_activity log + last-known-location for the live tracking map);
  // the FE app doesn't need them in the response. Saves another
  // 200-400ms of perceived latency on the mobile check-in flow.
  const checkinRecord = enrichWithHours(data);
  await annotateLate([checkinRecord], user.client_id);
  created(res, checkinRecord, 'Checked in successfully');

  // Fire-and-forget telemetry. Errors are logged but never returned.
  Promise.all([
    supabaseAdmin.from('work_activity').insert({
      org_id: user.org_id,
      client_id: user.client_id,
      user_id: user.id,
      attendance_id: data.id,
      activity_type: 'CHECK_IN',
      lat: latitude,
      lng: longitude,
      captured_at: data.checkin_at,
    }),
    // A backdated (offline-synced) punch must not overwrite a fresher live position.
    isBackdated(capture) ? Promise.resolve() : supabaseAdmin.from('users').update({
      last_latitude: latitude,
      last_longitude: longitude,
      battery_percentage: battery_percentage !== undefined ? battery_percentage : undefined,
      last_location_updated_at: data.checkin_at,
    }).eq('id', user.id),
  ]).catch((err) => {
    logger.warn(`[Attendance] post-checkin telemetry failed for user=${user.id}: ${err?.message || err}`);
  });
});

// POST /api/v1/attendance/checkout
export const checkout = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: 'demo-att-id', status: 'checked_out', checkout_at: new Date().toISOString() }, 'Checked out successfully (Demo)');

  const { latitude, longitude, selfie_url, face_score, face_verified, face_model_id,
          is_mock, location_accuracy_m } = req.body;
  const { date: passedDate } = req.query as Record<string, string>;
  const today = isoDate(new Date());
  const attendanceDate = parseAppDate(passedDate || today);

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

  // Enforce selfie for field executives (see selfieRequiredFor — opt-out per client).
  if (user.role === 'executive' && !selfie_url && await selfieRequiredFor(user.client_id)) {
    badRequest(res, 'Selfie is mandatory for check-out');
    return;
  }

  // Offline capture (see decideCapturedAt); a checkout can never precede the shift's check-in.
  const capture = await resolveCapture(req, 'checkout', {
    notBeforeMs: record.checkin_at ? Date.parse(record.checkin_at) : null,
  });
  const checkoutTime = capture.at ?? new Date();
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
      total_hours: Number((Math.max(0, workingMinutes) / 60).toFixed(2)),
      ...(face_verified !== undefined && { checkout_face_verified: face_verified }),
      ...(face_score !== undefined && { checkout_face_score: face_score }),
      ...(face_model_id !== undefined && { face_model_id }),
      // Location-integrity signals (client-reported mock GPS + fix accuracy).
      ...(is_mock !== undefined && { checkout_is_mock: is_mock }),
      ...(location_accuracy_m !== undefined && { checkout_accuracy_m: location_accuracy_m }),
    })
    .eq('id', record.id)
    .select('*, breaks(*)')
    .single();

  if (error) { badRequest(res, error.message); return; }

  // Respond first; telemetry follows.
  const checkoutRecord = enrichWithHours(updatedRecord);
  await annotateLate([checkoutRecord], user.client_id);
  ok(res, checkoutRecord, 'Checked out successfully');

  // Fire-and-forget: work_activity log + clear live location.
  Promise.all([
    supabaseAdmin.from('work_activity').insert({
      org_id: user.org_id,
      client_id: user.client_id,
      user_id: user.id,
      attendance_id: record.id,
      activity_type: 'CHECK_OUT',
      lat: latitude,
      lng: longitude,
      captured_at: updatedRecord.checkout_at,
    }),
    // A backdated (offline-synced) checkout must not blank the rep's current live position.
    isBackdated(capture) ? Promise.resolve() : supabaseAdmin.from('users').update({
      last_latitude: null,
      last_longitude: null,
      last_location_updated_at: updatedRecord.checkout_at,
    }).eq('id', user.id),
  ]).catch((err) => {
    logger.warn(`[Attendance] post-checkout telemetry failed for user=${user.id}: ${err?.message || err}`);
  });
});

// POST /api/v1/attendance/break/start
export const startBreak = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { status: 'on_break' }, 'Break started (Demo)');

  const today = isoDate(new Date());
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
  const startedRecord = enrichWithHours(updated);
  await annotateLate([startedRecord], user.client_id);
  created(res, startedRecord, 'Break started');
});

// POST /api/v1/attendance/break/end
export const endBreak = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { status: 'checked_in' }, 'Break ended (Demo)');

  const today = isoDate(new Date());
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
  const endedRecord = enrichWithHours(updated);
  await annotateLate([endedRecord], user.client_id);
  ok(res, endedRecord, 'Break ended');
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
  return r;
};

export const getToday = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockAttendanceHistory(isoDate(new Date()))[0]);
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

  const todayRecord = enrichWithHours(record);
  await annotateLate([todayRecord], user.client_id);
  ok(res, todayRecord);
});

export const getHistory = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, shapeAttendanceHistory(getMockAttendanceHistory(isoDate(new Date())), 3, 1, 20));
  const { page, limit, from, to } = getPagination(req.query.page as string, req.query.limit as string);
  const { data, error, count } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)', { count: 'exact' })
    .eq('user_id', user.id)
    .order('date', { ascending: false })
    .range(from, to);

  if (error) { badRequest(res, error.message); return; }
  const results = (data || []).map(enrichWithHours);
  await annotateLate(results, user.client_id);
  ok(res, shapeAttendanceHistory(results, count || 0, page, limit));
});

/**
 * Who a manager's team-attendance view covers — shared by the team list and the
 * summary so both apply the SAME visibility rules.
 *
 *  - client-bound callers (client_id pinned in the JWT) are NEVER cross-org;
 *  - otherwise the picked client comes from X-Client-Id, then ?client_id=;
 *  - `isGlobal` = a platform caller with no client picked (cross-org view);
 *  - `scopeOrgId` is the picked client's org (so acting-as-ClientA never shows
 *    ClientB's rows), else the caller's own org;
 *  - `scopeIds` = supervisor-hierarchy restriction (opt-in per client), null = none.
 *
 * `verifyPickedClient` (new endpoints only) additionally requires a header /
 * query-picked client to belong to the caller's org — the legacy team list keeps
 * its historical behaviour unchanged.
 */
interface TeamAttendanceScope {
  isGlobal: boolean;
  isClientBound: boolean;
  pickedClientId: string | null;
  scopeOrgId: string;
  scopeIds: string[] | null;
}

async function resolveTeamAttendanceScope(
  req: AuthRequest, opts: { verifyPickedClient?: boolean } = {},
): Promise<TeamAttendanceScope> {
  const user = req.user!;
  const { client_id } = req.query as Record<string, string>;

  const isSagar = (user.name || '').toLowerCase().includes('sagar');
  const role = (user.role || '').toLowerCase();
  // A CLIENT-BOUND user (client_id pinned in the JWT, e.g. ByteBack's sub_admin
  // admin/manager) is NEVER cross-org. Previously isSuper = role.includes('admin')
  // matched 'sub_admin', so such a caller was treated as global and saw every
  // org's attendance — other tenants'/seeded rows leaked in as "mock" data.
  const isClientBound = isUUID((user as any).client_id);
  const isSuper = !isClientBound && (role === 'super_admin' || role === 'admin' || role === 'main_admin' || role === 'master_admin');
  // Resolve the selected client from the JWT (pinned), ?client_id=, or the
  // X-Client-Id header. A super-admin "acting as a client" sets that header, and
  // it MUST be honoured even when the top-right picker still reads "All clients"
  // (which sends no client_id) — otherwise acting-as-ClientA returned EVERY org's
  // attendance (cross-tenant leak).
  const headerClientId = req.headers['x-client-id'] as string | undefined;
  const pickedClientId = isClientBound ? ((user as any).client_id as string)
    : isUUID(headerClientId as string) ? (headerClientId as string)
    : isUUID(client_id as string) ? (client_id as string)
    : null;
  const isGlobal = !isClientBound && (isSagar || isSuper) && !pickedClientId;

  let scopeOrgId = user.org_id;
  if (!isGlobal) {
    // Scope to the picked client's org (super-admin acting as a client) or the
    // caller's own org, plus the client itself. Resolving the picked client's
    // org is what isolates a Trent view from a ByteBack view, etc.
    if (!isClientBound && pickedClientId) {
      if (opts.verifyPickedClient) {
        const row = await fetchClientRow(pickedClientId);
        if (!row || !callerMayUseClient(req, row)) throw new AppError(404, 'Client not found', 'NOT_FOUND');
        if (row.org_id) scopeOrgId = row.org_id;
      } else {
        const { data: pc } = await supabaseAdmin
          .from('clients').select('org_id').eq('id', pickedClientId).maybeSingle();
        const pcOrg = (pc as { org_id?: string } | null)?.org_id;
        if (pcOrg) scopeOrgId = pcOrg;
      }
    }
  }

  // Supervisor-hierarchy scoping (opt-in per client): a team manager sees only
  // attendance for the field reps in their supervisor subtree. null = no
  // restriction (every other tenant, the master, and data_scope='all').
  const scopeIds = await fieldForceScopeIds(req);
  return { isGlobal, isClientBound, pickedClientId, scopeOrgId, scopeIds };
}

export const getTeamToday = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockAttendanceToday(isoDate(new Date())).executives);
  // Accept both `f`/`t` and `from`/`to` as aliases for the date range
  const { f, t, from, to, zone_id, user_id, fe_id } = req.query as Record<string, string>;
  const rangeFrom = f || from;
  const rangeTo   = t || to;

  const { isGlobal, pickedClientId, scopeOrgId, scopeIds } = await resolveTeamAttendanceScope(req);

  let query = supabaseAdmin
    .from('attendance')
    .select(`
      *,
      users:user_id(name, employee_id, city, role, zone_id, zones!zone_id(name))
    `);

  // Date Filtering: Strict range
  query = query.gte('date', parseAppDate(rangeFrom)).lte('date', parseAppDate(rangeTo));

  // Auth / Org Filtering
  if (!isGlobal) query = scopeOwnOrg(query, scopeOrgId, pickedClientId ?? undefined);

  if (scopeIds) query = query.in('user_id', scopeIds);

  // Additional Property Filters
  if (isUUID(zone_id)) query = query.eq('zone_id', zone_id);
  if (isUUID(user_id) || isUUID(fe_id)) {
    query = query.eq('user_id', user_id || fe_id);
  }

  // Cap response size — even a 30-day range across 500 FEs would otherwise
  // return 15k+ rows and lock the dashboard table.
  const { data, error } = await query
    .order('date', { ascending: false })
    .order('checkin_at', { ascending: true, nullsFirst: false })
    .limit(2000);

  if (error) { badRequest(res, error.message); return; }
  const rows = (data || []).map(enrichWithHours);
  // `late` per row, using each row's own client's rules (a global view spans clients).
  await annotateLate(rows, pickedClientId);
  ok(res, rows);
});

/**
 * Add `late` to a row an admin override returns. Override rows can carry no
 * client_id (the upsert doesn't stamp one), so fall back to the admin's client,
 * then to the row owner's client.
 */
async function annotateOverrideLate(row: any, adminClientId?: string | null): Promise<void> {
  if (!row?.checkin_at) return;
  const fallback = row.client_id ?? adminClientId ?? await clientIdOfUser(row.user_id);
  await annotateLate([row], fallback);
}

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
  await annotateOverrideLate(data, admin.client_id);
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
  await annotateOverrideLate(updated, admin.client_id);
  ok(res, updated, 'Attendance updated');
});

// GET /api/v1/attendance/rules
// The resolved attendance rules for the caller's client (read-only, any
// authenticated user). The apps read this for shift times and to know whether
// offline check-in is allowed. `configured:false` = legacy behaviour (defaults shown).
export const getAttendanceRules = asyncHandler<AuthRequest>(async (req, res) => {
  const resolved = await readRulesForViewer(req);
  ok(res, { configured: resolved.configured, rules: resolved.rules });
});

// ── Summary ────────────────────────────────────────────────────────────────

const PAGE = 1000;                       // PostgREST returns at most 1000 rows per request
const ID_CHUNK = 100;                    // keeps `in.(…)` URLs short
const MAX_ROSTER = 1000;
const MAX_PAGES_PER_CHUNK = 40;

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Read every page of a ranged query (a plain `.limit()` would silently stop at 1000 rows). */
async function fetchAllPages<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES_PER_CHUNK; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  logger.warn(`[Attendance] summary read hit the ${MAX_PAGES_PER_CHUNK}-page cap; result may be truncated`);
  return out;
}

interface RosterUser {
  id: string; name: string | null; role?: string | null; created_at?: string | null; client_id?: string | null;
  org_role?: { data_scope?: string | null } | Array<{ data_scope?: string | null }> | null;
}

const FIELD_ROLES = new Set(['executive', 'field_executive']);
const isFieldRep = (u: RosterUser): boolean => {
  const scope = Array.isArray(u.org_role) ? u.org_role[0]?.data_scope : u.org_role?.data_scope;
  return FIELD_ROLES.has(String(u.role ?? '').toLowerCase()) || scope === 'own';
};

// GET /api/v1/attendance/summary?from=YYYY-MM-DD&to=YYYY-MM-DD[&user_id=]
// Per-user present / late / half-day / on-leave / absent counts over a range
// (≤62 days). Visibility mirrors the team attendance list: managers and admins
// see their team (same client / org / supervisor-subtree scope), a rep only
// ever gets themself. See buildAttendanceSummary for the counting rules.
export const getAttendanceSummary = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const range = validateSummaryRange(req.query.from, req.query.to);
  if ('error' in range) { badRequest(res, range.error); return; }
  const { from, to } = range;

  const rawUserId = req.query.user_id;
  if (rawUserId !== undefined && rawUserId !== '' && (typeof rawUserId !== 'string' || !isUUID(rawUserId))) {
    badRequest(res, 'user_id must be a valid UUID');
    return;
  }
  const wantedUserId = typeof rawUserId === 'string' && rawUserId ? rawUserId : null;

  const todayIst = istDateOf(Date.now()) as string;      // IST calendar day, not the server's
  if (isDemo(user)) {
    const demo = buildAttendanceSummary({ from, to, todayIst, rules: resolveAttendanceRules(null).rules, users: [], attendance: [], leaves: [] });
    ok(res, demo);
    return;
  }

  const isManager = SUPERVISOR_OR_ABOVE_ROLES.includes(((user.role || '').toLowerCase()) as any);
  if (!isManager && wantedUserId && wantedUserId !== user.id) { forbidden(res, 'You can only view your own attendance summary'); return; }

  // ── roster: who the caller may see ──
  let userQ = supabaseAdmin
    .from('users')
    .select('id, name, role, created_at, client_id, org_role:org_roles!org_role_id(data_scope)')
    .eq('is_active', true)
    .is('deleted_at', null);
  let scopeClientId: string | null = user.client_id ?? null;
  if (isManager) {
    const scope = await resolveTeamAttendanceScope(req, { verifyPickedClient: true });
    // A platform caller with no client picked is held to their own org — a
    // cross-org roster x 62 days is never what a summary wants.
    userQ = userQ.eq('org_id', scope.isGlobal ? user.org_id : scope.scopeOrgId);
    if (scope.pickedClientId) userQ = userQ.eq('client_id', scope.pickedClientId);
    if (scope.scopeIds) userQ = userQ.in('id', scope.scopeIds);
    if (wantedUserId) userQ = userQ.eq('id', wantedUserId);
    scopeClientId = scope.pickedClientId;
  } else {
    userQ = userQ.eq('id', user.id);
  }
  const { data: userRows, error: userErr } = await userQ.limit(MAX_ROSTER);
  if (userErr) { badRequest(res, userErr.message); return; }
  const candidates = (userRows ?? []) as unknown as RosterUser[];
  if (candidates.length >= MAX_ROSTER) logger.warn(`[Attendance] summary roster hit the ${MAX_ROSTER}-user cap`);

  // ── attendance + approved leave for the roster, over the capped range ──
  const effectiveTo = to < todayIst ? to : todayIst;
  const ids = candidates.map((u) => u.id);
  type AttRow = { user_id: string; date: string; status: string | null; checkin_at: string | null };
  type LeaveRow = { user_id: string; from_date: string; to_date: string; half_day_start: boolean | null; half_day_end: boolean | null };
  const attendance: AttRow[] = [];
  const leaves: LeaveRow[] = [];
  if (effectiveTo >= from) {
    for (const part of chunk(ids, ID_CHUNK)) {
      attendance.push(...await fetchAllPages<AttRow>((a, b) =>
        supabaseAdmin.from('attendance').select('user_id, date, status, checkin_at')
          .in('user_id', part).gte('date', from).lte('date', effectiveTo)
          .order('date', { ascending: true }).order('user_id', { ascending: true }).range(a, b) as any));
      leaves.push(...await fetchAllPages<LeaveRow>((a, b) =>
        supabaseAdmin.from('leave_requests').select('user_id, from_date, to_date, half_day_start, half_day_end')
          .in('user_id', part).eq('status', 'approved').lte('from_date', effectiveTo).gte('to_date', from)
          .order('from_date', { ascending: true }).order('user_id', { ascending: true }).range(a, b) as any));
    }
  }

  // A manager with no punches in the range isn't a rep; keep field reps, plus anyone who actually punched.
  const punched = new Set(attendance.map((r) => r.user_id));
  const roster = isManager ? candidates.filter((u) => isFieldRep(u) || punched.has(u.id) || u.id === wantedUserId) : candidates;

  // ── rules: each user's own client, falling back to the scope's client ──
  const clientRules = await rulesForClients([scopeClientId, ...roster.map((u) => u.client_id)]);
  const defaults = resolveAttendanceRules(null);
  const rulesOf = (clientId: string | null | undefined): AttendanceRules =>
    ((clientId && clientRules.get(clientId)) || (scopeClientId && clientRules.get(scopeClientId)) || defaults).rules;
  const clientOfUser = new Map(roster.map((u) => [u.id, u.client_id ?? null] as const));

  ok(res, buildAttendanceSummary({
    from, to, todayIst,
    rules: rulesOf(scopeClientId),
    rulesForUser: (id) => rulesOf(clientOfUser.get(id) ?? scopeClientId),
    users: roster.map((u) => ({ id: u.id, name: u.name, created_at: u.created_at })),
    attendance,
    leaves,
  }));
});

// ── Distance travelled ─────────────────────────────────────────────────────

// GET /api/v1/attendance/travel?date=YYYY-MM-DD[&user_id=<uuid>]
// The kilometres a person travelled on an IST day: the legs between their attendance check-in, each
// form visit (check-in → check-out) and the attendance check-out (or "now" while the shift is open),
// measured on the GPS trail and falling back to the straight line when the trail is missing. See
// services/travel.service.ts for the definition. `date` defaults to today (IST); `user_id` to the
// caller. Someone else's travel needs the visibility the team attendance list uses: managers and
// admins within their org / client / supervisor scope — a rep gets 403. No attendance that day is
// a 200 with attendance_id null and zero km.
export const getTravel = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const nowMs = Date.now();

  const rawDate = req.query.date;
  let date = istDateOf(nowMs) as string;
  if (rawDate !== undefined && rawDate !== '') {
    if (typeof rawDate !== 'string' || !isValidYmd(rawDate)) { badRequest(res, 'date must be a date in YYYY-MM-DD format'); return; }
    date = rawDate;
  }

  const rawUserId = req.query.user_id;
  if (rawUserId !== undefined && rawUserId !== '' && (typeof rawUserId !== 'string' || !isUUID(rawUserId))) {
    badRequest(res, 'user_id must be a valid UUID');
    return;
  }
  const wantedUserId = typeof rawUserId === 'string' && rawUserId ? rawUserId : null;

  if (isDemo(user)) {
    ok(res, buildDayTravel({ date, userId: wantedUserId ?? user.id, attendance: null, visits: [], trail: [], nowMs }));
    return;
  }

  let targetId: string = user.id;
  let orgId: string = user.org_id;
  if (wantedUserId && wantedUserId !== user.id) {
    const isManager = SUPERVISOR_OR_ABOVE_ROLES.includes(((user.role || '').toLowerCase()) as any);
    if (!isManager) { forbidden(res, 'You can only view your own travel'); return; }
    // Same visibility as the team attendance list / summary: the person must sit inside the
    // caller's org (and picked client, and supervisor subtree when that scoping is on).
    const scope = await resolveTeamAttendanceScope(req, { verifyPickedClient: true });
    const scopeOrg = scope.isGlobal ? user.org_id : scope.scopeOrgId;
    let q = supabaseAdmin.from('users').select('id').eq('id', wantedUserId).eq('org_id', scopeOrg).is('deleted_at', null);
    if (scope.pickedClientId) q = q.eq('client_id', scope.pickedClientId);
    if (scope.scopeIds) q = q.in('id', scope.scopeIds);
    const { data: target, error } = await q.maybeSingle();
    if (error && error.code !== 'PGRST116') { badRequest(res, error.message); return; }   // PGRST116 = no such row
    if (!target) { notFound(res, 'User not found'); return; }
    targetId = wantedUserId;
    orgId = scopeOrg;
  }

  ok(res, await dayTravel(targetId, date, { orgId, nowMs }));
});
