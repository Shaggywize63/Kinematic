import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { getPagination, buildPaginatedResult } from '../utils/pagination';

const fcmSchema = z.object({ fcm_token: z.string().min(10) });

// PATCH /api/v1/notifications/fcm-token
export const updateFcmToken = asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = fcmSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'fcm_token is required');
  await supabaseAdmin.from('users').update({ fcm_token: body.data.fcm_token }).eq('id', req.user!.id);
  return ok(res, null, 'FCM token updated');
});

// GET /api/v1/notifications
export const getNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as string, req.query.limit as string);
  const unreadOnly = req.query.unread === 'true';

  let query = supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (unreadOnly) query = query.eq('is_read', false);

  const { data, error, count } = await query;
  if (error) return badRequest(res, error.message);
  return ok(res, buildPaginatedResult(data || [], count || 0, page, limit));
});

// PATCH /api/v1/notifications/:id/read
export const markRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', req.user!.id);
  return ok(res, null, 'Marked as read');
});

// PATCH /api/v1/notifications/read-all
export const markAllRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_id', req.user!.id)
    .eq('is_read', false);
  return ok(res, null, 'All notifications marked as read');
});
