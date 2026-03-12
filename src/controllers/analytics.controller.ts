import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

// GET /api/v1/analytics/summary
export const getSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  const { data: kpis } = await supabaseAdmin
    .from('v_daily_kpis')
    .select('*')
    .eq('org_id', user.org_id)
    .eq('date', date)
    .single();

  const { count: totalExecs } = await supabaseAdmin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id)
    .eq('role', 'executive')
    .eq('is_active', true);

  const { count: activeSos } = await supabaseAdmin
    .from('sos_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id)
    .eq('status', 'active');

  const { count: openGrievances } = await supabaseAdmin
    .from('grievances')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id)
    .eq('status', 'submitted');

  return ok(res, {
    date,
    kpis: kpis || {
      executives_active: 0,
      executives_submitted: 0,
      total_engagements: 0,
      total_conversions: 0,
      avg_hours_worked: 0,
    },
    total_executives: totalExecs || 0,
    active_sos_alerts: activeSos || 0,
    open_grievances: openGrievances || 0,
  });
});

// GET /api/v1/analytics/activity-feed
export const getActivityFeed = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const limit = Math.min(50, parseInt((req.query.limit as string) || '20', 10));

  const { data: submissions } = await supabaseAdmin
    .from('form_submissions')
    .select('id, submitted_at, is_converted, outlet_name, users(name), activities(name)')
    .eq('org_id', user.org_id)
    .order('submitted_at', { ascending: false })
    .limit(limit);

  const { data: checkins } = await supabaseAdmin
    .from('attendance')
    .select('id, checkin_at, users(name), zones(name)')
    .eq('org_id', user.org_id)
    .not('checkin_at', 'is', null)
    .order('checkin_at', { ascending: false })
    .limit(limit);

  const feed = [
    ...(submissions || []).map((s) => ({
      id: s.id,
      type: 'form_submission' as const,
      time: s.submitted_at,
      description: `${(s.users as { name: string })?.name} submitted form${
        s.is_converted ? ' ✓ Converted' : ''
      }`,
      meta: { activity: (s.activities as { name: string })?.name, outlet: s.outlet_name },
    })),
    ...(checkins || []).map((c) => ({
      id: c.id,
      type: 'check_in' as const,
      time: c.checkin_at,
      description: `${(c.users as { name: string })?.name} checked in at ${
        (c.zones as { name: string })?.name || 'Unknown zone'
      }`,
      meta: {},
    })),
  ]
    .sort((a, b) => new Date(b.time!).getTime() - new Date(a.time!).getTime())
    .slice(0, limit);

  return ok(res, feed);
});

// GET /api/v1/analytics/hourly
export const getHourly = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('submitted_at, is_converted')
    .eq('org_id', user.org_id)
    .gte('submitted_at', `${date}T00:00:00`)
    .lte('submitted_at', `${date}T23:59:59`);

  if (error) return badRequest(res, error.message);

  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: `${h.toString().padStart(2, '0')}:00`,
    engagements: 0,
    conversions: 0,
  }));

  (data || []).forEach((s) => {
    const h = new Date(s.submitted_at).getHours();
    hourly[h].engagements++;
    if (s.is_converted) hourly[h].conversions++;
  });

  return ok(res, hourly.filter((h) => h.engagements > 0 || (h.hour >= 8 && h.hour <= 20)));
});

// GET /api/v1/analytics/contact-heatmap
export const getContactHeatmap = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  const days = Math.min(30, Math.max(1, parseInt((req.query.days as string) || '7', 10)));
  const end = new Date();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));

  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('submitted_at')
    .eq('org_id', user.org_id)
    .gte('submitted_at', start.toISOString())
    .lte('submitted_at', end.toISOString())
    .order('submitted_at', { ascending: true });

  if (error) return badRequest(res, error.message);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const rows = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return {
      date: d.toISOString().split('T')[0],
      day: dayNames[d.getDay()],
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
      total: 0,
    };
  });

  const rowMap = new Map(rows.map((row) => [row.date, row]));

  for (const item of data || []) {
    if (!item.submitted_at) continue;
    const dt = new Date(item.submitted_at);
    const dateKey = dt.toISOString().split('T')[0];
    const hour = dt.getHours();
    const row = rowMap.get(dateKey);
    if (!row) continue;
    row.hours[hour].count += 1;
    row.total += 1;
  }

  let peakHour = 0;
  let peakHourCount = 0;
  for (let hour = 0; hour < 24; hour++) {
    const totalForHour = rows.reduce((sum, row) => sum + row.hours[hour].count, 0);
    if (totalForHour > peakHourCount) { peakHour = hour; peakHourCount = totalForHour; }
  }

  let peakDay = rows[0]?.day || '';
  let peakDayCount = rows[0]?.total || 0;
  for (const row of rows) {
    if (row.total > peakDayCount) { peakDay = row.day; peakDayCount = row.total; }
  }

  const totalContacts = rows.reduce((sum, row) => sum + row.total, 0);

  return ok(res, {
    days,
    start_date: rows[0]?.date || null,
    end_date: rows[rows.length - 1]?.date || null,
    rows,
    summary: {
      peak_hour: `${peakHour.toString().padStart(2, '0')}:00`,
      peak_hour_count: peakHourCount,
      peak_day: peakDay,
      peak_day_count: peakDayCount,
      total_contacts: totalContacts,
    },
  });
});
