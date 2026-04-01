import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { getPagination, buildPaginatedResult } from '../utils/pagination';
import { messaging } from '../lib/firebase';
import { logger } from '../lib/logger';

const fcmSchema = z.object({ fcm_token: z.string().min(10) });

// PATCH /api/v1/notifications/fcm-token
export const updateFcmToken = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { token } = req.body;
  if (!token) return badRequest(res, 'token is required');
  const { error } = await supabaseAdmin.from('users').update({ fcm_token: token }).eq('id', req.user!.id);
  if (error) return badRequest(res, error.message);
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
  return ok(res, data || []);
});

// GET /api/v1/notifications/history (Admin only)
export const getHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const from = (page - 1) * limit;
  const to = from + limit - 1;



  const { data, error, count } = await supabaseAdmin
    .from('notification_broadcasts')
    .select('*', { count: 'exact' })
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) return badRequest(res, error.message);
  return ok(res, { data: data || [], totalCount: count || 0 });
});

// POST /api/v1/notifications/send
export const sendNotification = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, body: content, priority, targeting, send_push } = req.body;
  const user = req.user!;

  if (!title || !content) return badRequest(res, 'Title and message (body) are required');

  // 1. Identify recipients based on targeting
  const { city, supervisor_id, fe_id } = targeting || {};
  let usersQuery = supabaseAdmin.from('users').select('id, org_id, fcm_token').eq('org_id', user.org_id);

  if (fe_id) {
    usersQuery = usersQuery.eq('id', fe_id);
  } else {
    if (city) usersQuery = usersQuery.eq('city', city);
    if (supervisor_id) usersQuery = usersQuery.eq('supervisor_id', supervisor_id);
  }

  const { data: targetUsers, error: uErr } = await usersQuery;
  if (uErr) return badRequest(res, uErr.message);
  
  const targetUserIds = (targetUsers || []).map(u => u.id);
  if (targetUserIds.length === 0) return badRequest(res, 'No recipients found for the selected targeting');

  // Log to Broadcast History first to get a Broadcast ID
  const audience_summary = fe_id ? 'Individual FE' : (city || supervisor_id) ? `${city || ''} ${supervisor_id ? 'Team' : ''}` : 'All Users';
  
  const { data: broadcast, error: bErr } = await supabaseAdmin
    .from('notification_broadcasts')
    .insert({
      org_id: user.org_id,
      title,
      body: content,
      priority: priority || 'info',
      audience_summary,
      recipients_count: targetUserIds.length,
      targeting,
      send_push: send_push || false
    })
    .select().single();


  // 2. Insert notifications for each recipient
  const notifications = targetUsers.map(target => ({
    user_id: target.id,
    org_id: target.org_id,
    title,
    body: content,
    type: 'broadcast',
    is_read: false,
    broadcast_id: broadcast?.id || null
  }));

  // Self-ping sender
  notifications.push({
    user_id: user.id,
    org_id: user.org_id,
    title: `[PING] ${title}`,
    body: content,
    type: 'broadcast',
    is_read: false,
    broadcast_id: broadcast?.id || null
  });

  const chunkSize = 100;
  for (let i = 0; i < notifications.length; i += chunkSize) {
    const { error: iErr } = await supabaseAdmin.from('notifications').insert(notifications.slice(i, i + chunkSize));
    if (iErr) logger.error('Failed to insert notification chunk: ' + iErr.message);
  }

  // 3. Send Push Notifications via FCM
  if (send_push) {
    const tokens = targetUsers.map(u => u.fcm_token).filter(t => t && t.length > 10);
    if (tokens.length > 0) {
      const message = {
        notification: { title, body: content },
        tokens: tokens as string[],
        data: { title, body: content, type: 'broadcast' }
      };
      try {
        const response = await messaging.sendEachForMulticast(message);
        logger.info(`FCM: Sent to ${response.successCount} users, failed for ${response.failureCount}`);
      } catch (fcmErr: any) {
        logger.error('FCM Multicast error: ' + fcmErr.message);
      }
    }
  }

  return ok(res, broadcast, 'Notification sent successfully');
});

// PATCH /api/v1/notifications/:id/read
export const markRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  
  const { data: existing } = await supabaseAdmin
    .from('notifications')
    .select('is_read, broadcast_id')
    .eq('id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!existing || existing.is_read) return ok(res, null, 'Already read');

  await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', id);

  if (existing.broadcast_id) {
    const { error: rpcErr } = await supabaseAdmin.rpc('increment_broadcast_read_count', { b_id: existing.broadcast_id });
    if (rpcErr) {
       const { data: bData } = await supabaseAdmin.from('notification_broadcasts').select('read_count').eq('id', existing.broadcast_id).single();
       if (bData) {
         await supabaseAdmin.from('notification_broadcasts').update({ read_count: (bData.read_count || 0) + 1 }).eq('id', existing.broadcast_id);
       }
    }
  }

  return ok(res, null, 'Marked as read');
});

// PATCH /api/v1/notifications/read-all
export const markAllRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { data: unread } = await supabaseAdmin
    .from('notifications')
    .select('id, broadcast_id')
    .eq('user_id', req.user!.id)
    .eq('is_read', false);

  if (unread && unread.length > 0) {
    await supabaseAdmin
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('id', unread.map(u => u.id));

    const broadcastIds = [...new Set(unread.map(n => n.broadcast_id).filter(Boolean))];
    for (const bId of broadcastIds) {
      if (!bId) continue;
      const count = unread.filter(n => n.broadcast_id === bId).length;
      const { error: rpcErr } = await supabaseAdmin.rpc('increment_broadcast_read_count', { b_id: bId });
      if (rpcErr) {
         const { data: bData } = await supabaseAdmin.from('notification_broadcasts').select('read_count').eq('id', bId).single();
         if (bData) {
           await supabaseAdmin.from('notification_broadcasts')
             .update({ read_count: (bData.read_count || 0) + count })
             .eq('id', bId);
         }
      }
    }
  }

  return ok(res, null, 'All notifications marked as read');
});

// DELETE /api/v1/notifications/history/:id
export const deleteHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;

  const { error } = await supabaseAdmin
    .from('notification_broadcasts')
    .delete()
    .eq('id', id)
    .eq('org_id', user.org_id);

  if (error) return badRequest(res, 'Failed to delete history');
  return ok(res, null, 'Broadcast history deleted successfully');
});
