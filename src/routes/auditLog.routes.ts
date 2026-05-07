/**
 * Activity Log read API. Super-admin only — returns every audit_log row
 * across the org, with actor name and client name resolved.
 */
import express, { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, forbidden, asyncHandler } from '../utils';

const router: Router = express.Router();

router.get('/', asyncHandler(async (req: AuthRequest, res) => {
  const role = req.user?.role?.toLowerCase();
  if (role !== 'super_admin') return forbidden(res, 'Super admin only');

  const limit  = Math.min(Number(req.query.limit  ?? 100), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  let q = supabaseAdmin
    .from('audit_log')
    .select('id, created_at, actor_user_id, actor_role, action, entity_table, entity_id, client_id, ip_address, metadata, after')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.action)        q = q.eq('action', String(req.query.action));
  if (req.query.entity_table)  q = q.eq('entity_table', String(req.query.entity_table));
  if (req.query.actor_user_id) q = q.eq('actor_user_id', String(req.query.actor_user_id));
  if (req.query.client_id)     q = q.eq('client_id', String(req.query.client_id));
  if (req.query.from)          q = q.gte('created_at', String(req.query.from));
  if (req.query.to)            q = q.lte('created_at', String(req.query.to));

  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);

  const actorIds  = Array.from(new Set((rows ?? []).map(r => r.actor_user_id).filter(Boolean) as string[]));
  const clientIds = Array.from(new Set((rows ?? []).map(r => r.client_id).filter(Boolean) as string[]));

  const [usersRes, clientsRes] = await Promise.all([
    actorIds.length
      ? supabaseAdmin.from('users').select('id, name, email, role').in('id', actorIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; email: string; role: string }> }),
    clientIds.length
      ? supabaseAdmin.from('clients').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
  ]);

  const usersById   = new Map((usersRes.data   ?? []).map(u => [u.id, u]));
  const clientsById = new Map((clientsRes.data ?? []).map(c => [c.id, c]));

  const enriched = (rows ?? []).map(r => ({
    id: r.id,
    created_at: r.created_at,
    action: r.action,
    entity_table: r.entity_table,
    entity_id: r.entity_id,
    actor: r.actor_user_id ? {
      id: r.actor_user_id,
      name:  usersById.get(r.actor_user_id)?.name  ?? null,
      email: usersById.get(r.actor_user_id)?.email ?? null,
      role:  r.actor_role,
    } : null,
    client: r.client_id ? {
      id: r.client_id,
      name: clientsById.get(r.client_id)?.name ?? null,
    } : null,
    ip_address: r.ip_address,
    metadata: r.metadata,
    payload: r.after,
  }));

  return ok(res, { rows: enriched, limit, offset, has_more: enriched.length === limit });
}));

export default router;
