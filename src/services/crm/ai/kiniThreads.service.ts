/**
 * Persistent KINI conversation threads.
 *
 * A thread is a long-running chat for one user; messages within a thread are
 * the user/assistant turns plus structured tool_calls + cards the client
 * rendered. Threads are scoped to (org_id, user_id) so super_admins do not
 * see other users' history.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

export interface KiniThread {
  id: string;
  org_id: string;
  client_id: string | null;
  user_id: string;
  title: string | null;
  last_message_at: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export type KiniMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface KiniMessage {
  id: string;
  thread_id: string;
  role: KiniMessageRole;
  content: string | null;
  tool_calls: unknown;
  cards: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

export interface NewKiniMessage {
  role: KiniMessageRole;
  content: string | null;
  tool_calls: unknown;
  cards: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
}

export async function listThreads(
  user_id: string,
  limit = 50,
): Promise<KiniThread[]> {
  const { data, error } = await supabaseAdmin
    .from('kini_threads')
    .select('*')
    .eq('user_id', user_id)
    .is('archived_at', null)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    logger.warn(`[kiniThreads] listThreads: ${error.message}`);
    return [];
  }
  return data as KiniThread[];
}

export async function getThread(
  thread_id: string,
  user_id: string,
): Promise<{ thread: KiniThread; messages: KiniMessage[] } | null> {
  const { data: thread, error: te } = await supabaseAdmin
    .from('kini_threads')
    .select('*')
    .eq('id', thread_id)
    .eq('user_id', user_id)
    .maybeSingle();
  if (te || !thread) return null;

  const { data: messages, error: me } = await supabaseAdmin
    .from('kini_messages')
    .select('*')
    .eq('thread_id', thread_id)
    .order('created_at', { ascending: true });
  if (me) {
    logger.warn(`[kiniThreads] getThread messages: ${me.message}`);
    return { thread: thread as KiniThread, messages: [] };
  }
  return {
    thread: thread as KiniThread,
    messages: (messages as KiniMessage[]) || [],
  };
}

export async function createThread(
  user_id: string,
  org_id: string,
  client_id: string | null,
  title?: string,
): Promise<KiniThread | null> {
  const { data, error } = await supabaseAdmin
    .from('kini_threads')
    .insert({ user_id, org_id, client_id, title: title || null })
    .select('*')
    .single();
  if (error) {
    logger.warn(`[kiniThreads] createThread: ${error.message}`);
    return null;
  }
  return data as KiniThread;
}

export async function appendMessages(
  thread_id: string,
  messages: NewKiniMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const rows = messages.map((m) => ({ ...m, thread_id }));
  const { error } = await supabaseAdmin.from('kini_messages').insert(rows);
  if (error) {
    logger.warn(`[kiniThreads] appendMessages: ${error.message}`);
    return;
  }
  // Bump thread metadata; fire-and-forget — we don't block the response.
  supabaseAdmin
    .from('kini_threads')
    .update({
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', thread_id)
    .then(({ error: ue }) => {
      if (ue) logger.warn(`[kiniThreads] updateThread meta: ${ue.message}`);
    });
}

export async function deleteThread(
  thread_id: string,
  user_id: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('kini_threads')
    .delete()
    .eq('id', thread_id)
    .eq('user_id', user_id);
  if (error) {
    logger.warn(`[kiniThreads] deleteThread: ${error.message}`);
    return false;
  }
  return true;
}

export async function setTitle(
  thread_id: string,
  user_id: string,
  title: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('kini_threads')
    .update({ title: title.slice(0, 200), updated_at: new Date().toISOString() })
    .eq('id', thread_id)
    .eq('user_id', user_id);
  if (error) {
    logger.warn(`[kiniThreads] setTitle: ${error.message}`);
    return false;
  }
  return true;
}
