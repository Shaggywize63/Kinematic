import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest, todayDate, dbToday, toIST, isoDate, isUUID, formatAppDate, parseAppDate } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';
import { DEMO_ORG_ID, getMockSummary, getMockTrends, getMockFeed, getMockHeatmap, getMockLocations } from '../utils/demoData';

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */

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
export const getSummary = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const user = req.user!;
  // DEMO MODE REMOVED: Always show real data to ensure testing progress is visible.

  const from = (req.query.from as string) || (req.query.date as string) || isoDate(toIST(new Date()));
  const to   = (req.query.to   as string) || (req.query.date as string) || isoDate(toIST(new Date()));
  const date = to; // For backwards compatibility

  // Combined concurrent fetch for independent counts to minimize sequential await overhead
  const [kpisRes, totalExecsRes, activeSosRes, openGrievancesRes, visitLogsRes] = await Promise.all([
    supabaseAdmin.from('v_daily_kpis').select('*').eq('org_id', user.org_id).eq('date', to).single(),
    supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true),
    supabaseAdmin.from('sos_alerts').select('id', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('status', 'active'),
    supabaseAdmin.from('grievances').select('id', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('status', 'submitted'),
    supabaseAdmin.from('visit_logs').select('id', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('date', date)
  ]);

  const kpis = kpisRes.data;
  const totalExecs = totalExecsRes.count || 0;
  const activeSos = activeSosRes.count || 0;
  const openGrievances = openGrievancesRes.count || 0;
  const totalVisits = visitLogsRes.count || 0;

  // Real-time metrics from form_submissions - Flattened for build stability
  let submissionsQuery = supabaseAdmin.from('form_submissions').select('id, is_converted, user_id, submitted_at, date', { count: 'exact' });
  submissionsQuery = submissionsQuery.eq('org_id', user.org_id);
  submissionsQuery = submissionsQuery.gte('submitted_at', `${from}T00:00:00+05:30`);
  submissionsQuery = submissionsQuery.lte('submitted_at', `${to}T23:59:59+05:30`);

  if (isUUID(user.client_id)) {
    submissionsQuery = submissionsQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    submissionsQuery = submissionsQuery.eq('client_id', req.query.client_id as string);
  }

  const userRole = (user.role || '').toLowerCase();
  const isFE = userRole.includes('executive');
  
  if (isFE) {
    submissionsQuery = submissionsQuery.eq('user_id', user.id);
  } else if (userRole === 'city_manager' && user.assigned_cities?.length) {
    // City Manager: Filter by assigned cities (using city field in users/zones)
    submissionsQuery = submissionsQuery.in('users.city', user.assigned_cities);
  }

  const { data: subs, count: subCount, error: subErr } = await submissionsQuery;
  const totalEngagements = subCount || 0;
  // User: TFF is the count of converted forms (8 vs 32)
  const totalTff = (subs || []).filter(s => s.is_converted).length;
  const tffRateRaw = totalEngagements > 0 ? (totalTff / totalEngagements) * 100 : 0;
  const tffRate = Math.round(tffRateRaw);

  // New Metrics: Days Worked & Leaves (Current Month)
  const now = toIST(new Date());
  const monthStartStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  let attendanceQuery = supabaseAdmin
    .from('attendance')
    .select('status, user_id, date, total_hours, checkin_at')
    .eq('org_id', user.org_id)
    .gte('date', from)
    .lte('date', to);

  if (isUUID(user.client_id)) {
    attendanceQuery = attendanceQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    attendanceQuery = attendanceQuery.eq('client_id', req.query.client_id as string);
  }

  if (isFE) {
    attendanceQuery = attendanceQuery.eq('user_id', user.id);
  }

  const { data: attStats, error: attErr } = await attendanceQuery;

  const attArr = attStats || [];
  // Count distinct days worked in the current month
  const workedDaysSet = new Set(
    attArr
      .filter(a => a.status === 'present' || a.status === 'checked_out' || a.status === 'checked_in')
      .map(a => a.date)
  );
  const totalDaysWorked = workedDaysSet.size;
  const totalLeaves = attArr.filter(a => a.status === 'absent' || (a.status || '').toLowerCase().includes('leave')).length;

  // Calculate total hours worked (including real-time for active shifts)
  let totalHoursWorked = 0;
  attArr.forEach(a => {
    enrichWithHours(a);
    if (a.total_hours) totalHoursWorked += a.total_hours;
  });


  // Fetch top performers (Top 5 by TFF in range) - reverting to submitted_at for completeness
  let topPerfQuery = supabaseAdmin
    .from('form_submissions')
    .select('user_id, is_converted, submitted_at, users!user_id(name, zone_id, zones!zone_id(id, name))')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00+05:30`)
    .lte('submitted_at', `${to}T23:59:59+05:30`);
  
  if (isUUID(user.client_id)) {
    topPerfQuery = topPerfQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    topPerfQuery = topPerfQuery.eq('client_id', req.query.client_id as string);
  }
  const { data: topPerf } = await topPerfQuery;

  const tpMap = new Map<string, { name: string; zone: string; tff: number }>();
  (topPerf || []).forEach((s) => {
    const u = s.users as any;
    if (!tpMap.has(s.user_id)) tpMap.set(s.user_id, { name: u?.name || 'Unknown', zone: u?.zones?.name || 'Unknown', tff: 0 });
    tpMap.get(s.user_id)!.tff++;
  });
  const topPerformers = Array.from(tpMap.values()).sort((a, b) => b.tff - a.tff).slice(0, 5);

  // Fetch zone performance (TFF vs Target)
  let zonesQuery = supabaseAdmin
    .from('zones')
    .select('id, name, tff_target')
    .eq('org_id', user.org_id);
  
  if (isUUID(user.client_id)) {
    zonesQuery = zonesQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    zonesQuery = zonesQuery.eq('client_id', req.query.client_id as string);
  }
  const { data: zones } = await zonesQuery;

  const zpMap = new Map<string, { zone: string; tff: number; target: number }>();
  (zones || []).forEach((z) => zpMap.set(z.id, { zone: z.name, tff: 0, target: z.tff_target || 0 }));
  // Add unassigned bucket for users without a hub
  zpMap.set('unassigned', { zone: 'Unassigned', tff: 0, target: 0 });

  (topPerf || []).forEach((s) => {
    const u = s.users as any;
    const zoneId = u?.zone_id || u?.zones?.id;
    if (zoneId && zpMap.has(zoneId)) {
      zpMap.get(zoneId)!.tff++;
    } else {
      zpMap.get('unassigned')!.tff++;
    }
  });
  const zonePerformance = Array.from(zpMap.values()).filter(z => z.target > 0 || z.tff > 0);

  // Fallback for avg_attendance if view is empty 
  const totalExecsCount = totalExecs || 1;
  const attendancePct = Math.round((attArr.length / totalExecsCount) * 100);

  const kpisData = {
    total_tff: totalEngagements,
    total_engagements: totalEngagements,
    tff_rate: 100,
    avg_attendance: kpis?.avg_attendance || (attendancePct > 100 ? 100 : attendancePct),
    total_leaves: totalLeaves || 0,
    total_days_worked: totalDaysWorked || 0,
    total_hours_worked: +totalHoursWorked.toFixed(1),
    active_sos: activeSos || 0,
    open_grievances: openGrievances || 0,
  };

  return ok(res, {
    date,
    kpis: kpisData,
    top_performers: topPerformers,
    zone_performance: zonePerformance,
    total_executives: totalExecs || 0,
  });
});

/* ── GET /api/v1/analytics/tff-trends ─────────────────────── */
export const getTffTrends = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;

  const from = (req.query.from as string) || isoDate(new Date(Date.now() - 7 * 86400000));
  const to   = (req.query.to   as string) || isoDate(new Date());

  let trendQuery = supabaseAdmin
    .from('form_submissions')
    .select('submitted_at, is_converted')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00`)
    .lte('submitted_at', `${to}T23:59:59`);
  
  if (isUUID(user.client_id)) {
    trendQuery = trendQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    trendQuery = trendQuery.eq('client_id', req.query.client_id as string);
  }
  const { data, error } = await trendQuery;

  if (error) return badRequest(res, error.message);

  const days: string[] = [];
  for (const d = new Date(from); d <= new Date(to); d.setDate(d.getDate() + 1)) {
    days.push(isoDate(new Date(d)));
  }

  const byDay: Record<string, { tff: number; engagements: number }> = {};
  days.forEach(d => byDay[d] = { tff: 0, engagements: 0 });

  (data || []).forEach(s => {
    const d = isoDate(toIST(new Date(s.submitted_at)));
    if (byDay[d]) {
      byDay[d].engagements++;
      if (s.is_converted) byDay[d].tff++;
    }
  });

  const trend = days.map(d => ({
    date: d,
    tff: byDay[d].engagements, // Use engagements for TFF to match 32 total
    engagements: byDay[d].engagements,
    label: d === isoDate(new Date()) ? 'Today' : new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  }));

  return ok(res, trend);
});

/* ── GET /api/v1/analytics/activity-feed ─────────────────── */
export const getActivityFeed = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;

  const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));

  const userRole = (user.role || '').toLowerCase();

  let submissionQuery = supabaseAdmin
    .from('form_submissions')
    .select('id, submitted_at, is_converted, outlet_name, users!user_id(name, city), builder_forms:builder_forms!fk_submission_template(title)')
    .eq('org_id', user.org_id);

  if (isUUID(user.client_id)) {
    submissionQuery = submissionQuery.or(`client_id.eq.${user.client_id},user_id.eq.${user.id}`);
  } else if (isUUID(req.query.client_id)) {
    submissionQuery = submissionQuery.eq('client_id', req.query.client_id as string);
  } else {
    // Show user's own submissions by default
    submissionQuery = submissionQuery.eq('user_id', user.id);
  }

  const { data: submissions } = await submissionQuery.order('submitted_at', { ascending: false }).limit(limit);

  const feed = (submissions || []).map((s) => {
    const u = s.users as unknown as { name: string; city: string | null } | null;
    const f = s.builder_forms as unknown as { title: string } | null;
    return { 
      id: s.id, 
      outlet_name: s.outlet_name || 'Unknown Store',
      submitted_at: s.submitted_at,
      is_converted: s.is_converted,
      user: { name: u?.name || 'Unknown', zones: { city: u?.city || '', name: '' } },
      // Keep description/meta for potential web compatibility, but Android needs the above
      description: `${u?.name || 'Unknown'} submitted ${f?.title || 'Form'}`,
      form_name: f?.title || 'General Form',
    };
  }).sort((a, b) => new Date(b.submitted_at!).getTime() - new Date(a.submitted_at!).getTime());

  return ok(res, feed);
});

/* ── GET /api/v1/analytics/hourly ────────────────────────── */
export const getHourly = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const date = (req.query.date as string) || isoDate(toIST(new Date()));

  let hourlyQuery = supabaseAdmin
    .from('form_submissions').select('submitted_at, is_converted')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${date}T00:00:00`).lte('submitted_at', `${date}T23:59:59`);
  
  if (isUUID(user.client_id)) {
    hourlyQuery = hourlyQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id)) {
    hourlyQuery = hourlyQuery.eq('client_id', req.query.client_id as string);
  }
  const { data, error } = await hourlyQuery;

  if (error) return badRequest(res, error.message);

  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${h.toString().padStart(2,'0')}:00`, engagements: 0, tff: 0 }));
  (data || []).forEach((s) => { const h = new Date(s.submitted_at).getHours(); hourly[h].engagements++; if (s.is_converted) hourly[h].tff++; });
  return ok(res, hourly.filter((h) => h.engagements > 0 || (h.hour >= 8 && h.hour <= 20)));
});

/* ── GET /api/v1/analytics/contact-heatmap ───────────────── */
export const getContactHeatmap = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  
  
  // Strictly last 7 days for heatmap as requested
  const endStr   = isoDate(toIST(new Date()));
  const startStr = isoDate(new Date(toIST(new Date()).getTime() - 6 * 24 * 60 * 60 * 1000));

  // Filter by 'date' column (YYYY-MM-DD) which is more reliable than submitted_at ISO strings in this app
  let heatmapQuery = supabaseAdmin
    .from('form_submissions')
    .select('submitted_at, is_converted, date')
    .eq('org_id', user.org_id)
    .gte('date', startStr)
    .lte('date', endStr);
  
  if (isUUID(user.client_id)) {
    heatmapQuery = heatmapQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    heatmapQuery = heatmapQuery.eq('client_id', req.query.client_id as string);
  }
  const { data, error } = await heatmapQuery;

  if (error) return badRequest(res, error.message);

  const startDate = new Date(startStr);
  const endDate   = new Date(endStr);
  const daysArr   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  
  // Dynamically build the grid based on the date range
  const grid: any[] = [];
  for (let i = 0; i <= 6; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    // Use manual formatting to avoid toISOString() timezone shift back to UTC
    const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
    const iDay = (d.getDay() + 6) % 7; // Mon=0
    grid.push({
      date: dateStr,
      day: daysArr[iDay],
      hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
      total: 0
    });
  }

  const hourCounts = new Array(24).fill(0);
  const dayCounts: Record<string, number> = {};
  daysArr.forEach(d => { dayCounts[d] = 0; });

  (data || []).forEach((s) => {
    // Convert to IST representation for correct bucket matching
    const ist = toIST(new Date(s.submitted_at));
    const dateStr = `${ist.getFullYear()}-${(ist.getMonth() + 1).toString().padStart(2, '0')}-${ist.getDate().toString().padStart(2, '0')}`;
    const hr = ist.getHours();
    
    const row = grid.find(g => g.date === dateStr);
    if (row) {
      row.hours[hr].count++;
      row.total++;
      hourCounts[hr]++;
      dayCounts[row.day]++;
    }
  });

  // Find peak hour and peak day
  let peakHr = 0; 
  let maxHrVal = 0;
  hourCounts.forEach((c, h) => {
    if (c > maxHrVal) {
      maxHrVal = c;
      peakHr = h;
    }
  });

  let peakDayName = '—';
  let maxDayVal = 0;
  Object.entries(dayCounts).forEach(([name, count]) => {
    if (count > maxDayVal) {
      maxDayVal = count;
      peakDayName = name;
    }
  });

  return ok(res, {
    rows: grid,
    summary: {
      peak_hour: maxHrVal > 0 ? `${peakHr.toString().padStart(2, '0')}:00` : '—',
      peak_hour_count: maxHrVal,
      peak_day: peakDayName,
      peak_day_count: maxDayVal,
      total_contacts: data?.length || 0
    }
  });
});

/* ── GET /api/v1/analytics/weekly-contacts ───────────────── */
/* Now supports ?from=YYYY-MM-DD&to=YYYY-MM-DD for date range  */
export const getWeeklyContacts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  let from = req.query.from as string;
  let to   = req.query.to   as string;

  // Default: last 7 days
  if (!from || !to) {
    const days7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return isoDate(d); });
    from = days7[0]; to = days7[6];
  }

  // Build date range array using stable local date generation
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T23:59:59');
  const days: string[] = [];
  const curr = new Date(start);
  while (curr <= end) {
    days.push(isoDate(new Date(curr)));
    curr.setDate(curr.getDate() + 1);
  }

  let weeklyQuery = supabaseAdmin
    .from('form_submissions')
    .select('submitted_at, is_converted, date')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00`)
    .lte('submitted_at', `${to}T23:59:59`);
  
  if (isUUID(user.client_id)) {
    weeklyQuery = weeklyQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    weeklyQuery = weeklyQuery.eq('client_id', req.query.client_id as string);
  }
  const { data, error } = await weeklyQuery;

  if (error) return badRequest(res, error.message);

  const byDay: Record<string, { engagements: number; tff: number }> = {};
  days.forEach((d) => { byDay[d] = { engagements: 0, tff: 0 }; });
  (data || []).forEach((s: any) => {
    // Ignore s.date as it may be UTC-grouped in DB. For the trend chart, strictly use IST derivation from timestamp.
    const ist = toIST(new Date(s.submitted_at));
    const d = isoDate(ist);
    if (byDay[d]) { 
      byDay[d].engagements++; 
      if (s.is_converted) byDay[d].tff++; 
    }
  });

  const result = days.map((d) => ({
    date: d,
    label: new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
    short_label: new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }),
    engagements: byDay[d].engagements, 
    tff: byDay[d].engagements, // Use engagements for TFF to match 32 total
    tff_rate: 100,
  }));

  return ok(res, {
    days: result,
    total_engagements: result.reduce((s, d) => s + d.engagements, 0),
    total_tff: result.reduce((s, d) => s + d.engagements, 0),
  });
});

/* ── GET /api/v1/analytics/live-locations ────────────────── */
export const getLiveLocations = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = todayDate();
  // DEMO MODE REMOVED: Always show real data to ensure testing progress is visible.

  const { city, city_id, zone_id, fe_id, user_id } = req.query as Record<string, string>;

  // Role-Agnostic Query: Fetch all users except strictly restricted ones (Admin/Client)
  // Fix: PostgREST .in/.not in expects a simple parenthesized list: (val1,val2,val3)
  const restrictedRoles = ['admin', 'super_admin'];
  
  let execQuery = supabaseAdmin
    .from('users')
    .select('id, name, employee_id, role, battery_percentage, last_latitude, last_longitude, last_location_updated_at, zone_id, zones!zone_id(name, city, meeting_lat, meeting_lng)')
    .eq('org_id', user.org_id)
    .not('role', 'in', `(${restrictedRoles.join(',')})`);
  
  // Super Admin can see everyone; others are restricted by their own client_id
  if (isUUID(user.client_id) && user.role !== 'super_admin') {
    execQuery = execQuery.or(`client_id.eq.${user.client_id},client_id.is.null`);
  }
  
  if (isUUID(city)) execQuery = execQuery.eq('city', city);
  if (isUUID(city_id)) {
    const { data: cityData } = await supabaseAdmin.from('cities').select('name').eq('id', city_id).single();
    if (cityData?.name) execQuery = execQuery.eq('city', cityData.name);
  }
  
  if (isUUID(zone_id)) execQuery = execQuery.eq('zone_id', zone_id);
  if (isUUID(fe_id) || isUUID(user_id)) execQuery = execQuery.eq('id', fe_id || user_id);
  const { data: execs, error: execErr } = await execQuery;

  if (execErr) return badRequest(res, execErr.message);

  let attQuery = supabaseAdmin
    .from('attendance')
    .select('user_id, checkin_at, checkout_at, checkin_lat, checkin_lng, checkin_address, total_hours, status, is_regularised')
    .eq('org_id', user.org_id).eq('date', today);
  
  if (isUUID(user.client_id)) attQuery = attQuery.eq('client_id', user.client_id);
  const { data: att } = await attQuery;

  const attMap = new Map((att || []).map((a) => [a.user_id, a]));

  const locations = (execs || []).map((fe: any) => {
    const rec  = attMap.get(fe.id) as any;
    const zone = fe.zones as unknown as { name: string; city: string; meeting_lat: number; meeting_lng: number } | null;
    
    // Logic: 
    // 1. If we have a HEARTBEAT/Live location (within last 24h), use it as primary
    // 2. Otherwise use attendance checkin location as secondary
    // 3. Last fallback is zone meeting point
    const hasLastLoc = fe.last_latitude && fe.last_longitude && fe.last_location_updated_at && (new Date().getTime() - new Date(fe.last_location_updated_at).getTime() < 86400000); // 24h
    
    const lat = hasLastLoc ? fe.last_latitude : (rec?.checkin_lat || zone?.meeting_lat || null);
    const lng = hasLastLoc ? fe.last_longitude : (rec?.checkin_lng || zone?.meeting_lng || null);
    
    return {
      id: fe.id, 
      name: fe.name, 
      employee_id: fe.employee_id,
      role: fe.role,
      battery_percentage: fe.battery_percentage,
      zone_name: zone?.name || null, 
      city: zone?.city || null,
      status: rec ? (rec.checkout_at ? 'checked_out' : (rec.status === 'on_break' ? 'on_break' : 'active')) : 'absent',
      checkin_at: rec?.checkin_at || null, 
      checkout_at: rec?.checkout_at || null,
      lat, 
      lng,
      address: rec?.checkin_address || null,
      total_hours: enrichWithHours(rec)?.total_hours || null,
      is_regularised: rec?.is_regularised || false,
    };
  });

  const active  = locations.filter((l) => l.status === 'active' || l.status === 'on_break').length;
  const out     = locations.filter((l) => l.status === 'checked_out').length;
  const absent  = locations.filter((l) => l.status === 'absent').length;

  return ok(res, {
    date: today,
    summary: { total: locations.length, active, checked_out: out, absent },
    locations,
  });
});

/* ── GET /api/v1/analytics/attendance-today ──────────────── */
export const getAttendanceToday = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { city, city_id, zone_id, fe_id, user_id, date: passedDate } = req.query as Record<string, string>;
  const today = passedDate || isoDate(new Date());

  let execQuery = supabaseAdmin
    .from('users').select('id, name, employee_id, zone_id, zones!zone_id(name)')
    .eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true);
  
  if (isUUID(user.client_id)) {
    execQuery = execQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    execQuery = execQuery.eq('client_id', req.query.client_id as string);
  }
  
  if (isUUID(city)) execQuery = execQuery.eq('city', city);
  if (isUUID(city_id)) {
    const { data: cityData } = await supabaseAdmin.from('cities').select('name').eq('id', city_id).single();
    if (cityData?.name) execQuery = execQuery.eq('city', cityData.name);
  }

  if (isUUID(zone_id)) execQuery = execQuery.eq('zone_id', zone_id);
  if (isUUID(fe_id) || isUUID(user_id)) execQuery = execQuery.eq('id', fe_id || user_id);
  const { data: execs, error: execErr } = await execQuery;

  if (execErr) return badRequest(res, execErr.message);

  let attQuery = supabaseAdmin.from('attendance').select('*').eq('org_id', user.org_id).eq('date', today);
  if (isUUID(user.client_id)) {
    attQuery = attQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    attQuery = attQuery.eq('client_id', req.query.client_id as string);
  }
  const { data: att } = await attQuery;

  const { data: brkData } = await supabaseAdmin
    .from('breaks').select('attendance_id, started_at, ended_at')
    .in('attendance_id', (att || []).map((a) => a.id));

  const attMap = new Map((att || []).map((a) => [a.user_id, a]));
  const brkMap = new Map<string, typeof brkData>();
  (brkData || []).forEach((b) => {
    if (!brkMap.has(b.attendance_id)) brkMap.set(b.attendance_id, []);
    brkMap.get(b.attendance_id)!.push(b);
  });

  const now = new Date().getTime();
  const rows = (execs || []).map((fe) => {
    const rec = attMap.get(fe.id) as any;
    const zone = fe.zones as unknown as { name: string } | null;
    const feBreaks = rec ? (brkMap.get(rec.id) || []) : [];
    let display_status: 'present' | 'absent' | 'regularised' | 'checked_out' | 'on_break' = 'absent';
    
    let total_hours = rec?.total_hours || 0;
    if (rec) {
      if (rec.is_regularised)      display_status = 'regularised';
      else if (rec.checkout_at)    display_status = 'checked_out';
      else if (rec.status === 'on_break') display_status = 'on_break';
      else                        display_status = 'present';

      enrichWithHours(rec);
      total_hours = rec.total_hours || 0;
    }
    return {
      id: fe.id, name: fe.name, employee_id: fe.employee_id,
      zone_name: zone?.name || null, display_status,
      checkin_at: rec?.checkin_at || null, checkout_at: rec?.checkout_at || null,
      total_hours: +total_hours.toFixed(1), working_minutes: rec?.working_minutes || null,
      break_minutes: rec?.break_minutes || null, break_count: feBreaks.length,
      checkin_lat: rec?.checkin_lat || null, checkin_lng: rec?.checkin_lng || null,
      checkin_address: rec?.checkin_address || null, is_regularised: rec?.is_regularised || false,
    };
  });

  const summary = {
    total:       rows.length,
    present:     rows.filter((r) => r.display_status === 'present').length,
    on_break:    rows.filter((r) => r.display_status === 'on_break').length,
    checked_out: rows.filter((r) => r.display_status === 'checked_out').length,
    absent:      rows.filter((r) => r.display_status === 'absent').length,
    regularised: rows.filter((r) => r.display_status === 'regularised').length,
  };

  return ok(res, { date: today, summary, executives: rows });
});

/* ── GET /api/v1/analytics/outlet-coverage ───────────────── */
/* Unique outlets visited (based on FE check-ins + form submissions) */
export const getOutletCoverage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const from  = (req.query.from  as string) || isoDate(new Date());
  const to    = (req.query.to    as string) || isoDate(new Date());

  // Only fetch essential fields for grouping to reduce data transfer & memory usage
  let formsQuery = supabaseAdmin
    .from('form_submissions')
    .select('outlet_name, is_converted, user_id, submitted_at, date, users!user_id(city)')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00`)
    .lte('submitted_at', `${to}T23:59:59`);
  
  if (isUUID(user.client_id)) {
    formsQuery = formsQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    formsQuery = formsQuery.eq('client_id', req.query.client_id as string);
  }
  const { data: forms, error } = await formsQuery;

  if (error) return badRequest(res, error.message);

  // Count unique outlets & check-ins (unique FEs)
  const outletMap = new Map<string, { checkins_set: Set<string>; tff: number; city: string | null }>();
  (forms || []).forEach((f) => {
    const outlet = f.outlet_name || 'Unknown Outlet';
    const u = f.users as unknown as { city?: string } | null;
    const city = u?.city || null;
    if (!outletMap.has(outlet)) outletMap.set(outlet, { checkins_set: new Set(), tff: 0, city });
    const entry = outletMap.get(outlet)!;
    entry.tff++;
    if (f.user_id) entry.checkins_set.add(f.user_id);
  });

  const outlets = Array.from(outletMap.entries())
    .map(([name, d]) => {
      return { 
        name, 
        checkins: d.checkins_set.size, 
        tff: d.tff, 
        tff_rate: 100 // Default in table view for now
      };
    })
    .sort((a, b) => b.tff - a.tff);

  // Summary counts
  const totalEngage = (forms || []).length;
  const totalFEsVisited = new Set((forms || []).map(f => f.user_id)).size;

  return ok(res, {
    from, to,
    summary: { 
      total_outlets: outletMap.size, 
      total_checkins: totalFEsVisited,
      total_tff: totalEngage, // Set TFF to total submissions (32)
      total_engagements: totalEngage,
      tff_rate: 100
    },
    outlets: outlets.slice(0, 50),
    cities: [], // Placeholder if cities breakdown not needed here
  });
});

/* ── GET /api/v1/analytics/dashboard-init ────────────────── */
export const getDashboardInit = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;

  const today = isoDate(toIST(new Date()));
  const sevenDaysAgo = isoDate(new Date(Date.now() - 6 * 86400000));

  // 1. Definition of all queries
  let attInitQuery = supabaseAdmin.from('attendance').select('status, is_regularised, checkout_at').eq('org_id', user.org_id).eq('date', today);
  let execInitQuery = supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true);
  let kpisInitQuery = supabaseAdmin.from('v_daily_kpis').select('*').eq('org_id', user.org_id).eq('date', today);
  let grievanceInitQuery = supabaseAdmin.from('grievances').select('id', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('status', 'submitted');
  let weekSubsInitQuery = supabaseAdmin.from('form_submissions').select('submitted_at').eq('org_id', user.org_id).gte('submitted_at', `${sevenDaysAgo}T00:00:00`);

  // 2. Application of client_id filter
  if (isUUID(user.client_id)) {
    attInitQuery = attInitQuery.eq('client_id', user.client_id);
    execInitQuery = execInitQuery.eq('client_id', user.client_id);
    kpisInitQuery = kpisInitQuery.eq('client_id', user.client_id);
    grievanceInitQuery = grievanceInitQuery.eq('client_id', user.client_id);
    weekSubsInitQuery = weekSubsInitQuery.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    const cid = req.query.client_id as string;
    attInitQuery = attInitQuery.eq('client_id', cid);
    execInitQuery = execInitQuery.eq('client_id', cid);
    kpisInitQuery = kpisInitQuery.eq('client_id', cid);
    grievanceInitQuery = grievanceInitQuery.eq('client_id', cid);
    weekSubsInitQuery = weekSubsInitQuery.eq('client_id', cid);
  }

  // 3. Parallel Execution
  const [attRes, execRes, kpiRes, griRes, weekRes] = await Promise.all([
    attInitQuery,
    execInitQuery,
    kpisInitQuery.maybeSingle(),
    grievanceInitQuery,
    weekSubsInitQuery
  ]);

  const att = attRes.data || [];
  const totalExecs = execRes.count || 0;
  const kpisView = kpiRes.data;
  const openGrievances = griRes.count || 0;
  const weekSubs = weekRes.data || [];

  // 4. Calculations
  const attSummary = {
    total: totalExecs,
    present: att.filter(a => (a.status === 'checked_in' || a.status === 'present') && !a.checkout_at).length,
    on_break: att.filter(a => a.status === 'on_break').length,
    checked_out: att.filter(a => a.checkout_at).length,
    absent: totalExecs - att.length,
    regularised: att.filter(a => a.is_regularised).length,
  };

  const dayMap: Record<string, number> = {};
  for(let i=0; i<7; i++) {
    const d = isoDate(new Date(Date.now() - i * 86400000));
    dayMap[d] = 0;
  }
  weekSubs.forEach(s => {
    const d = isoDate(toIST(new Date(s.submitted_at)));
    if (dayMap[d] !== undefined) dayMap[d]++;
  });

  const weeklyDays = Object.entries(dayMap).map(([date, tff]) => ({
    date,
    label: new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
    short_label: new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }),
    tff
  })).sort((a,b) => a.date.localeCompare(b.date));

  return ok(res, {
    attendance: attSummary,
    kpis: {
      total_tff: weekSubs.filter(s => isoDate(toIST(new Date(s.submitted_at))) === today).length,
      avg_attendance: kpisView?.avg_attendance || Math.round((att.length / (totalExecs || 1)) * 100),
      open_grievances: openGrievances
    },
    weekly: { days: weeklyDays, total_tff: weekSubs.length }
  });
});

/* ── GET /api/v1/analytics/mobile-home ───────────────────── */
export const getMobileHome = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const today = dbToday();
  const appToday = todayDate();
  console.log(`[MobileHome] User ${user.id} fetching home. Date=${today} (App Date: ${appToday})`);

  // 1. Today Attendance Status (Self-Healing Lookup)
  let { data: attRecords, error: attError } = await supabaseAdmin
    .from('attendance')
    .select('*, breaks(*)')
    .eq('user_id', user.id)
    .in('status', ['checked_in', 'on_break', 'on-break'])
    .order('created_at', { ascending: false });

  // Fallback to today specifically if no active session
  if (!attRecords || attRecords.length === 0) {
     const { data: todayRecords } = await supabaseAdmin
       .from('attendance')
       .select('*, breaks(*)')
       .eq('user_id', user.id)
       .eq('date', today)
       .order('created_at', { ascending: false });
     attRecords = todayRecords;
  }

  let attRecord = (attRecords && attRecords.length > 0) ? attRecords[0] : null;

  // SELF-HEALING: If duplicates exist, clean them up in background
  if (attRecords && attRecords.length > 1) {
     console.log(`[MobileHome] Self-Healing: Cleaning ${attRecords.length - 1} duplicates for user ${user.id}`);
     const toKeep = attRecords[0].id;
     const toDelete = attRecords.slice(1).map(r => r.id);
     supabaseAdmin.from('attendance').delete().in('id', toDelete).then(() => {
        console.log(`[MobileHome] Self-Healing Complete: Removed ${toDelete.length} records.`);
     });
  }

  if (attRecord) {
    console.log(`[MobileHome] Found record for user ${user.id}: status=${attRecord.status}, date=${attRecord.date}`);
  }
  
  if (attError) console.log(`[MobileHome] Attendance Error: ${attError.message}`);
  console.log(`[MobileHome] Result: Found=${!!attRecord}, Id=${attRecord?.id}, Status=${attRecord?.status}`);
  
  // 2. Summary Stats
  const istToday = today; // Sync today date
  
  let orgTffQuery = supabaseAdmin.from('form_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${istToday}T00:00:00+05:30`)
    .lte('submitted_at', `${istToday}T23:59:59+05:30`);
    
  if (isUUID(user.client_id)) orgTffQuery = orgTffQuery.eq('client_id', user.client_id);
    
  const { count: orgTffCount } = await orgTffQuery;

  if (attRecord) {
    enrichWithHours(attRecord);
    (attRecord as any).tff_count = orgTffCount || 0;
  }

  // 3. Today's Route Plans & ACTUAL VISITS (Merged)
  const { data: profile } = await supabaseAdmin.from('users').select('email').eq('id', user.id).single();
  const userEmail = profile?.email || user.email;

  const startRange = `${today}T00:00:00.000Z`;
  const endRange   = `${today}T23:59:59.999Z`;

  // Fetch planned activities
  let { data: rawPlans } = await supabaseAdmin
    .from('v_route_plan_daily')
    .select('*')
    .or(`user_id.eq.${user.id}${userEmail ? `,fe_email.ilike.${userEmail}` : ''}`)
    .gte('plan_date', startRange)
    .lte('plan_date', endRange);

  // Fetch actual work performed today
  const { data: actualSubmissions } = await supabaseAdmin
    .from('form_submissions')
    .select('id, outlet_name, outlet_id, submitted_at, activity_id, check_in_at, check_out_at')
    .eq('user_id', user.id)
    .gte('submitted_at', `${today}T00:00:00+05:30`)
    .lte('submitted_at', `${today}T23:59:59+05:30`);

  const visitedOutletNames = new Set((actualSubmissions || []).map(s => (s.outlet_name || '').toLowerCase().trim()));
  const visitedOutletIds   = new Set((actualSubmissions || []).map(s => s.outlet_id).filter(Boolean));

  const plans = (rawPlans || []).filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
  let routePlans = [];
  
  const storeMap: Record<string, any> = {};
  const nameToIdMap: Record<string, string> = {}; // Helper for name-based merging

  // 1. Process Planned Outlets (UUID primary)
  if (plans && plans.length > 0) {
    const planIds = plans.map(p => p.id);
    const { data: outlets } = await supabaseAdmin
      .from('v_route_outlet_detail')
      .select('*')
      .in('route_plan_id', planIds)
      .order('visit_order', { ascending: true });
    
    (outlets || []).forEach(o => {
      const sid = o.store_id || o.outlet_id;
      const sname = (o.store_name || '').toLowerCase().trim();
      
      const isActuallyVisitedByID = sid && visitedOutletIds.has(sid);
      const isActuallyVisitedByName = sname && visitedOutletNames.has(sname);
      const isActuallyVisited = isActuallyVisitedByID || isActuallyVisitedByName;

      if (!storeMap[sid]) {
        storeMap[sid] = { ...o, activities: [], status: isActuallyVisited ? 'visited' : (o.status || 'pending') };
        if (sname) nameToIdMap[sname] = sid; // Link name to UUID for merging
      }
      
      if (o.activity_id) {
        storeMap[sid].activities.push({
          id: o.activity_id,
          name: o.activity_name || "Assigned Task",
          plan_id: o.route_plan_id, // Important for App logic
          status: isActuallyVisited ? 'completed' : (o.status || 'pending')
        });
      }
    });
  }

  // 2. Inject Ad-hoc VISITS with cross-referencing & TIMING
  (actualSubmissions || []).forEach(s => {
    const sid = s.outlet_id;
    const sname = (s.outlet_name || '').toLowerCase().trim();
    
    // Find the master key (UUID preferred)
    const existingKey = (sid && storeMap[sid]) ? sid : (sname ? nameToIdMap[sname] : null);

    if (existingKey) {
      const target = storeMap[existingKey];
      target.status = 'visited';
      
      // Pivot Timing: Use earliest check-in and latest check-out
      if (s.check_in_at && (!target.check_in_at || new Date(s.check_in_at) < new Date(target.check_in_at))) {
        target.check_in_at = s.check_in_at;
      }
      if (s.check_out_at && (!target.check_out_at || new Date(s.check_out_at) > new Date(target.check_out_at))) {
        target.check_out_at = s.check_out_at;
      }

      if (target.activities.length === 0) {
        target.activities.push({ 
          id: s.activity_id || 'adhoc', 
          name: 'Form Submission', 
          status: 'completed' 
        });
      } else {
        target.activities.forEach((a: any) => a.status = 'completed');
      }
    } else if (sid || sname) {
      const key = sid || sname;
      storeMap[key] = {
        store_id: sid,
        store_name: s.outlet_name,
        status: 'visited',
        check_in_at: s.check_in_at,
        check_out_at: s.check_out_at,
        activities: [{ id: s.activity_id || 'adhoc', name: 'Form Submission', status: 'completed' }]
      };
      if (sname && !sid) nameToIdMap[sname] = sname;
    }
  });

  routePlans = [{
    id: "consolidated_daily_plan",
    plan_date: today,
    outlets: Object.values(storeMap)
  }];

  // 4. Notifications (Unread count)
  const { count: unread } = await supabaseAdmin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('is_read', false);

  // 5. Quote
  const { data: quote } = await supabaseAdmin.from('motivation_quotes').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();

  // 6. Broadcast (New System: Active & Assigned)
  const { data: bq } = await supabaseAdmin
    .from('broadcast_questions')
    .select(`
      id, question, options, correct_option, is_urgent, deadline_at,
      status, target_roles, target_zone_ids, target_cities, created_at,
      broadcast_answers!left(id, selected, is_correct, answered_at)
    `)
    .eq('org_id', user.org_id)
    .eq('status', 'active')
    .contains('target_roles', [user.role])
    .eq('broadcast_answers.user_id', user.id)
    .order('is_urgent', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const b = bq as any;
  const alreadyAnswered = Array.isArray(b?.broadcast_answers) && b.broadcast_answers.length > 0;

  // 7. Explicit mapping for Android stability
  const todayMapped = attRecord ? {
    id: attRecord.id,
    date: formatAppDate(attRecord.date),
    status: attRecord.status,
    checkin_at: attRecord.checkin_at,
    checkout_at: attRecord.checkout_at,
    total_hours: attRecord.total_hours,
    working_minutes: attRecord.working_minutes,
    checkin_lat: attRecord.checkin_lat,
    checkin_lng: attRecord.checkin_lng,
    checkin_selfie_url: attRecord.checkin_selfie_url,
    checkout_selfie_url: attRecord.checkout_selfie_url,
    breaks: attRecord.breaks || []
  } : null;

  return ok(res, {
    today: todayMapped,
    summary: { tff_count: orgTffCount || 0 },
    routePlan: routePlans,
    unreadCount: unread || 0,
    quote: quote || null,
    broadcast: b ? { 
      id: b.id, 
      question: b.question, 
      is_urgent: b.is_urgent,
      already_answered: alreadyAnswered,
      options: b.options,
      deadline_at: b.deadline_at
    } : null,
    timestamp: new Date().toISOString()
  });
});

/* ── GET /api/v1/analytics/city-performance ─────────────── */
/* Zone+city-wise KPIs for date range */
export const getCityPerformance = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const from = (req.query.from as string) || isoDate(toIST(new Date()));
  const to   = (req.query.to   as string) || isoDate(toIST(new Date()));

  // Fetch zones with city info
  let zonesPerfQuery = supabaseAdmin.from('zones').select('id, name, city, meeting_lat, meeting_lng').eq('org_id', user.org_id);
  if (isUUID(user.client_id)) zonesPerfQuery = zonesPerfQuery.eq('client_id', user.client_id);
  const { data: zones } = await zonesPerfQuery;

  // Fetch executives per zone
  let execsPerfQuery = supabaseAdmin.from('users').select('id, name, zone_id').eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true);
  if (isUUID(user.client_id)) execsPerfQuery = execsPerfQuery.eq('client_id', user.client_id);
  const { data: execs } = await execsPerfQuery;

  // Fetch attendance in range
  let attPerfQuery = supabaseAdmin.from('attendance').select('user_id, zone_id, date, total_hours, checkin_at').eq('org_id', user.org_id).gte('date', from).lte('date', to);
  if (isUUID(user.client_id)) attPerfQuery = attPerfQuery.eq('client_id', user.client_id);
  const { data: att } = await attPerfQuery;

  // Fetch form submissions in range
  let formsPerfQuery = supabaseAdmin.from('form_submissions').select('user_id, is_converted, outlet_name, submitted_at').eq('org_id', user.org_id).gte('submitted_at', `${from}T00:00:00`).lte('submitted_at', `${to}T23:59:59`);
  if (isUUID(user.client_id)) formsPerfQuery = formsPerfQuery.eq('client_id', user.client_id);
  const { data: forms } = await formsPerfQuery;

  // Build exec→zone map
  const execZoneMap = new Map((execs || []).map((e) => [e.id, e.zone_id]));

  // Aggregate by city
  const cityAgg = new Map<string, {
    zones: Set<string>; fes: Set<string>; checkins: number;
    total_hours: number; engagements: number; tff: number; outlets: Set<string>;
    lat: number | null; lng: number | null;
  }>();

  const zoneToCity = new Map<string, { city: string; lat: number | null; lng: number | null }>((zones || []).map((z: any) => [z.id, { city: z.city, lat: z.meeting_lat, lng: z.meeting_lng }]));

  // Aggregate attendance
  (att || []).forEach((a) => {
    const zInfo = zoneToCity.get(a.zone_id || '');
    const city = zInfo?.city || 'Unknown';
    if (!cityAgg.has(city)) cityAgg.set(city, { zones: new Set(), fes: new Set(), checkins: 0, total_hours: 0, engagements: 0, tff: 0, outlets: new Set(), lat: zInfo?.lat || null, lng: zInfo?.lng || null });
    const c = cityAgg.get(city)!;
    c.fes.add(a.user_id); c.checkins++;
    c.total_hours += a.total_hours || 0;
    if (a.zone_id) c.zones.add(a.zone_id);
  });

  // Aggregate forms
  (forms || []).forEach((f: any) => {
    const zoneId = execZoneMap.get(f.user_id || '') || '';
    const zInfo  = zoneToCity.get(zoneId);
    const city   = zInfo?.city || 'Unknown';
    if (!cityAgg.has(city)) cityAgg.set(city, { zones: new Set(), fes: new Set(), checkins: 0, total_hours: 0, engagements: 0, tff: 0, outlets: new Set(), lat: zInfo?.lat || null, lng: zInfo?.lng || null });
    const c = cityAgg.get(city)!;
    c.engagements++; if (f.is_converted) c.tff++;
    if (f.outlet_name) c.outlets.add(f.outlet_name);
  });

  const result = Array.from(cityAgg.entries()).map(([city, d]) => ({
    city, zones: d.zones.size, active_fes: d.fes.size, checkins: d.checkins,
    engagements: d.engagements, tff: d.engagements, // User: TFF = Total Form Filled
    tff_rate: 100, // or other calculation if needed
    unique_outlets: d.outlets.size,
    avg_hours: d.fes.size > 0 ? +(d.total_hours / d.fes.size).toFixed(1) : 0,
    lat: d.lat, lng: d.lng,
  })).sort((a, b) => b.engagements - a.engagements);

  return ok(res, { from, to, cities: result });
});
