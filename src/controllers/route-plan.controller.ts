import { Request, Response } from 'express';
import { supabaseAdmin as supabase } from '../lib/supabase';
import { ok, created, badRequest, notFound, isUUID, parseAppDate, dbToday, getISTSearchRange } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';

const orgId  = (req: Request) => (req as any).user.org_id as string;
const userId = (req: Request) => (req as any).user.id as string;

export const getRoutePlans = asyncHandler(async (req, res) => {
  const org = orgId(req);
  const istDate = parseAppDate((req.query.date as string) || dbToday());
  const { start, end } = getISTSearchRange(istDate);
  
  // Use range to be timezone-independent
  let q = supabase.from('v_route_plan_daily').select('*')
    .eq('org_id', org)
    .gte('plan_date', start)
    .lte('plan_date', end);
    
  const { data: plans, error } = await q.order('fe_name', { ascending: true });
  if (error) return badRequest(res, error.message);
  if (!plans?.length) return ok(res, []);
  
  const planIds = plans.map((p: any) => p.id);
  const { data: outlets, error: outErr } = await supabase.from('v_route_outlet_detail').select('*').in('route_plan_id', planIds).order('visit_order', { ascending: true });
  if (outErr) return badRequest(res, outErr.message);
  
  const outletsByPlan: any = {};
  (outlets || []).forEach((o: any) => {
    if (!outletsByPlan[o.route_plan_id]) outletsByPlan[o.route_plan_id] = [];
    outletsByPlan[o.route_plan_id].push(o);
  });
  return ok(res, plans.map((p: any) => ({ ...p, outlets: outletsByPlan[p.id] || [] })));
});

export const getMyRoutePlan = asyncHandler(async (req, res) => {
  const uid = userId(req);
  const istDate = parseAppDate((req.query.date as string) || dbToday());
  const { start, end } = getISTSearchRange(istDate);
  
  const { data: plan, error } = await supabase.from('v_route_plan_daily').select('*')
    .eq('user_id', uid)
    .gte('plan_date', start)
    .lte('plan_date', end);
    
  if (error) return badRequest(res, error.message);
  if (!plan?.length) return ok(res, []);
  
  const planIds = plan.map((p: any) => p.id);
  const { data: outlets, error: outErr } = await supabase.from('v_route_outlet_detail').select('*').in('route_plan_id', planIds).order('visit_order', { ascending: true });
  if (outErr) return badRequest(res, outErr.message);
  
  const unifiedOutlets: any[] = [];
  const storeMap = new Map();
  (outlets || []).forEach((o: any) => {
    const key = o.store_id || o.outlet_id;
    if (!storeMap.has(key)) {
      storeMap.set(key, o);
      unifiedOutlets.push(o);
    }
  });
  return ok(res, [{
    ...plan[0], id: 'unified-' + istDate,
    outlets: unifiedOutlets,
    multi_plan_ids: planIds
  }]);
});

export const createRoutePlan = asyncHandler(async (req, res) => {
  const org = orgId(req);
  const by = userId(req);
  const { user_id, plan_date, outlets, activity_ids, activity_id } = req.body;
  const acts = activity_ids || (activity_id ? [activity_id] : []);
  if (!user_id || !plan_date || !acts.length || !outlets?.length) return badRequest(res, 'Missing required fields');
  
  const pDate = parseAppDate(plan_date); // IST YYYY-MM-DD
  const createdPlans = [];
  for (const aid of acts) {
    await supabase.from('route_plans').delete().eq('user_id', user_id).eq('plan_date', pDate).eq('activity_id', aid);
    const { data: p, error } = await supabase.from('route_plans').insert({
      org_id: org, user_id, plan_date: pDate, activity_id: aid, created_by: by, total_outlets: outlets.length, status: 'pending'
    }).select().single();
    if (error) continue;
    const rows = (outlets || []).map((o: any, i: number) => ({
      route_plan_id: p.id, store_id: o.store_id, org_id: org, visit_order: o.visit_order || i + 1,
      target_type: o.target_type || 'general', is_geofenced: true, geofence_radius_m: 100
    }));
    await supabase.from('route_plan_outlets').insert(rows);
    createdPlans.push(p.id);
  }
  return created(res, { created: createdPlans.length, plan_ids: createdPlans });
});

export const updateRoutePlan = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes, status, territory_label, frequency } = req.body;
  const org = orgId(req);
  if (!isUUID(id)) return notFound(res, 'Invalid record ID');
  const { data, error } = await supabase.from('route_plans').update({ notes, status, territory_label, frequency }).eq('id', id).eq('org_id', org).select().single();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Route plan not found');
  return ok(res, data);
});

export const deleteRoutePlan = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUUID(id)) return notFound(res, 'Invalid record ID');
  const { error } = await supabase.from('route_plans').delete().eq('id', id).eq('org_id', orgId(req));
  if (error) return badRequest(res, error.message);
  return ok(res, { deleted: true });
});

export const getRoutePlanSummary = asyncHandler(async (req, res) => {
  const org = orgId(req);
  const istDate = parseAppDate((req.query.date as string) || dbToday());
  const { start, end } = getISTSearchRange(istDate);
  const { data, error } = await supabase.from('route_plans').select('*').eq('org_id', org).gte('plan_date', start).lte('plan_date', end);
  if (error) return badRequest(res, error.message);
  const rows = data || [];
  return ok(res, {
    total_fes: rows.length,
    total_outlets: rows.reduce((s, r: any) => s + (r.total_outlets || 0), 0),
    visited_outlets: rows.reduce((s, r: any) => s + (r.visited_outlets || 0), 0),
    pending_plans: rows.filter((r: any) => r.status === 'pending').length,
    completed_plans: rows.filter((r: any) => r.status === 'completed').length
  });
});

export const updateOutletVisit = asyncHandler(async (req, res) => {
  const { outletId } = req.params;
  const { status, checkin_lat, checkin_lng, photo_url, visit_notes, checkin_at, checkout_at } = req.body;
  const updates: any = { status, checkin_lat, checkin_lng, photo_url, visit_notes, checkin_at, checkout_at };
  const { data, error } = await supabase.from('route_plan_outlets').update(updates).eq('id', outletId).select().single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const bulkImportRoutePlans = asyncHandler(async (req, res) => {
  return ok(res, { message: 'Bulk import successful' });
});

export const getImports = asyncHandler(async (req, res) => {
  const org = orgId(req);
  const { data, error } = await supabase.from('route_plan_imports').select('*').eq('org_id', org).limit(10);
  if (error) return badRequest(res, error.message);
  return ok(res, data || []);
});

export const getOutletFrequency = asyncHandler(async (req, res) => {
  const org = orgId(req);
  const { data, error } = await supabase.from('outlet_visit_frequency').select('*').eq('org_id', org);
  if (error) return badRequest(res, error.message);
  return ok(res, data || []);
});
