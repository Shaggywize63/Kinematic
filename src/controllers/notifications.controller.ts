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

// GET /api/v1/notifications/history (Admin/Supervisor Only)
export const getHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  
  const { data, error } = await supabaseAdmin
    .from('notification_broadcasts')
    .select('*')
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[DIAGNOSTIC] Notification history fetching failed:', error.message);
    // If table doesn't exist, don't crash the dashboard.
    return res.status(200).json({ success: true, data: [] });
  }
  return ok(res, data || []);
});

// POST /api/v1/notifications/send (Admin/Supervisor Only)
export const sendNotification = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, body: content, priority, targeting } = req.body;
  const user = req.user!;

  if (!title || !content) return badRequest(res, 'Title and message are required');

  // Targeting Logic
  const { city, supervisor_id, fe_id } = targeting || {};
  let targetUsers: { id: string, org_id: string }[] = [];

  const isPrivileged = ['super_admin', 'admin', 'hr', 'city_manager'].includes(user.role?.toLowerCase());

  if (fe_id) {
    const { data } = await supabaseAdmin.from('users').select('id, org_id').eq('id', fe_id).single();
    if (data) targetUsers = [data];
  } else if (supervisor_id) {
    // Both supervisor and their FEs
    let q = supabaseAdmin.from('users').select('id, org_id').or(`id.eq.${supervisor_id},supervisor_id.eq.${supervisor_id}`);
    if (!isPrivileged) q = q.eq('org_id', user.org_id);
    const { data } = await q;
    targetUsers = data || [];
  } else if (city) {
    let q = supabaseAdmin.from('users').select('id, org_id').eq('city', city).eq('is_active', true);
    if (!isPrivileged) q = q.eq('org_id', user.org_id);
    const { data } = await q;
    targetUsers = data || [];
  } else {
    // All users
    let q = supabaseAdmin.from('users').select('id, org_id').eq('is_active', true);
    if (!isPrivileged) q = q.eq('org_id', user.org_id);
    const { data } = await q;
    targetUsers = data || [];
  }

  const targetUserIds = targetUsers.map(u => u.id);

  if (targetUserIds.length === 0) {
    console.warn(`[DIAGNOSTIC] No recipients found for target. RequesterOrg=${user.org_id}, Privileged=${isPrivileged}`);
    return badRequest(res, 'No recipients found for the selected target');
  }

  console.log(`[DIAGNOSTIC] Targeting Success: Found ${targetUserIds.length} users across ${[...new Set(targetUsers.map(u => u.org_id))].length} organizations.`);

  // audience_summary for history
  const audience_summary = fe_id ? '1 Individual' : supervisor_id ? 'Supervisor & Team' : city ? `City: ${city}` : 'All Users';

  // 1. Create the broadcast history record
  const { data: broadcast, error: bErr } = await supabaseAdmin
    .from('notification_broadcasts')
    .insert({
      org_id: user.org_id,
      title,
      body: content,
      priority: priority || 'info',
      audience_summary,
      recipients_count: targetUserIds.length,
      targeting
    })
    .select().single();

  if (bErr) {
    console.warn('[DIAGNOSTIC] Failed to log broadcast history (table missing?):', bErr.message);
  }

  // 2. Insert notifications for each recipient
  const notifications = targetUsers.map(target => ({
    user_id: target.id,
    org_id: target.org_id, // CRITICAL: Tag with recipient's Org ID, not sender's
    title,
    body: content,
    type: 'broadcast',
    is_read: false
  }));

  // Self-ping sender so they can see it too
  notifications.push({
    user_id: user.id,
    org_id: user.org_id,
    title: `[PING] ${title}`,
    body: content,
    type: 'broadcast',
    is_read: false
  });

  // Batch insert in chunks of 100 to avoid query size limits
  let totalInserted = 0;
  const chunkSize = 100;
  for (let i = 0; i < notifications.length; i += chunkSize) {
    const chunk = notifications.slice(i, i + chunkSize);
    const { error: insErr } = await supabaseAdmin.from('notifications').insert(chunk);
    if (insErr) {
      console.error('[DIAGNOSTIC] Notification Insert Failed:', insErr.message);
    } else {
      totalInserted += chunk.length;
    }
  }

  console.log(`[DIAGNOSTIC] In-App Feed: Successfully queued ${totalInserted} records (including self-ping).`);

  // 3. Trigger FCM Push Notifications
  if (messaging && targetUserIds.length > 0) {
    try {
      // Fetch FCM tokens for the target users
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('fcm_token')
        .in('id', targetUserIds)
        .not('fcm_token', 'is', null);

      const tokens = (userData || [])
        .map(u => u.fcm_token)
        .filter(t => t && t.length > 10) as string[];

      if (tokens.length > 0) {
        const message = {
          notification: { title, body: content },
          data: { type: 'broadcast', priority: priority || 'info' },
          tokens: tokens,
        };

        const response = await messaging.sendEachForMulticast(message);
        logger.info(`FCM: Sent to ${response.successCount} users, failed for ${response.failureCount} users`);
      }
    } catch (fcmErr: any) {
      logger.error('FCM Multicast error: ' + fcmErr.message);
    }
  }

  return ok(res, broadcast, 'Notification sent to ' + targetUserIds.length + ' recipients');
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
