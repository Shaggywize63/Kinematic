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
import { asyncHandler, ok, created, badRequest, notFound, isUUID } from '../utils';
import { DEMO_ORG_ID, isDemo, getMockCities, getMockStores, getMockActivities } from '../utils/demoData';

interface CrudOpts {
  /**
   * When true, READ operations (list/getOne) return rows that are EITHER
   * tenant-scoped (`client_id = picker`) OR org-shared reference data
   * (`client_id IS NULL`). Writes still respect strict tenant scoping.
   *
   * Used for reference tables like `cities` where the 868 India-wide rows
   * are seeded with `client_id=NULL` and every client should see them
   * alongside any custom cities they add themselves. Default `false` —
   * stores / skus / assets / activities stay strictly tenant-isolated.
   */
  sharedWithOwn?: boolean;
}

// ─── Helper: build a generic CRUD controller for a table ───
export function buildCRUD(tableName: string, requiredFields: string[] = ['name'], opts: CrudOpts = {}) {

  const list = asyncHandler<AuthRequest>(async (req, res) => {
    const user = req.user!;
    if (isDemo(user)) {
      if (tableName === 'cities') return ok(res, getMockCities());
      if (tableName === 'stores') return ok(res, getMockStores());
      if (tableName === 'activities') return ok(res, getMockActivities());
      return ok(res, []);
    }

    let q = supabaseAdmin
      .from(tableName)
      .select(getSelect(tableName))
      .eq('org_id', user.org_id);

    // Tenant scoping precedence (mirrors getUsers in misc.controller.ts):
    //   1. JWT client_id  — client-pinned users stay in their tenant.
    //   2. ?client_id=    — explicit query param override (e.g. server-to-server).
    //   3. X-Client-Id    — global client picker, auto-attached by dashboard api.ts.
    //   4. none           — platform admin with no picker → see all in org.
    //
    // For tables flagged `sharedWithOwn` (e.g. `cities`), the filter also
    // includes org-level reference rows (`client_id IS NULL`) so every
    // client sees the India seed data + their own custom rows.
    const headerClientId = (req.headers['x-client-id'] as string | undefined) || undefined;
    const targetCid: string | null = isUUID(user.client_id) ? (user.client_id as string)
      : isUUID(req.query.client_id as string) ? (req.query.client_id as string)
      : isUUID(headerClientId) ? (headerClientId as string)
      : null;

    if (targetCid) {
      q = opts.sharedWithOwn
        ? q.or(`client_id.is.null,client_id.eq.${targetCid}`)
        : q.eq('client_id', targetCid);
    }

    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) { badRequest(res, error.message); return; }
    ok(res, data || []);
  });

  const getOne = asyncHandler<AuthRequest>(async (req, res) => {
    const { id } = req.params;
    const user = req.user!;
    if (isDemo(user)) {
       // Return something generic or from mock list
       const mock = (tableName === 'cities' ? getMockCities() : (tableName === 'stores' ? getMockStores() : (tableName === 'activities' ? getMockActivities() : []))) as any[];
       const record = mock.find(m => m.id === id) || mock[0];
       return ok(res, record);
    }
    if (!isUUID(id)) { notFound(res, `${tableName} record not found`); return; }
    let q = supabaseAdmin
      .from(tableName).select('*').eq('id', id).eq('org_id', user.org_id);

    const headerClientId = (req.headers['x-client-id'] as string | undefined) || undefined;
    const targetCid: string | null = isUUID(user.client_id) ? (user.client_id as string)
      : isUUID(req.query.client_id as string) ? (req.query.client_id as string)
      : isUUID(headerClientId) ? (headerClientId as string)
      : null;

    if (targetCid) {
      q = opts.sharedWithOwn
        ? q.or(`client_id.is.null,client_id.eq.${targetCid}`)
        : q.eq('client_id', targetCid);
    }

    const { data, error } = await q.single();
    if (error || !data) { notFound(res, `${tableName} record not found`); return; }
    ok(res, data);
  });

  const create = asyncHandler<AuthRequest>(async (req, res) => {
    const user = req.user!;
    if (isDemo(user)) return created(res, { id: 'demo-new-id', ...req.body }, 'Created (Demo)');
    const body = req.body;
    for (const f of requiredFields) {
      if (!body[f]) { badRequest(res, `${f} is required`); return; }
    }
    // Stamp the new record with the correct tenant. Priority matches the
    // list/update/remove precedence above so a platform admin creating a
    // city while browsing "Tata Tiscon" gets a Tata-scoped row instead of
    // a client_id=null ghost that nobody can find.
    const headerClientId = (req.headers['x-client-id'] as string | undefined) || undefined;
    const pickedClientId =
      isUUID(body.client_id as string) ? (body.client_id as string)
      : isUUID(headerClientId)          ? headerClientId
      : (isUUID(user.client_id) ? user.client_id : null);

    const payload = {
      ...body,
      org_id: user.org_id,
      client_id: pickedClientId,
    };
    const { data, error } = await supabaseAdmin.from(tableName).insert(payload).select().single();
    if (error) { badRequest(res, error.message); return; }
    created(res, data);
  });

  const update = asyncHandler<AuthRequest>(async (req, res) => {
    const { id } = req.params;
    const user = req.user!;
    if (isDemo(user)) return ok(res, { id, ...req.body }, 'Updated (Demo)');
    if (!isUUID(id)) { notFound(res, `${tableName} record not found`); return; }
    const { org_id, client_id: _, ...rest } = req.body; // strip sensitive IDs
    let q = supabaseAdmin
      .from(tableName).update({ ...rest, updated_at: new Date().toISOString() })
      .eq('id', id).eq('org_id', user.org_id);

    // Writes stay STRICT — even for `sharedWithOwn` tables. A client can't
    // edit the global rows (`client_id IS NULL`); only platform admins
    // with no picker selected can modify those.
    const headerClientId = (req.headers['x-client-id'] as string | undefined) || undefined;
    if (isUUID(user.client_id)) {
      q = q.eq('client_id', user.client_id);
    } else if (isUUID(req.query.client_id as string)) {
      q = q.eq('client_id', req.query.client_id as string);
    } else if (isUUID(headerClientId)) {
      q = q.eq('client_id', headerClientId);
    }

    const { data, error } = await q.select().single();
    if (error) { badRequest(res, error.message); return; }
    if (!data) { notFound(res, `${tableName} record not found`); return; }
    ok(res, data);
  });

  const remove = asyncHandler<AuthRequest>(async (req, res) => {
    const { id } = req.params;
    const user = req.user!;
    if (isDemo(user)) return ok(res, { deleted: true }, 'Deleted (Demo)');
    
    if (!isUUID(id)) { notFound(res, `${tableName} record not found`); return; }
    let q = supabaseAdmin
      .from(tableName).delete().eq('id', id).eq('org_id', user.org_id);

    // Same as update — deletes are strict so clients can't accidentally
    // remove org-shared reference rows.
    const headerClientId = (req.headers['x-client-id'] as string | undefined) || undefined;
    if (isUUID(user.client_id)) {
      q = q.eq('client_id', user.client_id);
    } else if (isUUID(req.query.client_id as string)) {
      q = q.eq('client_id', req.query.client_id as string);
    } else if (isUUID(headerClientId)) {
      q = q.eq('client_id', headerClientId);
    }

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
// `cities` is reference data (868 India rows seeded with client_id=NULL).
// Every client sees the global set + their own additions; only platform
// admins (no picker) can edit/delete the shared rows. Other resources
// stay strictly tenant-isolated.
export const citiesCtrl   = buildCRUD('cities',     ['name', 'state'], { sharedWithOwn: true });
export const storesCtrl   = buildCRUD('stores',     ['name']);
export const skusCtrl     = buildCRUD('skus',       ['sku_code', 'name']);
export const assetsCtrl   = buildCRUD('assets',     ['name']);
export const activitiesCtrl = buildCRUD('activities', ['name']);
