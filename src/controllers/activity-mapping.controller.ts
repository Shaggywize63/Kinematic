import { Response } from 'express';
import { AuthRequest } from '../types';
import { supabaseAdmin } from '../lib/supabase';
import { asyncHandler, sendSuccess, AppError, isDemo } from '../utils';

/* ── GET /api/v1/activity-mappings ── */
export const listAllMappings = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return sendSuccess(res, []);
  const { data, error } = await supabaseAdmin
    .from('activity_users')
    .select('activity_id, user_id')
    .eq('org_id', user.org_id);

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data || []);
});

/* ── GET /api/v1/activity-mappings/activity/:activityId ── */
export const getFEsByActivity = asyncHandler<AuthRequest>(async (req, res) => {
  const { activityId } = req.params;
  const user = req.user!;
  if (isDemo(user)) return sendSuccess(res, []);

  const { data, error } = await supabaseAdmin
    .from('activity_users')
    .select('user_id, users!user_id(id, name, employee_id, mobile, role)')
    .eq('activity_id', activityId)
    .eq('org_id', user.org_id);

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, (data || []).map((d: any) => d.users));
});

/* ── GET /api/v1/activity-mappings/user/:userId ── */
export const getActivitiesByUser = asyncHandler<AuthRequest>(async (req, res) => {
  const { userId } = req.params;
  const user = req.user!;
  if (isDemo(user)) return sendSuccess(res, []);

  const { data, error } = await supabaseAdmin
    .from('activity_users')
    .select('activity_id, activities!activity_id(id, name)')
    .eq('user_id', userId)
    .eq('org_id', user.org_id);

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, (data || []).map((d: any) => d.activities));
});

/* ── POST /api/v1/activity-mappings ── */
export const mapActivityUser = asyncHandler<AuthRequest>(async (req, res) => {
  const { activity_id, user_ids } = req.body;
  const admin = req.user!;
  if (isDemo(admin)) return sendSuccess(res, null, 'Mappings updated (Demo)');

  if (!activity_id || !Array.isArray(user_ids)) {
    throw new AppError(400, 'activity_id and user_ids[] are required', 'VALIDATION_ERROR');
  }

  // Delete existing mappings for this activity
  const { error: delErr } = await supabaseAdmin
    .from('activity_users')
    .delete()
    .eq('activity_id', activity_id)
    .eq('org_id', admin.org_id);

  if (delErr) throw new AppError(500, delErr.message, 'DB_ERROR');

  if (user_ids.length === 0) {
    return sendSuccess(res, null, 'All mappings removed');
  }

  // Insert new mappings
  const rows = user_ids.map(uid => ({
    activity_id,
    user_id: uid,
    org_id: admin.org_id
  }));

  const { error: insErr } = await supabaseAdmin
    .from('activity_users')
    .insert(rows);

  if (insErr) throw new AppError(500, insErr.message, 'DB_ERROR');
  sendSuccess(res, null, 'Mappings updated');
});
