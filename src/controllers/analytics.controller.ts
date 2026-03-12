import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

// existing exports above ...

// GET /api/v1/analytics/contact-heatmap  — last 7 days contact density by day & hour
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
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        count: 0,
      })),
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
    if (totalForHour > peakHourCount) {
      peakHour = hour;
      peakHourCount = totalForHour;
    }
  }

  let peakDay = rows[0]?.day || '';
  let peakDayCount = rows[0]?.total || 0;

  for (const row of rows) {
    if (row.total > peakDayCount) {
      peakDay = row.day;
      peakDayCount = row.total;
    }
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
