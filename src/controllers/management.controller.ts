import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { ok, created, badRequest, notFound } from '../utils/response';

// Tables that use org_id (IMPORTANT)
const ORG_TABLES = ['cities', 'stores', 'skus', 'assets', 'activities'];
// 👉 cities intentionally excluded unless your DB has org_id

function hasOrg(table: string) {
  return ORG_TABLES.includes(table);
}

// Helper: select fields
function getSelect(table: string): string {
  if (table === 'stores') return '*, zones(name), cities(name)';
  return '*';
}

// Generic CRUD builder
export function buildCRUD(tableName: string, requiredFields: string[] = ['name']) {

  const list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user;
    if (!user) return badRequest(res, 'Unauthorized');

    let query = supabaseAdmin
      .from(tableName)
      .select(getSelect(tableName))
      .order('created_at', { ascending: false });

    if (hasOrg(tableName)) {
      query = query.eq('org_id', user.org_id);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`❌ LIST ERROR [${tableName}]`, error);
      return badRequest(res, error.message);
    }

    return ok(res, data || []);
  });

  const getOne = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user;
    if (!user) return badRequest(res, 'Unauthorized');

    const { id } = req.params;

    let query = supabaseAdmin
      .from(tableName)
      .select('*')
      .eq('id', id);

    if (hasOrg(tableName)) {
      query = query.eq('org_id', user.org_id);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return notFound(res, `${tableName} record not found`);
    }

    return ok(res, data);
  });

  const create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user;
    if (!user) return badRequest(res, 'Unauthorized');

    const body = req.body;

    for (const f of requiredFields) {
      if (!body[f]) return badRequest(res, `${f} is required`);
    }

   const payload = {
  ...body,
  org_id: user.org_id
};

    const { data, error } = await supabaseAdmin
      .from(tableName)
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error(`❌ CREATE ERROR [${tableName}]`, error);
      return badRequest(res, error.message);
    }

    return created(res, data);
  });

  const update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user;
    if (!user) return badRequest(res, 'Unauthorized');

    const { id } = req.params;
    const { org_id, ...rest } = req.body;

    let query = supabaseAdmin
      .from(tableName)
      .update({
        ...rest,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (hasOrg(tableName)) {
      query = query.eq('org_id', user.org_id);
    }

    const { data, error } = await query.select().single();

    if (error) {
      console.error(`❌ UPDATE ERROR [${tableName}]`, error);
      return badRequest(res, error.message);
    }

    if (!data) {
      return notFound(res, `${tableName} record not found`);
    }

    return ok(res, data);
  });

  const remove = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user;
    if (!user) return badRequest(res, 'Unauthorized');

    const { id } = req.params;

    let query = supabaseAdmin
      .from(tableName)
      .delete()
      .eq('id', id);

    if (hasOrg(tableName)) {
      query = query.eq('org_id', user.org_id);
    }

    const { error } = await query;

    if (error) {
      console.error(`❌ DELETE ERROR [${tableName}]`, error);
      return badRequest(res, error.message);
    }

    return ok(res, { deleted: true });
  });

  return { list, getOne, create, update, remove };
}

// Controllers
export const citiesCtrl     = buildCRUD('cities', ['name']);
export const storesCtrl     = buildCRUD('stores', ['name']);
export const skusCtrl       = buildCRUD('skus', ['sku_code', 'name']);
export const assetsCtrl     = buildCRUD('assets', ['name']);
export const activitiesCtrl = buildCRUD('activities', ['name']);
