/**
 * Org-defined role hierarchy management.
 *
 * GET    /         list all roles for the org (flat)
 * GET    /tree     hierarchical tree (root nodes with nested children)
 * GET    /:id      single role
 * POST   /         create role { name, parent_id?, description?, color? }
 * PATCH  /:id      update (rename, move, recolor)
 * DELETE /:id      soft-delete; children are reparented to deleted node's parent
 * POST   /reorder  reorder siblings under a parent
 * GET    /:id/users  users assigned to this role (direct members only)
 */
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import { z, ZodError } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AppError } from '../utils';

const router: Router = express.Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

function orgId(req: Request): string {
  const r = req as Request & { user?: { org_id?: string } };
  const id = r.user?.org_id ?? (req.headers['x-org-id'] as string | undefined);
  if (!id) throw new AppError(400, 'No org context on request', 'NO_ORG');
  return String(id);
}
function userId(req: Request): string | undefined {
  const r = req as Request & { user?: { id?: string } };
  return r.user?.id;
}
// Multi-tenant: client_id scopes role hierarchies within an org. Client-level
// users are pinned by their JWT; org-level admins can override via X-Client-Id
// header (set by the dashboard's global client picker).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function clientId(req: Request): string | null {
  const r = req as Request & { user?: { client_id?: string | null } };
  if (r.user?.client_id) return r.user.client_id;
  const headerVal = (req.headers['x-client-id'] as string | undefined)?.trim();
  if (headerVal && UUID_RE.test(headerVal)) return headerVal;
  return null;
}
function parse<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  try { return schema.parse(payload); }
  catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new AppError(400, `Validation failed: ${issues}`, 'VALIDATION');
    }
    throw e;
  }
}

const uuid = z.string().uuid();
const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  parent_id: uuid.nullish(),
  color: z.string().max(20).optional().nullable(),
  position: z.number().int().nonnegative().optional(),
});
const updateSchema = createSchema.partial();
const reorderSchema = z.object({
  parent_id: uuid.nullish(),
  ids: z.array(uuid),
});

// Build a Supabase query that returns rows visible at the caller's scope.
// LIST: client-level rows + org-level (NULL client_id) rows act as defaults.
function scopedSelect(req: Request) {
  const cid = clientId(req);
  let q = supabaseAdmin
    .from('org_roles')
    .select('*')
    .eq('org_id', orgId(req))
    .is('deleted_at', null);
  // Hard isolation: client picker scopes to that client; org admin (no client picked) sees everything.
  if (cid) q = q.eq('client_id', cid);
  return q.order('position', { ascending: true }).order('created_at', { ascending: true });
}

// GET / — flat list
router.get('/', wrap(async (req, res) => {
  const { data, error } = await scopedSelect(req);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  // Stamp user counts (direct members) — also scope by client_id when set so
  // the org-level row's count doesn't accidentally include other clients' users.
  const cid = clientId(req);
  let cQ = supabaseAdmin
    .from('users')
    .select('org_role_id')
    .eq('org_id', orgId(req))
    .not('org_role_id', 'is', null);
  if (cid) cQ = cQ.eq('client_id', cid);
  const { data: counts } = await cQ;
  const countMap = new Map<string, number>();
  for (const u of counts ?? []) {
    const id = (u as any).org_role_id as string;
    countMap.set(id, (countMap.get(id) ?? 0) + 1);
  }
  res.json((data ?? []).map((r: any) => ({ ...r, user_count: countMap.get(r.id) ?? 0 })));
}));

// GET /tree — hierarchical
router.get('/tree', wrap(async (req, res) => {
  const { data, error } = await scopedSelect(req);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  const cid = clientId(req);
  let cQ = supabaseAdmin
    .from('users')
    .select('org_role_id')
    .eq('org_id', orgId(req))
    .not('org_role_id', 'is', null);
  if (cid) cQ = cQ.eq('client_id', cid);
  const { data: counts } = await cQ;
  const countMap = new Map<string, number>();
  for (const u of counts ?? []) {
    const id = (u as any).org_role_id as string;
    countMap.set(id, (countMap.get(id) ?? 0) + 1);
  }

  const byId = new Map<string, any>();
  for (const r of data ?? []) {
    byId.set(r.id, { ...r, user_count: countMap.get(r.id) ?? 0, children: [] });
  }
  const roots: any[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  res.json(roots);
}));

// GET /:id
router.get('/:id', wrap(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('org_roles')
    .select('*')
    .eq('id', req.params.id)
    .eq('org_id', orgId(req))
    .is('deleted_at', null)
    .single();
  if (error || !data) throw new AppError(404, 'Role not found', 'NOT_FOUND');
  res.json(data);
}));

// POST /
router.post('/', wrap(async (req, res) => {
  const body = parse(createSchema, req.body);
  const cid = clientId(req);
  // Compute next position among siblings (within same client scope) if not provided.
  let position = body.position;
  if (position === undefined) {
    let sibQ = supabaseAdmin
      .from('org_roles')
      .select('position')
      .eq('org_id', orgId(req))
      .is('deleted_at', null);
    if (body.parent_id) sibQ = sibQ.eq('parent_id', body.parent_id);
    else sibQ = sibQ.is('parent_id', null);
    if (cid) sibQ = sibQ.eq('client_id', cid);
    else sibQ = sibQ.is('client_id', null);
    const { data: siblings } = await sibQ;
    position = (siblings ?? []).reduce((m: number, r: any) => Math.max(m, r.position ?? 0), -1) + 1;
  }
  const insertRow = {
    org_id: orgId(req),
    client_id: cid,
    name: body.name.trim(),
    description: body.description ?? null,
    parent_id: body.parent_id ?? null,
    color: body.color ?? '#6366f1',
    position,
    created_by: userId(req) ?? null,
  };
  const { data, error } = await supabaseAdmin.from('org_roles').insert(insertRow).select('*').single();
  if (error) {
    if (String(error.code) === '23505') throw new AppError(409, `A role named "${body.name}" already exists`, 'DUPLICATE');
    throw new AppError(500, error.message, 'DB_ERROR');
  }
  res.status(201).json({ ...data, user_count: 0 });
}));

// PATCH /:id
router.patch('/:id', wrap(async (req, res) => {
  const body = parse(updateSchema, req.body);
  // Prevent setting parent to self or to a descendant (would create a cycle).
  if (body.parent_id && body.parent_id === req.params.id) {
    throw new AppError(400, 'A role cannot be its own parent', 'CYCLE');
  }
  if (body.parent_id) {
    // Cycle check: walk only within visible scope (same client + org-level
    // defaults) to ensure the proposed parent doesn't end up under us.
    const cid = clientId(req);
    let q = supabaseAdmin
      .from('org_roles')
      .select('id, parent_id')
      .eq('org_id', orgId(req))
      .is('deleted_at', null);
    // Hard isolation: cycle check walks within the active client's scope only.
    if (cid) q = q.eq('client_id', cid);
    const { data: rows } = await q;
    const byId = new Map<string, string | null>();
    for (const r of rows ?? []) byId.set((r as any).id, (r as any).parent_id ?? null);
    let walker: string | null = body.parent_id;
    const seen = new Set<string>();
    while (walker) {
      if (walker === req.params.id) {
        throw new AppError(400, 'Cannot move a role under one of its own descendants', 'CYCLE');
      }
      if (seen.has(walker)) break;
      seen.add(walker);
      walker = byId.get(walker) ?? null;
    }
  }

  const update: Record<string, unknown> = { updated_by: userId(req) ?? null };
  if (body.name !== undefined) update.name = body.name.trim();
  if (body.description !== undefined) update.description = body.description;
  if (body.parent_id !== undefined) update.parent_id = body.parent_id;
  if (body.color !== undefined) update.color = body.color;
  if (body.position !== undefined) update.position = body.position;

  const { data, error } = await supabaseAdmin
    .from('org_roles')
    .update(update)
    .eq('id', req.params.id)
    .eq('org_id', orgId(req))
    .select('*')
    .single();
  if (error) {
    if (String(error.code) === '23505') throw new AppError(409, 'A role with that name already exists', 'DUPLICATE');
    throw new AppError(500, error.message, 'DB_ERROR');
  }
  res.json(data);
}));

// DELETE /:id — soft delete; reparent any children to this role's parent so the tree doesn't lose them.
router.delete('/:id', wrap(async (req, res) => {
  const { data: target } = await supabaseAdmin
    .from('org_roles')
    .select('parent_id')
    .eq('id', req.params.id)
    .eq('org_id', orgId(req))
    .is('deleted_at', null)
    .maybeSingle();
  if (!target) throw new AppError(404, 'Role not found', 'NOT_FOUND');

  // Reparent direct children
  await supabaseAdmin
    .from('org_roles')
    .update({ parent_id: (target as any).parent_id ?? null })
    .eq('parent_id', req.params.id)
    .eq('org_id', orgId(req));

  const { error } = await supabaseAdmin
    .from('org_roles')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('org_id', orgId(req));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.status(204).end();
}));

// POST /reorder — body: { parent_id, ids: [uuid in new order] }
router.post('/reorder', wrap(async (req, res) => {
  const body = parse(reorderSchema, req.body);
  await Promise.all(body.ids.map((id, i) =>
    supabaseAdmin
      .from('org_roles')
      .update({ position: i })
      .eq('id', id)
      .eq('org_id', orgId(req)),
  ));
  res.json({ ok: true });
}));

// GET /:id/users — users directly assigned to this role
router.get('/:id/users', wrap(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role')
    .eq('org_id', orgId(req))
    .eq('org_role_id', req.params.id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json(data ?? []);
}));

export default router;
