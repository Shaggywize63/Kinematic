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
  isPlatformAdmin,
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
  res.json({ success: true, data: filtered.slice(0, 20) });
}));

// ── Threads ───────────────────────────────────────────────────────────────
router.get('/threads', wrap(async (req, res) => {
  const rows = await listThreads(req);
  res.json({ success: true, data: rows });
}));

router.post('/threads/dm', wrap(async (req, res) => {
  const { other_user_id } = (req.body || {}) as { other_user_id?: string };
  if (!other_user_id) return res.status(400).json({ message: 'other_user_id required' });
  const id = await createOrGetDmThread(req, other_user_id);
  res.status(201).json({ success: true, data: { id } });
}));

router.post('/threads/team', wrap(async (req, res) => {
  const { name, member_ids } = (req.body || {}) as { name?: string; member_ids?: string[] };
  const id = await createTeamThread(req, name || '', Array.isArray(member_ids) ? member_ids : []);
  res.status(201).json({ success: true, data: { id } });
}));

router.get('/threads/:id/messages', wrap(async (req, res) => {
  const rows = await listMessages(req, req.params.id, Number(req.query.limit) || 100);
  res.json({ success: true, data: rows });
}));

router.post('/threads/:id/messages', wrap(async (req, res) => {
  const { body, language } = (req.body || {}) as { body?: string; language?: string };
  const row = await sendMessage(req, req.params.id, body || '', language);
  res.status(201).json({ success: true, data: row });
}));

router.post('/threads/:id/read', wrap(async (req, res) => {
  await markThreadRead(req, req.params.id);
  res.status(204).end();
}));

// ── Web Push subscription mgmt ────────────────────────────────────────────
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ success: true, data: { publicKey: vapidPublicKey() } });
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
// Gated on the same isPlatformAdmin predicate the messaging service uses,
// so the dashboard's audit page and the messaging picker agree on "who
// is a platform operator". Rows are hydrated with org/thread/sender
// display names in one extra round-trip so the audit table reads like
// English instead of a wall of UUIDs.

function gatePlatformAdmin(req: AuthRequest, res: Response): boolean {
  if (isPlatformAdmin(req.user?.role as string, req.user?.name as string)) return true;
  res.status(403).json({ message: 'Platform admin only' });
  return false;
}

interface HydratedRefs {
  orgById: Map<string, string>;
  threadById: Map<string, { title: string; kind: string }>;
  userById: Map<string, string>;
}

async function hydrateRefs(orgIds: string[], threadIds: string[], userIds: string[]): Promise<HydratedRefs> {
  const orgById = new Map<string, string>();
  const threadById = new Map<string, { title: string; kind: string }>();
  const userById = new Map<string, string>();
  await Promise.all([
    (async () => {
      if (orgIds.length === 0) return;
      const { data } = await supabaseAdmin.from('organisations').select('id, name').in('id', orgIds);
      for (const r of (data ?? []) as any[]) orgById.set(r.id, (r.name as string) || 'Org');
    })(),
    (async () => {
      if (threadIds.length === 0) return;
      const { data: threads } = await supabaseAdmin
        .from('message_threads').select('id, kind, name').in('id', threadIds);
      // DM threads have no stored name — derive a title from the member
      // names so the audit row reads "Alice ↔ Bob" instead of just "DM".
      const { data: members } = await supabaseAdmin
        .from('message_thread_members').select('thread_id, user_id').in('thread_id', threadIds);
      const memberIdsByThread = new Map<string, string[]>();
      for (const m of (members ?? []) as any[]) {
        if (!memberIdsByThread.has(m.thread_id)) memberIdsByThread.set(m.thread_id, []);
        memberIdsByThread.get(m.thread_id)!.push(m.user_id);
      }
      const allUserIds = Array.from(new Set([...userIds, ...Array.from(memberIdsByThread.values()).flat()]));
      if (allUserIds.length > 0) {
        const { data: users } = await supabaseAdmin
          .from('users').select('id, name, email').in('id', allUserIds);
        for (const u of (users ?? []) as any[]) {
          userById.set(u.id, (u.name as string) || (u.email as string) || 'User');
        }
      }
      for (const t of (threads ?? []) as any[]) {
        if (t.kind === 'team') {
          threadById.set(t.id, { title: (t.name as string) || 'Team Chat', kind: 'team' });
        } else {
          const memberNames = (memberIdsByThread.get(t.id) ?? [])
            .map((id) => userById.get(id))
            .filter((n): n is string => !!n);
          const title = memberNames.length > 0 ? memberNames.join(' ↔ ') : 'Direct Message';
          threadById.set(t.id, { title, kind: 'dm' });
        }
      }
    })(),
  ]);
  return { orgById, threadById, userById };
}

router.get('/audit/messages', wrap(async (req, res) => {
  if (!gatePlatformAdmin(req, res)) return;
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
  const rows = (data ?? []) as any[];

  const refs = await hydrateRefs(
    Array.from(new Set(rows.map((r) => r.org_id))),
    Array.from(new Set(rows.map((r) => r.thread_id))),
    Array.from(new Set(rows.map((r) => r.sender_id))),
  );

  const hydrated = rows.map((r) => ({
    ...r,
    org_name:     refs.orgById.get(r.org_id) ?? null,
    thread_title: refs.threadById.get(r.thread_id)?.title ?? null,
    thread_kind:  refs.threadById.get(r.thread_id)?.kind ?? null,
    sender_name:  refs.userById.get(r.sender_id) ?? null,
  }));
  res.json({ success: true, data: hydrated });
}));

router.get('/audit/mentions', wrap(async (req, res) => {
  if (!gatePlatformAdmin(req, res)) return;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { data, error } = await supabaseAdmin
    .from('mentions')
    .select('id, org_id, source_kind, source_id, mentioner_id, mentioned_user_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ message: error.message });
  const rows = (data ?? []) as any[];
  const refs = await hydrateRefs(
    Array.from(new Set(rows.map((r) => r.org_id))),
    [],
    Array.from(new Set(rows.flatMap((r) => [r.mentioner_id, r.mentioned_user_id]))),
  );
  const hydrated = rows.map((r) => ({
    ...r,
    org_name:        refs.orgById.get(r.org_id) ?? null,
    mentioner_name:  refs.userById.get(r.mentioner_id) ?? null,
    mentioned_name:  refs.userById.get(r.mentioned_user_id) ?? null,
  }));
  res.json({ success: true, data: hydrated });
}));

// Full conversation view for the audit drill-down. Returns the thread
// metadata + every message (hydrated with sender names) so the dashboard
// can render the modal without further round-trips.
router.get('/audit/threads/:id', wrap(async (req, res) => {
  if (!gatePlatformAdmin(req, res)) return;
  const threadId = req.params.id;
  const { data: thread, error: te } = await supabaseAdmin
    .from('message_threads')
    .select('id, org_id, kind, name, created_at, last_message_at')
    .eq('id', threadId)
    .maybeSingle();
  if (te) return res.status(500).json({ message: te.message });
  if (!thread) return res.status(404).json({ message: 'Thread not found' });

  const { data: members } = await supabaseAdmin
    .from('message_thread_members').select('user_id').eq('thread_id', threadId);
  const memberIds = (members ?? []).map((m: any) => m.user_id as string);

  const { data: messages } = await supabaseAdmin
    .from('messages')
    .select('id, sender_id, body, language, created_at')
    .eq('thread_id', threadId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  const senderIds = Array.from(new Set((messages ?? []).map((m: any) => m.sender_id as string)));
  const userIds = Array.from(new Set([...memberIds, ...senderIds]));

  const userById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from('users').select('id, name, email').in('id', userIds);
    for (const u of (users ?? []) as any[]) {
      userById.set(u.id, (u.name as string) || (u.email as string) || 'User');
    }
  }
  const orgName = await supabaseAdmin
    .from('organisations').select('name').eq('id', (thread as any).org_id).maybeSingle()
    .then((r) => (r.data as any)?.name as string | undefined);

  const memberHydrated = memberIds.map((id) => ({ id, name: userById.get(id) || 'User' }));
  const title = (thread as any).kind === 'team'
    ? ((thread as any).name as string || 'Team Chat')
    : memberHydrated.map((m) => m.name).join(' ↔ ');

  res.json({
    success: true,
    data: {
      id: (thread as any).id,
      org_id: (thread as any).org_id,
      org_name: orgName ?? null,
      kind: (thread as any).kind,
      title,
      name: (thread as any).name,
      members: memberHydrated,
      created_at: (thread as any).created_at,
      last_message_at: (thread as any).last_message_at,
      messages: ((messages ?? []) as any[]).map((m) => ({
        id: m.id,
        sender_id: m.sender_id,
        sender_name: userById.get(m.sender_id) || 'User',
        body: m.body,
        language: m.language,
        created_at: m.created_at,
      })),
    },
  });
}));

export default router;
