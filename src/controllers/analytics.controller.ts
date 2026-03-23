import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const toIST = (utcDate: Date): Date =>
  new Date(utcDate.getTime() + 5.5 * 60 * 60 * 1000);

const isoDate = (d: Date) => d.toISOString().split('T')[0];

/* ── GET /api/v1/analytics/summary ───────────────────────── */
export const getSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || isoDate(new Date());

  const { data: kpis } = await supabaseAdmin
    .from('v_daily_kpis').select('*')
    .eq('org_id', user.org_id).eq('date', date).single();

  const { count: totalExecs } = await supabaseAdmin
    .from('users').select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true);

  const { count: activeSos } = await supabaseAdmin
    .from('sos_alerts').select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id).eq('status', 'active');

  const { count: openGrievances } = await supabaseAdmin
    .from('grievances').select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id).eq('status', 'submitted');

  // New Metrics: Days Worked & Leaves (Last 30 days)
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const { data: attStats } = await supabaseAdmin
    .from('attendance')
    .select('status, user_id')
    .eq('org_id', user.org_id)
    .gte('date', isoDate(thirtyDaysAgo));

  const totalDaysWorked = (attStats || []).filter(a => a.status === 'present' || a.status === 'checked_out').length;
  // Approximation of leaves: if we assumed everyone worked every day, this would be complex.
  // For now, let's treat any attendance record with status 'absent' as a leave.
  const totalLeaves = (attStats || []).filter(a => a.status === 'absent').length;

  return ok(res, {
    date,
    kpis: kpis || {
      executives_active: 0, executives_submitted: 0,
      total_engagements: 0, total_tff: 0, avg_hours_worked: 0,
    },
    total_executives: totalExecs || 0,
    active_sos_alerts: activeSos || 0,
    open_grievances: openGrievances || 0,
    total_days_worked: totalDaysWorked || 0,
    total_leaves: totalLeaves || 0,
  });
});

/* ── GET /api/v1/analytics/tff-trends ─────────────────────── */
export const getTffTrends = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const from = (req.query.from as string) || isoDate(new Date(Date.now() - 7 * 86400000));
  const to   = (req.query.to   as string) || isoDate(new Date());

  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('submitted_at, is_converted')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00`)
    .lte('submitted_at', `${to}T23:59:59`);

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
    tff: byDay[d].tff,
    engagements: byDay[d].engagements,
    label: new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  }));

  return ok(res, trend);
});

/* ── GET /api/v1/analytics/activity-feed ─────────────────── */
export const getActivityFeed = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));

  const { data: submissions } = await supabaseAdmin
    .from('form_submissions')
    .select('id, submitted_at, is_converted, outlet_name, users(name), activities(name)')
    .eq('org_id', user.org_id)
    .order('submitted_at', { ascending: false }).limit(limit);

  const { data: checkins } = await supabaseAdmin
    .from('attendance')
    .select('id, checkin_at, users(name), zones(name)')
    .eq('org_id', user.org_id)
    .not('checkin_at', 'is', null)
    .order('checkin_at', { ascending: false }).limit(limit);

  const feed = [
    ...(submissions || []).map((s) => {
      const u = s.users as unknown as { name: string } | null;
      const a = s.activities as unknown as { name: string } | null;
      return { id: s.id, type: 'form_submission' as const, time: s.submitted_at,
        description: `${u?.name || 'Unknown'} submitted form${s.is_converted ? ' ✓ TFF' : ''}`,
        meta: { activity: a?.name, outlet: s.outlet_name } };
    }),
    ...(checkins || []).map((c) => {
      const u = c.users as unknown as { name: string } | null;
      const z = c.zones as unknown as { name: string } | null;
      return { id: c.id, type: 'check_in' as const, time: c.checkin_at,
        description: `${u?.name || 'Unknown'} checked in at ${z?.name || 'Unknown zone'}`,
        meta: {} };
    }),
  ].sort((a, b) => new Date(b.time!).getTime() - new Date(a.time!).getTime()).slice(0, limit);

  return ok(res, feed);
});

/* ── GET /api/v1/analytics/hourly ────────────────────────── */
export const getHourly = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || isoDate(new Date());

  const { data, error } = await supabaseAdmin
    .from('form_submissions').select('submitted_at, is_converted')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${date}T00:00:00`).lte('submitted_at', `${date}T23:59:59`);

  if (error) return badRequest(res, error.message);

  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${h.toString().padStart(2,'0')}:00`, engagements: 0, tff: 0 }));
  (data || []).forEach((s) => { const h = new Date(s.submitted_at).getHours(); hourly[h].engagements++; if (s.is_converted) hourly[h].tff++; });
  return ok(res, hourly.filter((h) => h.engagements > 0 || (h.hour >= 8 && h.hour <= 20)));
});

/* ── GET /api/v1/analytics/contact-heatmap ───────────────── */
export const getContactHeatmap = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const since = new Date(); since.setDate(since.getDate() - 6); since.setHours(0,0,0,0);

  const { data, error } = await supabaseAdmin
    .from('form_submissions').select('submitted_at, is_converted')
    .eq('org_id', user.org_id).gte('submitted_at', since.toISOString());

  if (error) return badRequest(res, error.message);

  const grid: { engagements: number; tff: number }[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ engagements: 0, tff: 0 })));
  (data || []).forEach((s) => {
    const ist = toIST(new Date(s.submitted_at));
    const dow = (ist.getDay() + 6) % 7;
    const hr  = ist.getHours();
    grid[dow][hr].engagements++;
    if (s.is_converted) grid[dow][hr].tff++;
  });

  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return ok(res, {
    since: since.toISOString(), total_records: data?.length || 0,
    grid: grid.map((hours, d) => ({ day: days[d], day_index: d, hours: hours.map((cell, h) => ({ hour: h, ...cell, total: cell.engagements })) })),
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

  // Build date range array
  const start = new Date(from + 'T00:00:00'); const end = new Date(to + 'T23:59:59');
  const days: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(isoDate(new Date(d)));

  const { data, error } = await supabaseAdmin
    .from('form_submissions').select('submitted_at, is_converted')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00`).lte('submitted_at', `${to}T23:59:59`);

  if (error) return badRequest(res, error.message);

  const byDay: Record<string, { engagements: number; tff: number }> = {};
  days.forEach((d) => { byDay[d] = { engagements: 0, tff: 0 }; });
  (data || []).forEach((s) => {
    const d = isoDate(toIST(new Date(s.submitted_at)));
    if (byDay[d]) { byDay[d].engagements++; if (s.is_converted) byDay[d].tff++; }
  });

  const result = days.map((d) => ({
    date: d,
    label: new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
    short_label: new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }),
    engagements: byDay[d].engagements, tff: byDay[d].tff,
    tff_rate: byDay[d].engagements > 0 ? Math.round((byDay[d].tff / byDay[d].engagements) * 100) : 0,
  }));

  return ok(res, {
    days: result,
    total_engagements: result.reduce((s, d) => s + d.engagements, 0),
    total_tff: result.reduce((s, d) => s + d.tff, 0),
  });
});

/* ── GET /api/v1/analytics/live-locations ────────────────── */
export const getLiveLocations = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = isoDate(new Date());

  const { data: execs, error: execErr } = await supabaseAdmin
    .from('users').select('id, name, employee_id, zone_id, zones(name, city, meeting_lat, meeting_lng)')
    .eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true);

  if (execErr) return badRequest(res, execErr.message);

  const { data: att } = await supabaseAdmin
    .from('attendance')
    .select('user_id, checkin_at, checkout_at, checkin_lat, checkin_lng, checkin_address, total_hours, status, is_regularised')
    .eq('org_id', user.org_id).eq('date', today);

  const attMap = new Map((att || []).map((a) => [a.user_id, a]));

  const locations = (execs || []).map((fe) => {
    const rec  = attMap.get(fe.id);
    const zone = fe.zones as unknown as { name: string; city: string; meeting_lat: number; meeting_lng: number } | null;
    // Fall back to zone's meeting point if no GPS on FE
    const lat = rec?.checkin_lat || zone?.meeting_lat || null;
    const lng = rec?.checkin_lng || zone?.meeting_lng || null;
    return {
      id: fe.id, name: fe.name, employee_id: fe.employee_id,
      zone_name: zone?.name || null, city: zone?.city || null,
      status: rec ? (rec.checkout_at ? 'checked_out' : 'active') : 'absent',
      checkin_at: rec?.checkin_at || null, checkout_at: rec?.checkout_at || null,
      lat, lng,
      address:      rec?.checkin_address || null,
      total_hours:  rec?.total_hours || null,
      is_regularised: rec?.is_regularised || false,
    };
  });

  const active  = locations.filter((l) => l.status === 'active').length;
  const out     = locations.filter((l) => l.status === 'checked_out').length;
  const absent  = locations.filter((l) => l.status === 'absent').length;

  return ok(res, {
    date: today,
    summary: { total: locations.length, active, checked_out: out, absent },
    locations,
  });
});

/* ── GET /api/v1/analytics/attendance-today ──────────────── */
export const getAttendanceToday = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = isoDate(new Date());

  const { data: execs, error: execErr } = await supabaseAdmin
    .from('users').select('id, name, employee_id, zone_id, zones(name)')
    .eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true);

  if (execErr) return badRequest(res, execErr.message);

  const { data: att } = await supabaseAdmin.from('attendance').select('*').eq('org_id', user.org_id).eq('date', today);

  const { data: brkData } = await supabaseAdmin
    .from('breaks').select('attendance_id, started_at, ended_at')
    .in('attendance_id', (att || []).map((a) => a.id));

  const attMap = new Map((att || []).map((a) => [a.user_id, a]));
  const brkMap = new Map<string, typeof brkData>();
  (brkData || []).forEach((b) => {
    if (!brkMap.has(b.attendance_id)) brkMap.set(b.attendance_id, []);
    brkMap.get(b.attendance_id)!.push(b);
  });

  const rows = (execs || []).map((fe) => {
    const rec = attMap.get(fe.id);
    const zone = fe.zones as unknown as { name: string } | null;
    const feBreaks = rec ? (brkMap.get(rec.id) || []) : [];
    let display_status: 'present' | 'absent' | 'regularised' | 'checked_out' | 'on_break' = 'absent';
    if (rec) {
      if (rec.is_regularised)      display_status = 'regularised';
      else if (rec.checkout_at)    display_status = 'checked_out';
      else if (rec.status === 'on_break') display_status = 'on_break';
      else                         display_status = 'present';
    }
    return {
      id: fe.id, name: fe.name, employee_id: fe.employee_id,
      zone_name: zone?.name || null, display_status,
      checkin_at: rec?.checkin_at || null, checkout_at: rec?.checkout_at || null,
      total_hours: rec?.total_hours || null, working_minutes: rec?.working_minutes || null,
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

  // All unique outlets from form_submissions in range
  const { data: forms, error } = await supabaseAdmin
    .from('form_submissions')
    .select('outlet_name, is_converted, user_id, submitted_at, users(name, zones(name, city))')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00`)
    .lte('submitted_at', `${to}T23:59:59`);

  if (error) return badRequest(res, error.message);

  // Count unique outlets & conversions
  const outletMap = new Map<string, { visits: number; conversions: number; city: string | null }>();
  (forms || []).forEach((f) => {
    const outlet = f.outlet_name || 'Unknown Outlet';
    const u = f.users as unknown as { zones?: { city?: string } } | null;
    const city = u?.zones?.city || null;
    if (!outletMap.has(outlet)) outletMap.set(outlet, { visits: 0, conversions: 0, city });
    const entry = outletMap.get(outlet)!;
    entry.visits++;
    if (f.is_converted) entry.conversions++;
  });

  const outlets = Array.from(outletMap.entries())
    .map(([name, d]) => ({ name, ...d, tff_rate: d.visits > 0 ? Math.round((d.conversions / d.visits) * 100) : 0 }))
    .sort((a, b) => b.visits - a.visits);

  // City breakdown
  const cityMap = new Map<string, { outlets: Set<string>; engagements: number; tff: number }>();
  (forms || []).forEach((f) => {
    const u = f.users as unknown as { zones?: { city?: string } } | null;
    const city = u?.zones?.city || 'Unknown';
    if (!cityMap.has(city)) cityMap.set(city, { outlets: new Set(), engagements: 0, tff: 0 });
    const c = cityMap.get(city)!;
    if (f.outlet_name) c.outlets.add(f.outlet_name);
    c.engagements++;
    if (f.is_converted) c.tff++;
  });

  const cities = Array.from(cityMap.entries())
    .map(([name, d]) => ({
      city: name, unique_outlets: d.outlets.size, engagements: d.engagements, tff: d.tff,
      tff_rate: d.engagements > 0 ? Math.round((d.tff / d.engagements) * 100) : 0,
    }))
    .sort((a, b) => b.engagements - a.engagements);

  return ok(res, {
    from, to,
    summary: { total_outlets: outletMap.size, total_visits: forms?.length || 0 },
    outlets: outlets.slice(0, 50),
    cities,
  });
});

/* ── GET /api/v1/analytics/city-performance ─────────────── */
/* Zone+city-wise KPIs for date range */
export const getCityPerformance = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const from = (req.query.from as string) || isoDate(new Date());
  const to   = (req.query.to   as string) || isoDate(new Date());

  // Fetch zones with city info
  const { data: zones } = await supabaseAdmin
    .from('zones').select('id, name, city, meeting_lat, meeting_lng').eq('org_id', user.org_id);

  // Fetch executives per zone
  const { data: execs } = await supabaseAdmin
    .from('users').select('id, name, zone_id').eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true);

  // Fetch attendance in range
  const { data: att } = await supabaseAdmin
    .from('attendance').select('user_id, zone_id, date, total_hours, checkin_at')
    .eq('org_id', user.org_id)
    .gte('date', from).lte('date', to);

  // Fetch form submissions in range
  const { data: forms } = await supabaseAdmin
    .from('form_submissions').select('user_id, is_converted, outlet_name, submitted_at')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${from}T00:00:00`).lte('submitted_at', `${to}T23:59:59`);

  // Build exec→zone map
  const execZoneMap = new Map((execs || []).map((e) => [e.id, e.zone_id]));

  // Aggregate by city
  const cityAgg = new Map<string, {
    zones: Set<string>; fes: Set<string>; checkins: number;
    total_hours: number; engagements: number; tff: number; outlets: Set<string>;
    lat: number | null; lng: number | null;
  }>();

  const zoneToCity = new Map((zones || []).map((z) => [z.id, { city: z.city, lat: z.meeting_lat, lng: z.meeting_lng }]));

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
  (forms || []).forEach((f) => {
    const zoneId = execZoneMap.get(f.user_id) || '';
    const zInfo  = zoneToCity.get(zoneId);
    const city   = zInfo?.city || 'Unknown';
    if (!cityAgg.has(city)) cityAgg.set(city, { zones: new Set(), fes: new Set(), checkins: 0, total_hours: 0, engagements: 0, tff: 0, outlets: new Set(), lat: zInfo?.lat || null, lng: zInfo?.lng || null });
    const c = cityAgg.get(city)!;
    c.engagements++; if (f.is_converted) c.tff++;
    if (f.outlet_name) c.outlets.add(f.outlet_name);
  });

  const result = Array.from(cityAgg.entries()).map(([city, d]) => ({
    city, zones: d.zones.size, active_fes: d.fes.size, checkins: d.checkins,
    engagements: d.engagements, tff: d.tff, tff_rate: d.engagements > 0 ? Math.round((d.tff / d.engagements) * 100) : 0,
    unique_outlets: d.outlets.size,
    avg_hours: d.fes.size > 0 ? +(d.total_hours / d.fes.size).toFixed(1) : 0,
    lat: d.lat, lng: d.lng,
  })).sort((a, b) => b.engagements - a.engagements);

  return ok(res, { from, to, cities: result });
});
