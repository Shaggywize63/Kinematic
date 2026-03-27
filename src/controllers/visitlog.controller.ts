import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const visitSchema = z.object({
  visitor_role: z.string().optional(),
  visitor_name: z.string().optional(),
  executive_id: z.string().uuid().optional(),
  outlet_id: z.string().uuid().optional(),
  rating: z.enum(['excellent','good','average','poor']).default('good'),
  remarks: z.string().optional(),
  fe_feedback: z.string().optional(),
  photo_url: z.string().url().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const feedbackSchema = z.object({
  feedback: z.string().min(1),
});

// POST /api/v1/visits
export const logVisit = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = visitSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .insert({ 
      ...body.data, 
      org_id: user.org_id, 
      visitor_id: user.id, // The person logging it (The FE)
      executive_id: user.id, // In this case, it's about the FE themselves
      zone_id: user.zone_id,
      date: new Date().toISOString().split('T')[0],
      visited_at: new Date().toISOString()
    })
    .select('*, visitor:users!visitor_id(name, role), executive:users!executive_id(name), stores(name)')
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Visit logged');
});

// GET /api/v1/visits/mine
export const getMyVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = req.query.date as string | undefined;

  let query = supabaseAdmin
    .from('visit_logs')
    .select('*, visitor:users!visitor_id(name, role), executive:users!executive_id(name), stores(name)')
    .or(`visitor_id.eq.${user.id},executive_id.eq.${user.id}`)
    .order('visited_at', { ascending: false });

  if (date) query = query.eq('date', date);

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

// GET /api/v1/visits/received
export const getReceivedVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .select('*, users!visitor_id(name, role), stores(name)')
    .eq('executive_id', user.id)
    .order('visited_at', { ascending: false });

  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

// PATCH /api/v1/visits/:id/feedback
export const updateFEFeedback = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const body = feedbackSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .update({ 
      fe_feedback: body.data.feedback, 
      fe_feedback_at: new Date().toISOString() 
    })
    .eq('id', id)
    .eq('executive_id', user.id)
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return ok(res, data, 'Feedback updated');
});

// GET /api/v1/visits/team  (supervisor+)
export const getTeamVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .select('*, visitor:users!visitor_id(name, role), executive:users!executive_id(name), stores(name), zones(name)')
    .eq('org_id', user.org_id)
    .eq('date', date)
    .order('visited_at', { ascending: false });

  if (error) return badRequest(res, error.message);
  return ok(res, data);
});
