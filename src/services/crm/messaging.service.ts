/**
 * Messaging + @mentions + scope helper.
 *
 * Scope rule (locked in with the product owner): a user can mention or
 * message another user IFF they
 *   1. share at least one city (via user_city_assignments), AND
 *   2. fall in the same hierarchy subtree (caller's descendants OR caller's
 *      ancestor chain — i.e. anyone in the caller's chain in either direction).
 *
 * Both conditions must hold. A Mumbai rep can't tag a Mumbai rep from another
 * team; a Delhi manager can't tag a Mumbai team member even if they share a
 * common boss. The intersection is the right answer for both /mentions and
 * /threads/create. Service-role bypasses RLS so this is the only enforcement
 * gate.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { AuthRequest } from '../../types';

export type SourceKind = 'lead_update' | 'activity' | 'message';

// ─────────────────────────────────────────────────────────────────────
// Scope helper
// ─────────────────────────────────────────────────────────────────────

interface ScopedUser {
  id: string;
  full_name: string | null;
  email: string;
  city_names: string[];
}

/**
 * The set of users a given user can mention or message. The caller is
 * always included so reps can self-reference (and so the FE picker can
 * show a "Me" entry without a separate code path).
 *
 * Super-admins bypass scope entirely — they can mention/message anyone
 * in the system across every org. The platform-admin role is meant for
 * operators who need to reach any tenant for support reasons.
 */
export async function scopedUsers(req: AuthRequest): Promise<ScopedUser[]> {
  const me = req.user;
  if (!me) throw new AppError(401, 'Not authenticated', 'NO_USER');
  const role = ((me.role as string) || '').toLowerCase().replace(/-/g, '_');
  if (role === 'super_admin') {
    return scopedUsersForSuperAdmin();
  }
  const myId = me.id;
  const orgId = me.org_id;
  const myCities = Array.isArray(me.assigned_city_names) ? me.assigned_city_names : [];

  // 1. Hierarchy: descendants via the user_subtree_ids RPC + ancestors via
  //    iterative supervisor_id walk. The RPC handles the common "my team"
  //    case; ancestors are needed so a rep can tag their own manager.
  const [descendants, ancestors] = await Promise.all([
    fetchDescendantIds(myId),
    fetchAncestorIds(myId),
  ]);
  const hierarchyIds = new Set<string>([myId, ...descendants, ...ancestors]);

  // 2. Pull every candidate user in the org, then intersect on city.
  const { data: rows, error } = await supabaseAdmin
    .from('users')
    .select('id, full_name, email')
    .eq('org_id', orgId)
    .in('id', Array.from(hierarchyIds));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const candidates = (rows ?? []) as Array<{ id: string; full_name: string | null; email: string }>;

  if (candidates.length === 0) return [];

  // 3. Resolve each candidate's cities. Self always passes the city check
  //    (you can always reach yourself); for everyone else we require at
  //    least one shared city. If the caller has no cities assigned, fall
  //    back to org-wide visibility (matches the existing leads list
  //    fallback when no city scope is set).
  const candidateIds = candidates.map((c) => c.id);
  const { data: assignmentRows } = await supabaseAdmin
    .from('user_city_assignments')
    .select('user_id, cities!city_id(name)')
    .in('user_id', candidateIds);

  const candidateCities = new Map<string, Set<string>>();
  for (const row of (assignmentRows ?? []) as any[]) {
    const uid = row.user_id as string;
    const cityName = (row.cities?.name as string) || '';
    if (!cityName) continue;
    if (!candidateCities.has(uid)) candidateCities.set(uid, new Set());
    candidateCities.get(uid)!.add(cityName);
  }

  const myCitySet = new Set(myCities);
  const result: ScopedUser[] = [];
  for (const c of candidates) {
    if (c.id === myId) {
      result.push({ id: c.id, full_name: c.full_name, email: c.email, city_names: Array.from(candidateCities.get(c.id) ?? []) });
      continue;
    }
    const theirCities = candidateCities.get(c.id) ?? new Set();
    // "No cities on caller" = org-wide reach (matches the leads-list
    // fallback). Otherwise we need a non-empty intersection.
    const cityOk = myCitySet.size === 0 || Array.from(theirCities).some((city) => myCitySet.has(city));
    if (!cityOk) continue;
    result.push({ id: c.id, full_name: c.full_name, email: c.email, city_names: Array.from(theirCities) });
  }
  return result;
}

async function scopedUsersForSuperAdmin(): Promise<ScopedUser[]> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, full_name, email')
    .order('full_name', { ascending: true })
    .limit(2000);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const candidates = (data ?? []) as Array<{ id: string; full_name: string | null; email: string }>;
  if (candidates.length === 0) return [];
  const { data: assignmentRows } = await supabaseAdmin
    .from('user_city_assignments')
    .select('user_id, cities!city_id(name)')
    .in('user_id', candidates.map((c) => c.id));
  const cityMap = new Map<string, string[]>();
  for (const row of (assignmentRows ?? []) as any[]) {
    const uid = row.user_id as string;
    const cityName = (row.cities?.name as string) || '';
    if (!cityName) continue;
    if (!cityMap.has(uid)) cityMap.set(uid, []);
    cityMap.get(uid)!.push(cityName);
  }
  return candidates.map((c) => ({
    id: c.id,
    full_name: c.full_name,
    email: c.email,
    city_names: cityMap.get(c.id) ?? [],
  }));
}

async function fetchDescendantIds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.rpc('user_subtree_ids', { p_user_id: userId });
  if (error) return [];
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id).filter((id) => id !== userId);
}

async function fetchAncestorIds(userId: string): Promise<string[]> {
  // Walk supervisor_id up to a sane depth limit so a cyclic data error
  // never spins forever. Real-world hierarchies don't exceed 8–10 levels.
  const ancestors: string[] = [];
  let current = userId;
  for (let i = 0; i < 12; i++) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('supervisor_id')
      .eq('id', current)
      .maybeSingle();
    if (error) break;
    const next = (data as any)?.supervisor_id as string | null;
    if (!next || ancestors.includes(next)) break;
    ancestors.push(next);
    current = next;
  }
  return ancestors;
}

/**
 * Throws 403 if `targetUserIds` contains anyone outside the caller's
 * mention/message scope. Used as a guard on mention persistence + thread
 * member additions.
 */
export async function assertWithinScope(req: AuthRequest, targetUserIds: string[]): Promise<void> {
  if (targetUserIds.length === 0) return;
  const role = ((req.user?.role as string) || '').toLowerCase().replace(/-/g, '_');
  if (role === 'super_admin') return; // Platform-admin reaches every user.
  const allowed = new Set((await scopedUsers(req)).map((u) => u.id));
  for (const id of targetUserIds) {
    if (!allowed.has(id)) {
      throw new AppError(403, 'One or more recipients are outside your reachable team.', 'OUT_OF_SCOPE');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Mentions
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract @[uid:name] tokens from a body. The web mention input emits
 * tokens in that exact form when a user selects a suggestion; bare @name
 * strings are left alone (treated as plain text).
 */
export function parseMentionIds(body: string): string[] {
  const ids = new Set<string>();
  const re = /@\[([0-9a-fA-F-]{8,})(?::[^\]]+)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    ids.add(m[1]);
  }
  return Array.from(ids);
}

/**
 * Persist mentions for a source row and fan out notifications. Throws
 * 403 if any mentioned user is outside the caller's scope.
 */
export async function persistMentions(
  req: AuthRequest,
  source_kind: SourceKind,
  source_id: string,
  mentioned_user_ids: string[],
): Promise<void> {
  if (mentioned_user_ids.length === 0) return;
  const me = req.user!;
  await assertWithinScope(req, mentioned_user_ids.filter((id) => id !== me.id));
  const rows = mentioned_user_ids.map((uid) => ({
    org_id: me.org_id,
    source_kind,
    source_id,
    mentioner_id: me.id,
    mentioned_user_id: uid,
  }));
  await supabaseAdmin.from('mentions').insert(rows);

  // Fan out notifications — one per mentioned user (skip self-mentions
  // so a rep tagging themselves doesn't get pinged by themselves).
  const recipients = mentioned_user_ids.filter((uid) => uid !== me.id);
  if (recipients.length === 0) return;
  const senderName = me.name || me.email || 'Someone';
  const title = `${senderName} mentioned you`;
  const bodyByKind: Record<SourceKind, string> = {
    lead_update: 'in a lead update',
    activity:    'in an activity note',
    message:     'in a message',
  };
  const notifRows = recipients.map((uid) => ({
    user_id: uid,
    org_id:  me.org_id,
    title,
    body:    bodyByKind[source_kind],
    type:    'mention',
    data:    { source_kind, source_id, mentioner_id: me.id },
  }));
  await supabaseAdmin.from('notifications').insert(notifRows);

  // Web Push — fire-and-forget; failures don't abort the originating
  // request because the user has already seen the message land.
  void import('./webPush.service').then((wp) =>
    wp.sendPushToUsers(recipients, { title, body: bodyByKind[source_kind], url: linkForSource(source_kind, source_id) }),
  ).catch(() => { /* ignore */ });
}

function linkForSource(kind: SourceKind, id: string): string {
  if (kind === 'lead_update') return `/dashboard/crm/leads/${id}`;
  if (kind === 'activity')    return `/dashboard/crm/activities/${id}`;
  return `/dashboard/inbox?thread=${id}`;
}

// ─────────────────────────────────────────────────────────────────────
// Threads + messages
// ─────────────────────────────────────────────────────────────────────

export interface ThreadRow {
  id: string;
  kind: 'dm' | 'team';
  name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  member_ids: string[];
  created_at: string;
}

export async function listThreads(req: AuthRequest): Promise<ThreadRow[]> {
  const me = req.user!;
  const { data: memberships, error: me1 } = await supabaseAdmin
    .from('message_thread_members')
    .select('thread_id, last_read_at')
    .eq('user_id', me.id);
  if (me1) throw new AppError(500, me1.message, 'DB_ERROR');
  const threadIds = (memberships ?? []).map((m: any) => m.thread_id as string);
  if (threadIds.length === 0) return [];

  const { data: threads } = await supabaseAdmin
    .from('message_threads')
    .select('id, kind, name, last_message_at, last_message_preview, created_at')
    .in('id', threadIds)
    .is('deleted_at', null)
    .order('last_message_at', { ascending: false, nullsFirst: false });

  const { data: members } = await supabaseAdmin
    .from('message_thread_members')
    .select('thread_id, user_id')
    .in('thread_id', threadIds);

  const memberByThread = new Map<string, string[]>();
  for (const row of (members ?? []) as any[]) {
    if (!memberByThread.has(row.thread_id)) memberByThread.set(row.thread_id, []);
    memberByThread.get(row.thread_id)!.push(row.user_id);
  }

  // Unread count = messages in thread newer than my last_read_at.
  const readByThread = new Map<string, string | null>();
  for (const m of (memberships ?? []) as any[]) readByThread.set(m.thread_id, m.last_read_at);

  const unreadCounts = await Promise.all(
    threadIds.map(async (tid) => {
      const lr = readByThread.get(tid);
      let q = supabaseAdmin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('thread_id', tid)
        .neq('sender_id', me.id)
        .is('deleted_at', null);
      if (lr) q = q.gt('created_at', lr);
      const { count } = await q;
      return [tid, count ?? 0] as const;
    }),
  );
  const unreadMap = new Map(unreadCounts);

  return (threads ?? []).map((t: any) => ({
    id: t.id,
    kind: t.kind,
    name: t.name,
    last_message_at: t.last_message_at,
    last_message_preview: t.last_message_preview,
    unread_count: unreadMap.get(t.id) ?? 0,
    member_ids: memberByThread.get(t.id) ?? [],
    created_at: t.created_at,
  }));
}

export async function createOrGetDmThread(req: AuthRequest, otherUserId: string): Promise<string> {
  const me = req.user!;
  if (otherUserId === me.id) throw new AppError(400, 'Cannot DM yourself', 'INVALID');
  await assertWithinScope(req, [otherUserId]);

  // Find an existing DM thread that has exactly the two of us.
  const { data: myThreads } = await supabaseAdmin
    .from('message_thread_members')
    .select('thread_id')
    .eq('user_id', me.id);
  const myIds = (myThreads ?? []).map((r: any) => r.thread_id as string);
  if (myIds.length > 0) {
    const { data: theirShared } = await supabaseAdmin
      .from('message_thread_members')
      .select('thread_id')
      .eq('user_id', otherUserId)
      .in('thread_id', myIds);
    const shared = (theirShared ?? []).map((r: any) => r.thread_id as string);
    if (shared.length > 0) {
      const { data: dm } = await supabaseAdmin
        .from('message_threads')
        .select('id')
        .in('id', shared)
        .eq('kind', 'dm')
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      if (dm) return (dm as any).id as string;
    }
  }

  const { data: thread, error } = await supabaseAdmin
    .from('message_threads')
    .insert({ org_id: me.org_id, client_id: me.client_id ?? null, kind: 'dm', created_by: me.id })
    .select('id')
    .single();
  if (error || !thread) throw new AppError(500, error?.message || 'Thread create failed', 'DB_ERROR');
  const threadId = (thread as any).id as string;
  await supabaseAdmin.from('message_thread_members').insert([
    { thread_id: threadId, user_id: me.id },
    { thread_id: threadId, user_id: otherUserId },
  ]);
  return threadId;
}

export async function createTeamThread(req: AuthRequest, name: string, memberIds: string[]): Promise<string> {
  const me = req.user!;
  const cleanName = (name || '').trim().slice(0, 80) || 'Team Chat';
  const uniqMembers = Array.from(new Set(memberIds.filter((id) => id && id !== me.id)));
  await assertWithinScope(req, uniqMembers);
  if (uniqMembers.length === 0) throw new AppError(400, 'Team chat needs at least one other member', 'INVALID');

  const { data: thread, error } = await supabaseAdmin
    .from('message_threads')
    .insert({ org_id: me.org_id, client_id: me.client_id ?? null, kind: 'team', name: cleanName, created_by: me.id })
    .select('id')
    .single();
  if (error || !thread) throw new AppError(500, error?.message || 'Thread create failed', 'DB_ERROR');
  const threadId = (thread as any).id as string;
  const rows = [me.id, ...uniqMembers].map((uid) => ({ thread_id: threadId, user_id: uid }));
  await supabaseAdmin.from('message_thread_members').insert(rows);
  return threadId;
}

export async function listMessages(req: AuthRequest, threadId: string, limit = 100): Promise<any[]> {
  const me = req.user!;
  await assertThreadMember(me.id, threadId);
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('id, thread_id, sender_id, body, language, created_at')
    .eq('thread_id', threadId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 500));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = data ?? [];
  // Hydrate sender names in one round-trip.
  const senderIds = Array.from(new Set(rows.map((r: any) => r.sender_id as string)));
  if (senderIds.length === 0) return rows;
  const { data: users } = await supabaseAdmin.from('users').select('id, full_name, email').in('id', senderIds);
  const byId = new Map((users ?? []).map((u: any) => [u.id, u.full_name || u.email || 'User']));
  return rows.map((r: any) => ({ ...r, sender_name: byId.get(r.sender_id) ?? 'User' }));
}

export async function sendMessage(req: AuthRequest, threadId: string, body: string, language?: string): Promise<any> {
  const me = req.user!;
  const text = (body || '').trim();
  if (!text) throw new AppError(400, 'Message body is required', 'VALIDATION');
  if (text.length > 4000) throw new AppError(400, 'Message too long (max 4000)', 'VALIDATION');
  await assertThreadMember(me.id, threadId);

  const { data: thread } = await supabaseAdmin
    .from('message_threads')
    .select('org_id, kind')
    .eq('id', threadId)
    .maybeSingle();
  if (!thread) throw new AppError(404, 'Thread not found', 'NOT_FOUND');

  const now = new Date().toISOString();
  const { data: msg, error } = await supabaseAdmin
    .from('messages')
    .insert({ thread_id: threadId, org_id: (thread as any).org_id, sender_id: me.id, body: text, language: language || null, created_at: now })
    .select('id, thread_id, sender_id, body, language, created_at')
    .single();
  if (error || !msg) throw new AppError(500, error?.message || 'Send failed', 'DB_ERROR');

  // Bump thread metadata for the inbox list view.
  await supabaseAdmin
    .from('message_threads')
    .update({ last_message_at: now, last_message_preview: text.slice(0, 140) })
    .eq('id', threadId);

  // Persist mentions parsed from body + fan out notifications to all
  // OTHER thread members (separate from mentions — mentions notify the
  // specifically tagged user; this notifies the wider thread).
  const mentionIds = parseMentionIds(text);
  if (mentionIds.length > 0) {
    await persistMentions(req, 'message', (msg as any).id, mentionIds);
  }

  // Fan out a generic "new message" notification to thread members.
  const { data: members } = await supabaseAdmin
    .from('message_thread_members')
    .select('user_id, notify')
    .eq('thread_id', threadId);
  const recipients = (members ?? [])
    .filter((m: any) => m.user_id !== me.id && m.notify !== false)
    .map((m: any) => m.user_id as string);
  if (recipients.length > 0) {
    const senderName = me.name || me.email || 'Someone';
    const title = (thread as any).kind === 'dm' ? `New message from ${senderName}` : `New message in ${senderName}'s team chat`;
    const preview = text.slice(0, 120);
    await supabaseAdmin.from('notifications').insert(
      recipients.map((uid) => ({
        user_id: uid,
        org_id: (thread as any).org_id,
        title,
        body: preview,
        type: 'message',
        data: { thread_id: threadId, message_id: (msg as any).id, sender_id: me.id },
      })),
    );
    void import('./webPush.service').then((wp) =>
      wp.sendPushToUsers(recipients, { title, body: preview, url: `/dashboard/inbox?thread=${threadId}` }),
    ).catch(() => { /* ignore */ });
  }

  return { ...msg, sender_name: me.name || me.email || 'User' };
}

export async function markThreadRead(req: AuthRequest, threadId: string): Promise<void> {
  const me = req.user!;
  await supabaseAdmin
    .from('message_thread_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('thread_id', threadId)
    .eq('user_id', me.id);
}

async function assertThreadMember(userId: string, threadId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from('message_thread_members')
    .select('thread_id')
    .eq('thread_id', threadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) throw new AppError(403, 'You are not a member of this thread', 'FORBIDDEN');
}
