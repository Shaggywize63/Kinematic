import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest, isDemo } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';
import { getPagination, buildPaginatedResult } from '../utils/pagination';
import { messaging } from '../lib/firebase';
import { logger } from '../lib/logger';

const fcmSchema = z.object({ fcm_token: z.string().min(10) });

// PATCH /api/v1/notifications/fcm-token
//
// Body shape (both platforms):
//   { token: string, platform?: "ios" | "android" }
//
// Android has historically POSTed { token } (no platform). The iOS app
// includes platform: "ios" so that we can later route iOS tokens through
// the apns config block in messaging.send(...). We persist the platform
// into a fcm_platform column when one exists; if the column is missing
// (older schema) we silently fall back to a token-only update so the
// existing Android flow keeps working unchanged.
export const updateFcmToken = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (isDemo(req.user)) return ok(res, null, 'FCM token updated (Demo)');
  const { token, platform } = req.body as { token?: string; platform?: string };
  if (!token) return badRequest(res, 'token is required');

  // Validate platform if provided. Default Android to preserve historical
  // behaviour where Android clients send no platform field.
  const normalised: 'ios' | 'android' =
    platform === 'ios' ? 'ios' : 'android';

  // Attempt the richer update first.
  const { error: richErr } = await supabaseAdmin
    .from('users')
    .update({ fcm_token: token, fcm_platform: normalised })
    .eq('id', req.user!.id);

  if (richErr) {
    // PostgREST returns 42703 ("column does not exist") when the
    // fcm_platform column has not been migrated yet. Retry with just
    // the token so we never block clients on schema drift.
    const code = (richErr as any).code || '';
    const msg = (richErr.message || '').toLowerCase();
    const missingColumn =
      code === '42703' ||
      msg.includes('column') && msg.includes('fcm_platform');

    if (missingColumn) {
      const { error: fallbackErr } = await supabaseAdmin
        .from('users')
        .update({ fcm_token: token })
        .eq('id', req.user!.id);
      if (fallbackErr) return badRequest(res, fallbackErr.message);
      logger.warn(`FCM token saved without platform field — add a "fcm_platform" column to users to track ${normalised} vs android.`);
      return ok(res, null, 'FCM token updated (platform column missing — token-only update)');
    }

    return badRequest(res, richErr.message);
  }

  return ok(res, null, 'FCM token updated');
});

// GET /api/v1/notifications
export const getNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
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
  if (isDemo(user)) return ok(res, { data: [], totalCount: 0 });
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
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: 'demo-notif' }, 'Notification sent (Demo)');
  const { title, body: content, priority, targeting, send_push } = req.body;

  if (!title || !content) return badRequest(res, 'Title and message (body) are required');

  // 1. Identify recipients based on targeting.
  //
  // Targeting now supports four shapes (any combination):
  //   - { user_ids: [uuid, ...] }       direct user list (from the new
  //                                     dashboard tree picker)
  //   - { group_id: uuid }              expand a saved notification_group
  //   - { hierarchy_level_id: uuid }    every user at that org-hierarchy
  //                                     level (replaces supervisor_id /
  //                                     city_manager / fe_id picking by
  //                                     role label)
  //   - { city }                        narrow to a city
  //
  // The legacy `supervisor_id` + `fe_id` keys still work so the previous
  // notifications page doesn't break while the new composer rolls out.
  const t = (targeting || {}) as {
    city?: string | null;
    supervisor_id?: string | null;
    fe_id?: string | null;
    user_ids?: string[] | null;
    group_id?: string | null;
    hierarchy_level_id?: string | null;
  };
  // Expand a saved group's user_ids first, then merge with any
  // explicit user_ids the caller passed alongside. Dedup later.
  let directUserIds: string[] = Array.isArray(t.user_ids) ? t.user_ids.filter(Boolean) as string[] : [];
  if (t.group_id) {
    const { data: grp } = await supabaseAdmin.from('notification_groups')
      .select('user_ids').eq('org_id', user.org_id).eq('id', t.group_id).is('deleted_at', null).maybeSingle();
    if (Array.isArray(grp?.user_ids)) directUserIds.push(...(grp!.user_ids as string[]));
  }

  let usersQuery = supabaseAdmin.from('users').select('id, org_id, fcm_token').eq('org_id', user.org_id);

  if (directUserIds.length > 0) {
    // Direct list wins — narrow the query to exactly those ids,
    // optionally further narrowed by city if both were passed.
    usersQuery = usersQuery.in('id', Array.from(new Set(directUserIds)));
    if (t.city) usersQuery = usersQuery.eq('city', t.city);
  } else if (t.fe_id) {
    usersQuery = usersQuery.eq('id', t.fe_id);
  } else {
    if (t.city) usersQuery = usersQuery.eq('city', t.city);
    if (t.supervisor_id) usersQuery = usersQuery.eq('supervisor_id', t.supervisor_id);
    if (t.hierarchy_level_id) usersQuery = usersQuery.eq('hierarchy_level_id', t.hierarchy_level_id);
  }

  const { data: targetUsers, error: uErr } = await usersQuery;
  if (uErr) return badRequest(res, uErr.message);

  const targetUserIds = (targetUsers || []).map(u => u.id);
  if (targetUserIds.length === 0) return badRequest(res, 'No recipients found for the selected targeting');

  // Log to Broadcast History first to get a Broadcast ID. Summary
  // surfaces the active selector so the history page reads usefully.
  const audience_summary = directUserIds.length > 0
    ? (t.group_id ? `Saved group · ${targetUserIds.length} users` : `${targetUserIds.length} users`)
    : t.fe_id ? 'Individual FE'
    : (t.city || t.supervisor_id || t.hierarchy_level_id)
        ? `${t.city || ''} ${t.supervisor_id ? 'Team' : ''}${t.hierarchy_level_id ? ' Level' : ''}`.trim()
        : 'All Users';
  
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
      // Cross-platform multicast. The notification + data payload is the
      // same on iOS and Android; PushNotificationService on iOS parses the
      // data dict (type / lead_id / deal_id / task_id) and routes the
      // SwiftUI nav stack identically to the Android intent handler.
      //
      // Per-platform overrides (apns: { ... }, android: { ... }) can be
      // added here once we start tracking which tokens are iOS — see
      // fcm_platform column wired into updateFcmToken above.
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
  if (isDemo(req.user)) return ok(res, null, 'Marked as read (Demo)');
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
  if (isDemo(req.user)) return ok(res, null, 'All marked read (Demo)');
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
  if (isDemo(req.user)) return ok(res, null, 'Deleted (Demo)');
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

// DELETE /api/v1/notifications/clear
// Clears every notification belonging to the current user. The broadcast
// history rows in notification_broadcasts are untouched so admins can still
// see what was sent.
export const clearMyNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (isDemo(req.user)) return ok(res, null, 'Cleared (Demo)');
  const user = req.user!;
  const { error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('user_id', user.id);
  if (error) return badRequest(res, error.message);
  return ok(res, null, 'Notifications cleared');
});

// DELETE /api/v1/notifications/item/:id
// Deletes one of the current user's notifications. Scoped by user_id so a
// caller can't remove someone else's row even by guessing the id.
export const deleteMyNotification = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (isDemo(req.user)) return ok(res, null, 'Deleted (Demo)');
  const user = req.user!;
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) return badRequest(res, error.message);
  return ok(res, null, 'Notification deleted');
});

// DELETE /api/v1/notifications/history/clear
// Admin-only: wipes every notification_broadcasts row in the caller's org.
export const clearHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (isDemo(req.user)) return ok(res, null, 'Cleared (Demo)');
  const user = req.user!;
  const { error } = await supabaseAdmin
    .from('notification_broadcasts')
    .delete()
    .eq('org_id', user.org_id);
  if (error) return badRequest(res, 'Failed to clear history');
  return ok(res, null, 'Broadcast history cleared');
});

// ── Saved notification groups ──────────────────────────────────────────
//
// Admin picks a set of users (often via the new hierarchy/city tree on
// the dashboard composer), saves it under a name, then reuses it on
// subsequent sends. The `/notifications/send` handler resolves
// `targeting.group_id` to this row's `user_ids` at send time.

const groupSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(280).optional().nullable(),
  user_ids: z.array(z.string().uuid()).min(1, 'A group needs at least one user'),
});

export const listGroups = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin
    .from('notification_groups')
    .select('id, name, description, user_ids, created_at, updated_at')
    .eq('org_id', user.org_id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data ?? []);
});

export const createGroup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || 'Invalid group');
  const { data, error } = await supabaseAdmin
    .from('notification_groups')
    .insert({
      org_id: user.org_id,
      client_id: (user as any).client_id ?? null,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || null,
      user_ids: parsed.data.user_ids,
      created_by: user.id,
    })
    .select('id, name, description, user_ids, created_at, updated_at')
    .single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const updateGroup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = groupSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || 'Invalid group');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
  if (parsed.data.description !== undefined) patch.description = parsed.data.description?.trim() || null;
  if (parsed.data.user_ids !== undefined) patch.user_ids = parsed.data.user_ids;
  const { data, error } = await supabaseAdmin
    .from('notification_groups')
    .update(patch)
    .eq('org_id', user.org_id).eq('id', req.params.id).is('deleted_at', null)
    .select('id, name, description, user_ids, created_at, updated_at')
    .single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteGroup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { error } = await supabaseAdmin
    .from('notification_groups')
    .update({ deleted_at: new Date().toISOString() })
    .eq('org_id', user.org_id).eq('id', req.params.id).is('deleted_at', null);
  if (error) return badRequest(res, error.message);
  return ok(res, null, 'Group deleted');
});
