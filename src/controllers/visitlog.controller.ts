import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const visitSchema = z.object({
  visitor_role: z.string().optional(),
  visitor_name: z.string().optional(),
  executive_id: z.string().uuid().optional().nullable(),
  outlet_id: z.string().uuid().optional().nullable(),
  rating: z.enum(['excellent','good','average','poor']).default('good'),
  remarks: z.string().optional().nullable(),
  fe_feedback: z.string().optional().nullable(),
  photo_url: z.string().url().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
});

const feedbackSchema = z.object({
  feedback: z.string().min(1),
});

async function enrichVisitLogs(logs: any[]) {
  if (!logs || logs.length === 0) return [];
  const visitorIds  = [...new Set(logs.map(l => l.visitor_id).filter(Boolean))];
  const executiveIds = [...new Set(logs.map(l => l.executive_id).filter(Boolean))];
  const outletIds   = [...new Set(logs.map(l => l.outlet_id).filter(Boolean))];
  const zoneIds     = [...new Set(logs.map(l => l.zone_id).filter(Boolean))];

  const [usersRes, storesRes, zonesRes] = await Promise.all([
    supabaseAdmin.from('users').select('id, name, role').in('id', [...new Set([...visitorIds, ...executiveIds])]),
    supabaseAdmin.from('stores').select('id, name').in('id', outletIds),
    supabaseAdmin.from('zones').select('id, name').in('id', zoneIds),
  ]);

  const userMap  = new Map(usersRes.data?.map(u => [u.id, u]) || []);
  const storeMap = new Map(storesRes.data?.map(s => [s.id, s]) || []);
  const zoneMap  = new Map(zonesRes.data?.map(z => [z.id, z]) || []);

  return logs.map(l => ({
    ...l,
    visitor:   userMap.get(l.visitor_id) || null,
    executive: userMap.get(l.executive_id) || null,
    stores:    storeMap.get(l.outlet_id) || null,
    zones:     zoneMap.get(l.zone_id) || null,
    users:     userMap.get(l.visitor_id) || null 
  }));
}

export const logVisit = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = visitSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data: inserted, error } = await supabaseAdmin
    .from('visit_logs')
    .insert({ 
      ...body.data, 
      org_id: user.org_id, 
      visitor_id: user.id, 
      executive_id: body.data.executive_id || user.id, 
      zone_id: user.zone_id,
      date: new Date().toISOString().split('T')[0],
      visited_at: new Date().toISOString()
    }).select('id, org_id, visitor_id, executive_id, zone_id, outlet_id, rating, remarks, fe_feedback, fe_feedback_at, photo_url, latitude, longitude, date, visited_at').single();

  if (error) return badRequest(res, error.message);
  const enriched = await enrichVisitLogs([inserted]);
  return created(res, enriched[0], 'Visit logged');
});

export const getMyVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = req.query.date as string | undefined;
  let q = supabaseAdmin.from('visit_logs').select('id, org_id, visitor_id, executive_id, zone_id, outlet_id, rating, remarks, fe_feedback, fe_feedback_at, photo_url, latitude, longitude, date, visited_at')
    .or(`visitor_id.eq.${user.id},executive_id.eq.${user.id}`).order('visited_at', { ascending: false });
  if (date) q = q.eq('date', date);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, await enrichVisitLogs(data || []));
});

export const getReceivedVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin.from('visit_logs').select('id, org_id, visitor_id, executive_id, zone_id, outlet_id, rating, remarks, fe_feedback, fe_feedback_at, photo_url, latitude, longitude, date, visited_at')
    .eq('executive_id', user.id).order('visited_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, await enrichVisitLogs(data || []));
});

export const updateFEFeedback = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const body = feedbackSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);
  const { data, error } = await supabaseAdmin.from('visit_logs').update({ fe_feedback: body.data.feedback, fe_feedback_at: new Date().toISOString() })
    .eq('id', id).eq('executive_id', user.id).select('id, org_id, visitor_id, executive_id, zone_id, outlet_id, rating, remarks, fe_feedback, fe_feedback_at, photo_url, latitude, longitude, date, visited_at').single();
  if (error) return badRequest(res, error.message);
  return ok(res, data, 'Feedback updated');
});

export const getTeamVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
  const { data, error } = await supabaseAdmin.from('visit_logs').select('id, org_id, visitor_id, executive_id, zone_id, outlet_id, rating, remarks, fe_feedback, fe_feedback_at, photo_url, latitude, longitude, date, visited_at')
    .eq('org_id', user.org_id).eq('date', date).order('visited_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, await enrichVisitLogs(data || []));
});
