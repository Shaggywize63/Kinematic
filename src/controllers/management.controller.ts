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
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { ok, created, badRequest, notFound } from '../utils/response';

// ─── Helper: build a generic CRUD controller for a table ───
export function buildCRUD(tableName: string, requiredFields: string[] = ['name']) {

  const list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .select(getSelect(tableName))
      .eq('org_id', user.org_id)
      .order('created_at', { ascending: false });
    if (error) return badRequest(res, error.message);
    return ok(res, data || []);
  });

  const getOne = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from(tableName).select('*').eq('id', id).eq('org_id', user.org_id).single();
    if (error || !data) return notFound(res, `${tableName} record not found`);
    return ok(res, data);
  });

  const create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const body = req.body;
    for (const f of requiredFields) {
      if (!body[f]) return badRequest(res, `${f} is required`);
    }
    const payload = { ...body, org_id: user.org_id };
    const { data, error } = await supabaseAdmin.from(tableName).insert(payload).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data);
  });

  const update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { org_id, ...rest } = req.body; // strip org_id
    const { data, error } = await supabaseAdmin
      .from(tableName).update({ ...rest, updated_at: new Date().toISOString() })
      .eq('id', id).eq('org_id', user.org_id).select().single();
    if (error) return badRequest(res, error.message);
    if (!data) return notFound(res, `${tableName} record not found`);
    return ok(res, data);
  });

  const remove = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from(tableName).delete().eq('id', id).eq('org_id', user.org_id);
    if (error) return badRequest(res, error.message);
    return ok(res, { deleted: true });
  });

  return { list, getOne, create, update, remove };
}

function getSelect(table: string): string {
  if (table === 'stores') return '*, zones(name), cities(name)';
  return '*';
}

// ── Export individual controllers ──
export const citiesCtrl   = buildCRUD('cities',   ['name']);
export const storesCtrl   = buildCRUD('stores',   ['name']);
export const skusCtrl     = buildCRUD('skus',     ['sku_code', 'name']);
export const assetsCtrl   = buildCRUD('assets',   ['name']);
export const activitiesCtrl = buildCRUD('activities', ['name']);
