/**
 * Messaging, mentions, web-push subscription routes.
 * Mounted at /api/v1/messaging AFTER requireAuth in app.ts.
 *
 * Every endpoint is org-scoped via req.user.org_id; mention/message
 * destinations are intersect-checked against the city ∩ hierarchy
 * scope helper in messaging.service.ts.
 */
import { Router, Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import {
  scopedUsers,
  listThreads,
  createOrGetDmThread,
  createTeamThread,
  listMessages,
  sendMessage,
  markThreadRead,
} from '../services/crm/messaging.service';
import { registerSubscription, unregisterSubscription, vapidPublicKey } from '../services/crm/webPush.service';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();

const wrap = (fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

// ── Mention picker — typeahead over the caller's scoped users ─────────────
router.get('/mentions/search', wrap(async (req, res) => {
  const q = String((req.query.q as string) || '').toLowerCase().trim();
  const users = await scopedUsers(req);
  const filtered = q
    ? users.filter((u) => (u.full_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
    : users;
  res.json({ data: filtered.slice(0, 20) });
}));

// ── Threads ───────────────────────────────────────────────────────────────
router.get('/threads', wrap(async (req, res) => {
  const rows = await listThreads(req);
  res.json({ data: rows });
}));

router.post('/threads/dm', wrap(async (req, res) => {
  const { other_user_id } = (req.body || {}) as { other_user_id?: string };
  if (!other_user_id) return res.status(400).json({ message: 'other_user_id required' });
  const id = await createOrGetDmThread(req, other_user_id);
  res.status(201).json({ data: { id } });
}));

router.post('/threads/team', wrap(async (req, res) => {
  const { name, member_ids } = (req.body || {}) as { name?: string; member_ids?: string[] };
  const id = await createTeamThread(req, name || '', Array.isArray(member_ids) ? member_ids : []);
  res.status(201).json({ data: { id } });
}));

router.get('/threads/:id/messages', wrap(async (req, res) => {
  const rows = await listMessages(req, req.params.id, Number(req.query.limit) || 100);
  res.json({ data: rows });
}));

router.post('/threads/:id/messages', wrap(async (req, res) => {
  const { body, language } = (req.body || {}) as { body?: string; language?: string };
  const row = await sendMessage(req, req.params.id, body || '', language);
  res.status(201).json({ data: row });
}));

router.post('/threads/:id/read', wrap(async (req, res) => {
  await markThreadRead(req, req.params.id);
  res.status(204).end();
}));

// ── Web Push subscription mgmt ────────────────────────────────────────────
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ data: { publicKey: vapidPublicKey() } });
});

router.post('/push/subscribe', wrap(async (req, res) => {
  const me = req.user!;
  const { endpoint, keys, user_agent } = (req.body || {}) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    user_agent?: string;
  };
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ message: 'endpoint + keys required' });
  }
  await registerSubscription(me.id, me.org_id, endpoint, keys.p256dh, keys.auth, user_agent);
  res.status(201).json({ ok: true });
}));

router.delete('/push/subscribe', wrap(async (req, res) => {
  const me = req.user!;
  const endpoint = String((req.body as any)?.endpoint || (req.query.endpoint as string) || '');
  if (!endpoint) return res.status(400).json({ message: 'endpoint required' });
  await unregisterSubscription(me.id, endpoint);
  res.status(204).end();
}));

// ── Super-admin audit — every message across every org ────────────────────
// Gated on the same super-admin role check used elsewhere; without it
// returns 403 even though service-role can technically read everything.
router.get('/audit/messages', wrap(async (req, res) => {
  const role = (req.user?.role || '').toLowerCase().replace(/-/g, '_');
  if (role !== 'super_admin') return res.status(403).json({ message: 'Super admin only' });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const sinceParam = req.query.since as string | undefined;
  let q = supabaseAdmin
    .from('messages')
    .select('id, org_id, thread_id, sender_id, body, language, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (sinceParam) q = q.gte('created_at', sinceParam);
  const { data, error } = await q;
  if (error) return res.status(500).json({ message: error.message });
  res.json({ data: data ?? [] });
}));

router.get('/audit/mentions', wrap(async (req, res) => {
  const role = (req.user?.role || '').toLowerCase().replace(/-/g, '_');
  if (role !== 'super_admin') return res.status(403).json({ message: 'Super admin only' });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { data, error } = await supabaseAdmin
    .from('mentions')
    .select('id, org_id, source_kind, source_id, mentioner_id, mentioned_user_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ message: error.message });
  res.json({ data: data ?? [] });
}));

export default router;
