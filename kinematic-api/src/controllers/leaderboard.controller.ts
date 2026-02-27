import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

// GET /api/v1/leaderboard?period=weekly&limit=20
export const getLeaderboard = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const period = (req.query.period as string) || 'weekly';
  const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));
  const zoneId = req.query.zone_id as string | undefined;

  // Get current period start
  const now = new Date();
  let periodStart: string;
  if (period === 'daily') {
    periodStart = now.toISOString().split('T')[0];
  } else if (period === 'weekly') {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    periodStart = new Date(now.setDate(diff)).toISOString().split('T')[0];
  } else {
    periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  let query = supabaseAdmin
    .from('leaderboard_scores')
    .select('*, users(id, name, employee_id, avatar_url, zones(name))')
    .eq('org_id', user.org_id)
    .eq('period', period)
    .eq('period_start', periodStart)
    .order('overall_score', { ascending: false })
    .limit(limit);

  if (zoneId) query = query.eq('zone_id', zoneId);

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);

  // Mark current user's position
  const ranked = (data || []).map((entry, i) => ({
    ...entry,
    rank: i + 1,
    is_me: entry.users && (entry.users as { id: string }).id === user.id,
  }));

  return ok(res, { period, period_start: periodStart, entries: ranked });
});

// GET /api/v1/leaderboard/me — current user's score and rank
export const getMyScore = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const period = (req.query.period as string) || 'weekly';

  const now = new Date();
  let periodStart: string;
  if (period === 'daily') {
    periodStart = now.toISOString().split('T')[0];
  } else if (period === 'weekly') {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    periodStart = new Date(now.setDate(diff)).toISOString().split('T')[0];
  } else {
    periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  const { data, error } = await supabaseAdmin
    .from('leaderboard_scores')
    .select('*')
    .eq('user_id', user.id)
    .eq('period', period)
    .eq('period_start', periodStart)
    .single();

  if (error && error.code !== 'PGRST116') return badRequest(res, error.message);
  return ok(res, data || null);
});
