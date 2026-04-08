// ── ADD TO src/app.ts (route registrations) ──────────────────────────────────
// import citiesRouter   from './routes/cities.routes';
// import storesRouter   from './routes/stores.routes';
// import skusRouter     from './routes/skus.routes';
// import assetsRouter   from './routes/assets.routes';
//
// app.use('/api/v1/cities',    citiesRouter);
// app.use('/api/v1/stores',    storesRouter);
// app.use('/api/v1/skus',      skusRouter);
// app.use('/api/v1/assets',    assetsRouter);

// ═══════════════════════════════════════════════════════════
// src/controllers/management.controller.ts
// Generic CRUD controller for cities, stores, skus, assets
// ═══════════════════════════════════════════════════════════
import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../utils';
import { DEMO_ORG_ID, getMockCities, getMockStores, getMockActivities } from '../utils/demoData';

// ─── Helper: build a generic CRUD controller for a table ───
export function buildCRUD(tableName: string, requiredFields: string[] = ['name']) {

  const list = asyncHandler<AuthRequest>(async (req, res) => {
    const user = req.user!;

    let q = supabaseAdmin
      .from(tableName)
      .select(getSelect(tableName))
      .eq('org_id', user.org_id);

    if (user.client_id) q = q.eq('client_id', user.client_id);

    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) { badRequest(res, error.message); return; }
    ok(res, data || []);
  });

  const getOne = asyncHandler<AuthRequest>(async (req, res) => {
    const user = req.user!;
    const { id } = req.params;
    let q = supabaseAdmin
      .from(tableName).select('*').eq('id', id).eq('org_id', user.org_id);
    
    if (user.client_id) q = q.eq('client_id', user.client_id);
    
    const { data, error } = await q.single();
    if (error || !data) { notFound(res, `${tableName} record not found`); return; }
    ok(res, data);
  });

  const create = asyncHandler<AuthRequest>(async (req, res) => {
    const user = req.user!;
    const body = req.body;
    for (const f of requiredFields) {
      if (!body[f]) { badRequest(res, `${f} is required`); return; }
    }
    const payload = { 
      ...body, 
      org_id: user.org_id, 
      client_id: body.client_id || user.client_id || null 
    };
    const { data, error } = await supabaseAdmin.from(tableName).insert(payload).select().single();
    if (error) { badRequest(res, error.message); return; }
    created(res, data);
  });

  const update = asyncHandler<AuthRequest>(async (req, res) => {
    const user = req.user!;
    const { id } = req.params;
    const { org_id, client_id: _, ...rest } = req.body; // strip sensitive IDs
    let q = supabaseAdmin
      .from(tableName).update({ ...rest, updated_at: new Date().toISOString() })
      .eq('id', id).eq('org_id', user.org_id);
    
    if (user.client_id) q = q.eq('client_id', user.client_id);
    
    const { data, error } = await q.select().single();
    if (error) { badRequest(res, error.message); return; }
    if (!data) { notFound(res, `${tableName} record not found`); return; }
    ok(res, data);
  });

  const remove = asyncHandler<AuthRequest>(async (req, res) => {
    const user = req.user!;
    
    // Restriction: Ensure the record belongs to the user's org/client
    const { id } = req.params;
    let q = supabaseAdmin
      .from(tableName).delete().eq('id', id).eq('org_id', user.org_id);
    
    if (user.client_id) q = q.eq('client_id', user.client_id);
    
    const { error } = await q;
    if (error) { badRequest(res, error.message); return; }
    ok(res, { deleted: true });
  });

  return { list, getOne, create, update, remove };
}

function getSelect(table: string): string {
  if (table === 'stores') return '*, zones!zone_id(name), cities!city_id(name)';
  if (table === 'cities') return '*, clients:client_id(name)';
  return '*';
}

// ── Export individual controllers ──
export const citiesCtrl   = buildCRUD('cities',   ['name', 'state']);
export const storesCtrl   = buildCRUD('stores',   ['name']);
export const skusCtrl     = buildCRUD('skus',     ['sku_code', 'name']);
export const assetsCtrl   = buildCRUD('assets',   ['name']);
export const activitiesCtrl = buildCRUD('activities', ['name']);
