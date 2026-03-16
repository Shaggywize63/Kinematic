import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const ORG = '00000000-0000-0000-0000-000000000001';

const dateRange = (period: string) => {
  const now = new Date();
  const from = new Date();
  if (period === 'today') from.setHours(0, 0, 0, 0);
  else if (period === 'week') from.setDate(now.getDate() - 7);
  else if (period === 'month') from.setDate(now.getDate() - 30);
  else from.setDate(now.getDate() - 7);
  return { from: from.toISOString(), to: now.toISOString() };
};

export const getSummary = async (req: Request, res: Response) => {
  try {
    const { period = 'week' } = req.query;
    const { from, to } = dateRange(period as string);

    const [subRes, attRes, userRes] = await Promise.all([
      supabaseAdmin.from('form_submissions')
        .select('submitted_at, is_converted')
        .eq('org_id', ORG)
        .gte('submitted_at', from)
        .lte('submitted_at', to),
      supabaseAdmin.from('attendance')
        .select('user_id, date, total_hours, checkin_at')
        .eq('org_id', ORG)
        .gte('date', from.split('T')[0])
        .lte('date', to.split('T')[0]),
      supabaseAdmin.from('users')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', ORG)
        .eq('role', 'executive')
        .eq('is_active', true),
    ]);

    const submissions = subRes.data || [];
    const attendance = attRes.data || [];
    const converted = submissions.filter((s: any) => s.is_converted).length;

    return res.json({
      success: true,
      data: {
        total_contacts: submissions.length,
        effective_contacts: converted,
        conversion_rate: submissions.length > 0 ? Math.round((converted / submissions.length) * 100) : 0,
        total_executives: userRes.count || 0,
        days_with_attendance: new Set(attendance.map((a: any) => a.date)).size,
        avg_hours: attendance.length > 0
          ? +(attendance.reduce((acc: number, a: any) => acc + (a.total_hours || 0), 0) / attendance.length).toFixed(1)
          : 0,
        period,
        from,
        to,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getActivityFeed = async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('form_submissions')
      .select('id, outlet_name, is_converted, submitted_at, user:user_id(name, zone_id, zones(name, city))')
      .eq('org_id', ORG)
      .order('submitted_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getHourly = async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin
      .from('form_submissions')
      .select('submitted_at')
      .eq('org_id', ORG)
      .gte('submitted_at', today + 'T00:00:00')
      .lte('submitted_at', today + 'T23:59:59');
    if (error) throw error;
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    (data || []).forEach((s: any) => { hourly[new Date(s.submitted_at).getHours()].count++; });
    return res.json({ success: true, data: hourly });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getContactHeatmap = async (_req: Request, res: Response) => {
  try {
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const { data, error } = await supabaseAdmin
      .from('form_submissions')
      .select('submitted_at, is_converted')
      .eq('org_id', ORG)
      .gte('submitted_at', from.toISOString());
    if (error) throw error;
    const map: Record<string, { total: number; converted: number }> = {};
    (data || []).forEach((s: any) => {
      const day = s.submitted_at.split('T')[0];
      if (!map[day]) map[day] = { total: 0, converted: 0 };
      map[day].total++;
      if (s.is_converted) map[day].converted++;
    });
    return res.json({ success: true, data: map });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getWeeklyContacts = async (req: Request, res: Response) => {
  try {
    const fromDate = (req.query.from as string) || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const toDate = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin
      .from('form_submissions')
      .select('submitted_at, is_converted, outlet_name, user_id, users(name, zones(name, city))')
      .eq('org_id', ORG)
      .gte('submitted_at', fromDate + 'T00:00:00')
      .lte('submitted_at', toDate + 'T23:59:59');
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getLiveLocations = async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin
      .from('attendance')
      .select('user_id, checkin_at, checkin_lat, checkin_lng, checkin_address, total_hours, status, is_regularised')
      .eq('org_id', ORG)
      .eq('date', today);
    if (error) throw error;
    const userIds = (data || []).map((a: any) => a.user_id);
    let users: any[] = [];
    if (userIds.length > 0) {
      const { data: ud } = await supabaseAdmin
        .from('users')
        .select('id, name, employee_id, zone_id, zones(name, city, meeting_lat, meeting_lng)')
        .in('id', userIds);
      users = ud || [];
    }
    const userMap: Record<string, any> = {};
    users.forEach((u: any) => { userMap[u.id] = u; });
    return res.json({ success: true, data: (data || []).map((a: any) => ({ ...a, user: userMap[a.user_id] || null })) });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getAttendanceToday = async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin
      .from('attendance').select('*').eq('org_id', ORG).eq('date', today);
    if (error) throw error;
    return res.json({
      success: true,
      data: {
        present: (data || []).filter((a: any) => a.status === 'present').length,
        absent: (data || []).filter((a: any) => a.status === 'absent').length,
        late: (data || []).filter((a: any) => a.status === 'late').length,
        total: (data || []).length,
      },
      records: data || [],
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getOutletCoverage = async (req: Request, res: Response) => {
  try {
    const fromDate = (req.query.from as string) || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const toDate = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin
      .from('form_submissions')
      .select('outlet_name, is_converted')
      .eq('org_id', ORG)
      .gte('submitted_at', fromDate + 'T00:00:00')
      .lte('submitted_at', toDate + 'T23:59:59');
    if (error) throw error;
    const outlets: Record<string, { visits: number; converted: number }> = {};
    (data || []).forEach((s: any) => {
      const name = s.outlet_name || 'Unknown';
      if (!outlets[name]) outlets[name] = { visits: 0, converted: 0 };
      outlets[name].visits++;
      if (s.is_converted) outlets[name].converted++;
    });
    return res.json({ success: true, data: outlets });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getCityPerformance = async (req: Request, res: Response) => {
  try {
    const fromDate = (req.query.from as string) || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const toDate = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin
      .from('form_submissions')
      .select('is_converted, users(zones(city))')
      .eq('org_id', ORG)
      .gte('submitted_at', fromDate + 'T00:00:00')
      .lte('submitted_at', toDate + 'T23:59:59');
    if (error) throw error;
    const cities: Record<string, { total: number; converted: number }> = {};
    (data || []).forEach((s: any) => {
      const city = (s.users as any)?.zones?.city || 'Unknown';
      if (!cities[city]) cities[city] = { total: 0, converted: 0 };
      cities[city].total++;
      if (s.is_converted) cities[city].converted++;
    });
    return res.json({ success: true, data: cities });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
