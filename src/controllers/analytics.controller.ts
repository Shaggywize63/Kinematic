import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

// GET /api/v1/analytics/summary  — dashboard overview KPIs
export const getSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  const { data: kpis, error } = await supabaseAdmin
    .from('v_daily_kpis')
    .select('*')
    .eq('org_id', user.org_id)
    .eq('date', date)
    .single();

  // Total executives in org
  const { count: totalExecs } = await supabaseAdmin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id)
    .eq('role', 'executive')
    .eq('is_active', true);

  // Active SOS alerts
  const { count: activeSos } = await supabaseAdmin
    .from('sos_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', user.org_id)
    .eq('status', 'active');

  // Unread grievances
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

// GET /api/v1/analytics/activity-feed  — latest field events
export const getActivityFeed = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));

  // Recent form submissions
  const { data: submissions } = await supabaseAdmin
    .from('form_submissions')
    .select('id, submitted_at, is_converted, outlet_name, users(name), activities(name)')
    .eq('org_id', user.org_id)
    .order('submitted_at', { ascending: false })
    .limit(limit);

  // Recent check-ins
  const { data: checkins } = await supabaseAdmin
    .from('attendance')
    .select('id, checkin_at, users(name), zones(name)')
    .eq('org_id', user.org_id)
    .not('checkin_at', 'is', null)
    .order('checkin_at', { ascending: false })
    .limit(limit);

  // Merge and sort by time
  const feed = [
    ...(submissions || []).map((s) => ({
      id: s.id,
      type: 'form_submission' as const,
      time: s.submitted_at,
      description: `${(s.users as { name: string })?.name} submitted form${s.is_converted ? ' ✓ Converted' : ''}`,
      meta: { activity: (s.activities as { name: string })?.name, outlet: s.outlet_name },
    })),
    ...(checkins || []).map((c) => ({
      id: c.id,
      type: 'check_in' as const,
      time: c.checkin_at,
      description: `${(c.users as { name: string })?.name} checked in at ${(c.zones as { name: string })?.name || 'Unknown zone'}`,
      meta: {},
    })),
  ]
    .sort((a, b) => new Date(b.time!).getTime() - new Date(a.time!).getTime())
    .slice(0, limit);

  return ok(res, feed);
});

// GET /api/v1/analytics/hourly  — conversions by hour for bar chart
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

  return ok(res, hourly.filter((h) => h.engagements > 0 || h.hour >= 8 && h.hour <= 20));
});
