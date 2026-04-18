import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, isUUID } from '../utils';
import { DEMO_ORG_ID, isDemo, getMockVisitLogs } from '../utils/demoData';

const visitSchema = z.object({
  visitor_role: z.string().optional(),
  visitor_name: z.string().optional(),
  executive_id: z.string().uuid().optional().nullable(),
  visit_outlet_id: z.string().uuid().optional().nullable(),
  rating: z.enum(['excellent','good','average','poor']).default('good'),
  remarks: z.string().optional().nullable(),
  visit_response: z.string().optional().nullable(), // RENAME
  photo_url: z.string().url().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
});

const feedbackSchema = z.object({
  feedback: z.string().min(1),
});

/**
 * ULTRA STABLE ENRICHMENT - NO JOINS
 */
async function enrichVisitLogs(logs: any[]) {
  if (!logs || logs.length === 0) return [];
  try {
    const visitorIds  = [...new Set(logs.map(l => l.visitor_id).filter(Boolean))];
    const executiveIds = [...new Set(logs.map(l => l.executive_id).filter(Boolean))];
    const outletIds   = [...new Set(logs.map(l => l.visit_outlet_id).filter(Boolean))];
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
      stores:    storeMap.get(l.visit_outlet_id) || null,
      zones:     zoneMap.get(l.zone_id) || null,
      users:     userMap.get(l.visitor_id) || null 
    }));
  } catch (e) {
    console.error('[VisitLog] Enrichment Failed:', e);
    return logs;
  }
}

const ALL_COLUMNS = 'id, visitor_id, executive_id, zone_id, client_id, visit_outlet_id, org_id, rating, remarks, visit_response, visit_response_at, photo_url, latitude, longitude, date, visited_at';

// POST /api/v1/visits
export const logVisit = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-visit-id', ...req.body }, 'Visit logged (Demo)');
  
  const body = visitSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  // Use the new column name in Insert
  const { data: insertData, error: insertError } = await supabaseAdmin
    .from('visit_logs')
    .insert({ 
      ...body.data, 
      org_id: user.org_id, 
      client_id: user.client_id,
      visitor_id: user.id, 
      executive_id: body.data.executive_id || user.id, 
      zone_id: user.zone_id,
      date: new Date().toISOString().split('T')[0],
      visited_at: new Date().toISOString()
    })
    .select('id')
    .single();

  if (insertError) return badRequest(res, insertError.message);

  const { data: fullRecord } = await supabaseAdmin
    .from('visit_logs')
    .select(ALL_COLUMNS)
    .eq('id', insertData.id)
    .single();

  const enriched = await enrichVisitLogs([fullRecord]);
  return created(res, enriched[0], 'Visit logged');
});

// GET /api/v1/visits/mine
export const getMyVisits = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { data: getMockVisitLogs(new Date().toISOString().split('T')[0]) });

  const { date } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('visit_logs')
    .select(ALL_COLUMNS)
    .or(`visitor_id.eq.${user.id},executive_id.eq.${user.id}`)
    .order('visited_at', { ascending: false });

  if (date) query = query.eq('date', date);

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);

  return ok(res, await enrichVisitLogs(data || []));
});

// GET /api/v1/visits/received
export const getReceivedVisits = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { data: getMockVisitLogs(new Date().toISOString().split('T')[0]) });
  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .select(ALL_COLUMNS)
    .eq('executive_id', user.id)
    .order('visited_at', { ascending: false });

  if (error) return badRequest(res, error.message);
  return ok(res, await enrichVisitLogs(data || []));
});

// PATCH /api/v1/visits/:id/feedback
export const updateFEFeedback = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { success: true }, 'Feedback updated (Demo)');
  const { id } = req.params;
  const body = feedbackSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .update({ 
      visit_response: body.data.feedback, 
      visit_response_at: new Date().toISOString() 
    })
    .eq('id', id)
    .eq('executive_id', user.id)
    .select(ALL_COLUMNS)
    .single();

  if (error) return badRequest(res, error.message);
  return ok(res, data, 'Feedback updated');
});

// GET /api/v1/visits/team
export const getTeamVisits = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { data: getMockVisitLogs(new Date().toISOString().split('T')[0]) });
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  let query = supabaseAdmin
    .from('visit_logs')
    .select(ALL_COLUMNS)
    .eq('date', date);

  const targetCid = isUUID(req.query.client_id as string) ? (req.query.client_id as string) : user.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', user.org_id);
  }

  const { data, error } = await query.order('visited_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, await enrichVisitLogs(data || []));
});
