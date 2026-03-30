import { Request, Response } from 'express';
import { supabaseAdmin as supabase } from '../lib/supabase';
import { ok, created, badRequest, notFound } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */
const orgId  = (req: Request) => (req as any).user.org_id as string;
const userId = (req: Request) => (req as any).user.id as string;
const today  = () => new Date().toISOString().split('T')[0];

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/route-plan?date=YYYY-MM-DD&user_id=&status=&zone_id=
   Admin / Supervisor — full list with outlet detail via view
───────────────────────────────────────────────────────────── */
export const getRoutePlans = asyncHandler(async (req: Request, res: Response) => {
  const org   = orgId(req);
  const date  = (req.query.date as string) || today();
  const uid   = req.query.user_id as string | undefined;
  const stat  = req.query.status  as string | undefined;
  const zone  = req.query.zone_id as string | undefined;

  let q = supabase
    .from('v_route_plan_daily')
    .select('*')
    .eq('org_id', org)
    .eq('plan_date', date);

  if (uid)  q = q.eq('user_id', uid);
  if (stat) q = q.eq('status', stat);
  if (zone) q = q.eq('zone_name', zone); // zone_name from view

  const { data: plans, error } = await q.order('fe_name', { ascending: true });
  if (error) return badRequest(res, error.message);
  if (!plans?.length) return ok(res, []);

  // Attach outlet stops for each plan
  const planIds = plans.map((p: any) => p.id);
  const { data: outlets, error: outErr } = await supabase
    .from('v_route_outlet_detail')
    .select('*')
    .in('route_plan_id', planIds)
    .order('visit_order', { ascending: true });

  if (outErr) return badRequest(res, outErr.message);

  const outletsByPlan: Record<string, any[]> = {};
  (outlets || []).forEach((o: any) => {
    if (!outletsByPlan[o.route_plan_id]) outletsByPlan[o.route_plan_id] = [];
    outletsByPlan[o.route_plan_id].push(o);
  });

  const result = plans.map((p: any) => ({
    ...p,
    outlets: outletsByPlan[p.id] || [],
  }));

  return ok(res, result);
});

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/route-plan/summary?date=YYYY-MM-DD
───────────────────────────────────────────────────────────── */
export const getRoutePlanSummary = asyncHandler(async (req: Request, res: Response) => {
  const org  = orgId(req);
  const date = (req.query.date as string) || today();

  const { data, error } = await supabase
    .from('route_plans')
    .select('id, status, total_outlets, visited_outlets, missed_outlets, completion_pct')
    .eq('org_id', org)
    .eq('plan_date', date);

  if (error) return badRequest(res, error.message);

  const rows = data || [];
  const summary = {
    total_fes:        rows.length,
    total_outlets:    rows.reduce((s: number, r: any) => s + (r.total_outlets || 0), 0),
    visited_outlets:  rows.reduce((s: number, r: any) => s + (r.visited_outlets || 0), 0),
    missed_outlets:   rows.reduce((s: number, r: any) => s + (r.missed_outlets || 0), 0),
    completed_plans:  rows.filter((r: any) => r.status === 'completed').length,
    partial_plans:    rows.filter((r: any) => r.status === 'partial').length,
    in_progress_plans:rows.filter((r: any) => r.status === 'in_progress').length,
    pending_plans:    rows.filter((r: any) => r.status === 'pending').length,
    avg_completion:   rows.length
      ? Math.round(rows.reduce((s: number, r: any) => s + Number(r.completion_pct || 0), 0) / rows.length)
      : 0,
  };

  return ok(res, summary);
});

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/route-plan/me?date=YYYY-MM-DD
   Field Executive — own plan for a date
───────────────────────────────────────────────────────────── */
export const getMyRoutePlan = asyncHandler(async (req: Request, res: Response) => {
  const uid  = userId(req);
  const date = (req.query.date as string) || today();

  console.log(`[Diagnostic] Authenticated UID: ${uid}`);
  console.log(`[Diagnostic] Requested Date: ${date}`);

  const { data: plan, error } = await supabase
    .from('v_route_plan_daily')
    .select('*')
    .eq('user_id', uid)
    .eq('plan_date', date);

  if (error) return badRequest(res, error.message);
  if (!plan?.length) return ok(res, []);

  // Combine outlets for all plans of the day
  const planIds = plan.map((p: any) => p.id);
  console.log('[Diagnostic] Plan IDs:', planIds);
  const { data: outlets, error: outErr } = await supabase
    .from('v_route_outlet_detail')
    .select('*')
    .in('route_plan_id', planIds)
    .order('visit_order', { ascending: true });
  
  if (outErr) {
    console.error('[Diagnostic] Outlet Query Error:', outErr.message);
    return badRequest(res, outErr.message);
  }

  console.log('[Diagnostic] Outlets found:', outlets?.length || 0);
  if (outlets?.length) {
    console.log('[Diagnostic] Outlet Names:', outlets.map((o: any) => o.store_name).join(', '));
  }
  
  // Distribute outlets back to their respective plans
  const outletsByPlan: Record<string, any[]> = {};
  (outlets || []).forEach((o: any) => {
    if (!outletsByPlan[o.route_plan_id]) outletsByPlan[o.route_plan_id] = [];
    outletsByPlan[o.route_plan_id].push(o);
  });

  const result = plan.map((p: any) => ({
    ...p,
    outlets: outletsByPlan[p.id] || []
  }));

  return ok(res, result);
});

/* ─────────────────────────────────────────────────────────────
   POST /api/v1/route-plans
   Admin / Supervisor — create plan for an FE
   Body: { user_id, plan_date, notes?, frequency?, territory_label?, activity_ids: string[], outlets: [{store_id, target_type, target_notes?, target_value?, visit_order?, geofence_radius_m?, planned_duration_min?}] }
───────────────────────────────────────────────────────────── */
export const createRoutePlan = asyncHandler(async (req: Request, res: Response) => {
  const org   = orgId(req);
  const by    = userId(req);
  const {
    user_id, plan_date, outlets, notes, activity_id, activity_ids,
    frequency = 'daily', territory_label,
  } = req.body;

  const acts = activity_ids && activity_ids.length > 0 ? activity_ids : (activity_id ? [activity_id] : []);

  if (!user_id || !plan_date || acts.length === 0) return badRequest(res, 'user_id, activity_ids and plan_date are required');
  if (!Array.isArray(outlets) || outlets.length === 0) return badRequest(res, 'outlets[] must be a non-empty array');

  // Validate all store_ids provided
  if (outlets.some((o: any) => !o.store_id)) return badRequest(res, 'Every outlet must have a store_id');

  const createdPlans = [];

  for (const aid of acts) {
    // Insert plan (no more duplicate check)

    // Insert plan
    const { data: plan, error: planErr } = await supabase
      .from('route_plans')
      .insert({ org_id: org, user_id, plan_date, notes, frequency, territory_label, activity_id: aid, created_by: by, total_outlets: outlets.length })
      .select()
      .single();

    if (planErr) return badRequest(res, planErr.message);

    // Insert outlets
    const outletRows = outlets.map((o: any, idx: number) => ({
      route_plan_id:       plan.id,
      store_id:            o.store_id,
      org_id:              org,
      visit_order:         o.visit_order ?? idx + 1,
      target_type:         o.target_type ?? 'general',
      target_notes:        o.target_notes ?? null,
      target_value:        o.target_value ?? null,
      geofence_radius_m:   o.geofence_radius_m ?? 100,
      planned_duration_min:o.planned_duration_min ?? null,
    }));

    const { error: outletsErr } = await supabase
      .from('route_plan_outlets')
      .insert(outletRows);

    if (outletsErr) {
      // Clean up the plan if outlets fail
      await supabase.from('route_plans').delete().eq('id', plan.id);
      return badRequest(res, outletsErr.message);
    }
    
    createdPlans.push(plan.id);
  }

  return created(res, { created: createdPlans.length, plan_ids: createdPlans });
});

/* ─────────────────────────────────────────────────────────────
   PATCH /api/v1/route-plans/:id
   Update plan metadata
───────────────────────────────────────────────────────────── */
export const updateRoutePlan = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { notes, status, territory_label, frequency } = req.body;

  const { data, error } = await supabase
    .from('route_plans')
    .update({ notes, status, territory_label, frequency })
    .eq('id', id)
    .eq('org_id', orgId(req))
    .select()
    .single();

  if (error)  return badRequest(res, error.message);
  if (!data)  return notFound(res, 'Route plan not found');
  return ok(res, data);
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/v1/route-plans/:id
───────────────────────────────────────────────────────────── */
export const deleteRoutePlan = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { error } = await supabase
    .from('route_plans')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId(req));

  if (error) return badRequest(res, error.message);
  return ok(res, { deleted: true });
});

/* ─────────────────────────────────────────────────────────────
   PATCH /api/v1/route-plans/outlets/:outletId
   FE — update outlet visit status (check-in / complete / miss / skip)
───────────────────────────────────────────────────────────── */
export const updateOutletVisit = asyncHandler(async (req: Request, res: Response) => {
  const { outletId } = req.params;
  const {
    status,
    checkin_lat, checkin_lng, checkin_distance_m,
    photo_url, secondary_photo_url,
    order_amount, visit_notes, rejection_reason,
    checkin_at, checkout_at,
  } = req.body;

  if (!status) return badRequest(res, 'status is required');

  const updates: Record<string, any> = { status };

  if (checkin_lat !== undefined)        updates.checkin_lat = checkin_lat;
  if (checkin_lng !== undefined)        updates.checkin_lng = checkin_lng;
  if (checkin_distance_m !== undefined) updates.checkin_distance_m = checkin_distance_m;
  if (photo_url)                        updates.photo_url = photo_url;
  if (secondary_photo_url)              updates.secondary_photo_url = secondary_photo_url;
  if (order_amount !== undefined)       updates.order_amount = order_amount;
  if (visit_notes)                      updates.visit_notes = visit_notes;
  if (rejection_reason)                 updates.rejection_reason = rejection_reason;
  if (checkin_at)                       updates.checkin_at = checkin_at;
  if (checkout_at) {
    updates.checkout_at = checkout_at;
    // Calculate actual duration if checkin_at exists
    if (checkin_at) {
      const dur = Math.round((new Date(checkout_at).getTime() - new Date(checkin_at).getTime()) / 60000);
      if (dur > 0) updates.actual_duration_min = dur;
    }
  }

  const { data, error } = await supabase
    .from('route_plan_outlets')
    .update(updates)
    .eq('id', outletId)
    .select()
    .single();

  if (error)  return badRequest(res, error.message);
  if (!data)  return notFound(res, 'Outlet visit not found');
  return ok(res, data);
});

/* ─────────────────────────────────────────────────────────────
   POST /api/v1/route-plans/bulk-import
   Admin — bulk create route plans from parsed CSV/Excel rows
   Body: { plan_date, filename, rows: [{fe_employee_id, store_code, target_type, target_notes, target_value, visit_order}] }
───────────────────────────────────────────────────────────── */
export const bulkImportRoutePlans = asyncHandler(async (req: Request, res: Response) => {
  const org  = orgId(req);
  const by   = userId(req);
  const { plan_date, filename, rows } = req.body;

  if (!plan_date || !Array.isArray(rows) || rows.length === 0) {
    return badRequest(res, 'plan_date and rows[] are required');
  }

  // Create import log
  const { data: importLog, error: logErr } = await supabase
    .from('route_plan_imports')
    .insert({ org_id: org, imported_by: by, filename: filename || 'upload.csv', total_rows: rows.length, plan_date, status: 'processing' })
    .select()
    .single();

  if (logErr) return badRequest(res, logErr.message);

  // Fetch all FEs and stores for this org (for matching)
  const [{ data: fes }, { data: stores }] = await Promise.all([
    supabase.from('users').select('id, employee_id, name').eq('org_id', org).eq('role', 'executive'),
    supabase.from('stores').select('id, store_code, name').eq('org_id', org),
  ]);

  const feMap: Record<string, string>    = {};
  const storeMap: Record<string, string> = {};
  (fes || []).forEach((f: any)    => { if (f.employee_id) feMap[f.employee_id.toLowerCase()]   = f.id; });
  (stores || []).forEach((s: any) => { if (s.store_code)  storeMap[s.store_code.toLowerCase()] = s.id; });

  // Group rows by FE
  const byFE: Record<string, any[]> = {};
  const errorLog: any[] = [];
  let successRows = 0;

  rows.forEach((row: any, idx: number) => {
    const feKey    = String(row.fe_employee_id || '').toLowerCase().trim();
    const storeKey = String(row.store_code || '').toLowerCase().trim();

    if (!feMap[feKey]) {
      errorLog.push({ row: idx + 1, error: `FE not found: ${row.fe_employee_id}` });
      return;
    }
    if (!storeMap[storeKey]) {
      errorLog.push({ row: idx + 1, error: `Store not found: ${row.store_code}` });
      return;
    }
    if (!byFE[feMap[feKey]]) byFE[feMap[feKey]] = [];
    byFE[feMap[feKey]].push({ ...row, resolved_user_id: feMap[feKey], resolved_store_id: storeMap[storeKey] });
    successRows++;
  });

  // Upsert plans and outlets per FE and Activity
  for (const [fe_user_id, feRows] of Object.entries(byFE)) {
    // Group rows for this FE by Activity ID to handle multiple activities per day if needed
    const byActivity: Record<string, any[]> = {};
    feRows.forEach((r: any) => {
      const aid = r.activity_id || '';
      if (!byActivity[aid]) byActivity[aid] = [];
      byActivity[aid].push(r);
    });

    for (const [aid, actRows] of Object.entries(byActivity)) {
      if (!aid) {
        errorLog.push({ row: 'N/A', error: `Missing activity for FE ${fe_user_id}` });
        continue;
      }

      // FE-Activity mapping check removed as per user request

      // Insert plan (changed from upsert to allow multiple)
      const { data: plan, error: upsertErr } = await supabase
        .from('route_plans')
        .insert({ 
          org_id: org, 
          user_id: fe_user_id, 
          plan_date, 
          activity_id: aid,
          created_by: by, 
          total_outlets: actRows.length 
        })
        .select('id')
        .single();

      if (upsertErr || !plan) {
        errorLog.push({ row: 'N/A', error: `Failed to create plan: ${upsertErr?.message || 'Unknown error'}. Check for unique constraint if this is a duplicate.` });
        continue;
      }

      // Delete existing outlets for this specific plan
      await supabase.from('route_plan_outlets').delete().eq('route_plan_id', plan.id);

      // Insert new outlets
      const outletRows = actRows.map((r: any, i: number) => ({
        route_plan_id:       plan.id,
        store_id:            r.resolved_store_id,
        org_id:              org,
        visit_order:         r.visit_order ? Number(r.visit_order) : i + 1,
        target_type:         r.target_type || 'general',
        target_notes:        r.target_notes || null,
        target_value:        r.target_value ? Number(r.target_value) : null,
      }));

      await supabase.from('route_plan_outlets').insert(outletRows);
    }
  }

  // Update import log
  const finalStatus = errorLog.length === 0 ? 'completed' : successRows > 0 ? 'partial' : 'failed';
  await supabase.from('route_plan_imports')
    .update({ status: finalStatus, success_rows: successRows, failed_rows: errorLog.length, error_log: errorLog })
    .eq('id', importLog.id);

  return ok(res, { import_id: importLog.id, status: finalStatus, total: rows.length, success: successRows, failed: errorLog.length, errors: errorLog.slice(0, 20) });
});

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/route-plan/imports?date=YYYY-MM-DD
   Admin — list recent imports
───────────────────────────────────────────────────────────── */
export const getImports = asyncHandler(async (req: Request, res: Response) => {
  const org  = orgId(req);
  const date = (req.query.date as string) || today();

  const { data, error } = await supabase
    .from('route_plan_imports')
    .select('id, filename, total_rows, success_rows, failed_rows, status, plan_date, created_at, users(name)')
    .eq('org_id', org)
    .eq('plan_date', date)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return badRequest(res, error.message);
  return ok(res, data || []);
});

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/route-plan/outlet-frequency
   Admin — get all outlet visit frequency configs
───────────────────────────────────────────────────────────── */
export const getOutletFrequency = asyncHandler(async (req: Request, res: Response) => {
  const org = orgId(req);
  const { data, error } = await supabase
    .from('outlet_visit_frequency')
    .select('*, stores(name, store_code, address), users(name, employee_id)')
    .eq('org_id', org)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) return badRequest(res, error.message);
  return ok(res, data || []);
});
