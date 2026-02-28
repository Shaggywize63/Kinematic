import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../lib/logger';

const triggerSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().optional(),
  message: z.string().optional(),
});

// POST /api/v1/sos/trigger
export const trigger = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = triggerSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  // Find supervisor(s) to notify
  const usersToNotify: string[] = [];

  if (user.supervisor_id) usersToNotify.push(user.supervisor_id);

  // Also notify city managers in the org
  const { data: managers } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('org_id', user.org_id)
    .in('role', ['city_manager', 'admin']);

  (managers || []).forEach((m: { id: string }) => {
    if (!usersToNotify.includes(m.id)) usersToNotify.push(m.id);
  });

  const { data: alert, error } = await supabaseAdmin
    .from('sos_alerts')
    .insert({
      org_id: user.org_id,
      user_id: user.id,
      zone_id: user.zone_id,
      ...body.data,
      status: 'active',
      notified_user_ids: usersToNotify,
    })
    .select()
    .single();

  if (error) return badRequest(res, error.message);

  // Create notifications for supervisors
  if (usersToNotify.length) {
    const notifInserts = usersToNotify.map((uid) => ({
      org_id: user.org_id,
      user_id: uid,
      type: 'sos' as const,
      title: `🆘 SOS Alert — ${user.name}`,
      body: `${user.name} has triggered an emergency SOS. Tap to view location.`,
      data: { sos_id: alert.id, exec_id: user.id, lat: body.data.latitude, lng: body.data.longitude },
    }));
    await supabaseAdmin.from('notifications').insert(notifInserts);
  }

  logger.warn(`SOS TRIGGERED — User: ${user.name} (${user.id}), Org: ${user.org_id}`);

  return created(res, alert, 'SOS alert sent. Your supervisor has been notified.');
});

// PATCH /api/v1/sos/:id/acknowledge  (supervisor+)
export const acknowledge = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('sos_alerts')
    .update({ status: 'acknowledged', acknowledged_by: user.id, acknowledged_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', user.org_id)
    .select()
    .single();

  if (error || !data) return notFound(res, 'SOS alert not found');
  return ok(res, data, 'Alert acknowledged');
});

// PATCH /api/v1/sos/:id/resolve  (supervisor+)
export const resolve = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { resolution_notes } = req.body;

  const { data, error } = await supabaseAdmin
    .from('sos_alerts')
    .update({
      status: 'resolved',
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_notes,
    })
    .eq('id', id)
    .eq('org_id', user.org_id)
    .select()
    .single();

  if (error || !data) return notFound(res, 'SOS alert not found');
  return ok(res, data, 'Alert resolved');
});

// GET /api/v1/sos  (supervisor+)
export const getAlerts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const status = req.query.status as string | undefined;

  let query = supabaseAdmin
    .from('sos_alerts')
    .select('*, users(name, mobile, employee_id), zones(name)')
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});
