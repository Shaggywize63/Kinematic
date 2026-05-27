/**
 * Long-lived per-user memory KINI uses to personalise responses.
 *
 * Memory is a small key/value bag of stable facts:
 *   preferred_currency_format -> 'lakhs'
 *   default_pipeline          -> 'B2B'
 *   territory                 -> 'Pune'
 *
 * Everything stored here is injected into the system prompt on every chat
 * turn, so keep it small and stable. Transient conversational state belongs
 * in kini_messages, not here.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

const MAX_VALUE_LEN = 500;
const MAX_KEY_LEN = 80;
const MAX_ROWS_PER_USER = 50;
const MAX_PROMPT_ROWS = 20;

export interface KiniMemoryEntry {
  key: string;
  value: string;
  pinned: boolean;
  updated_at: string;
}

export async function listMemory(user_id: string): Promise<KiniMemoryEntry[]> {
  const { data, error } = await supabaseAdmin
    .from('kini_user_memory')
    .select('key, value, pinned, updated_at')
    .eq('user_id', user_id)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(MAX_ROWS_PER_USER);
  if (error) {
    logger.warn(`[kiniMemory] listMemory: ${error.message}`);
    return [];
  }
  return (data as KiniMemoryEntry[]) || [];
}

export async function setMemory(
  user_id: string,
  org_id: string,
  key: string,
  value: string,
  opts: { source?: string; pinned?: boolean } = {},
): Promise<KiniMemoryEntry | null> {
  if (!key || !value) return null;
  const k = key.trim().slice(0, MAX_KEY_LEN);
  const v = value.trim().slice(0, MAX_VALUE_LEN);
  const { data, error } = await supabaseAdmin
    .from('kini_user_memory')
    .upsert(
      {
        user_id,
        org_id,
        key: k,
        value: v,
        source: opts.source || 'kini',
        pinned: opts.pinned ?? false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,key' },
    )
    .select('key, value, pinned, updated_at')
    .single();
  if (error) {
    logger.warn(`[kiniMemory] setMemory: ${error.message}`);
    return null;
  }
  return data as KiniMemoryEntry;
}

export async function deleteMemory(user_id: string, key: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('kini_user_memory')
    .delete()
    .eq('user_id', user_id)
    .eq('key', key);
  if (error) {
    logger.warn(`[kiniMemory] deleteMemory: ${error.message}`);
    return false;
  }
  return true;
}

export async function formatMemoryForPrompt(user_id: string): Promise<string> {
  const entries = await listMemory(user_id);
  if (entries.length === 0) return '';
  const lines = entries.slice(0, MAX_PROMPT_ROWS).map((e) => `- ${e.key}: ${e.value}`);
  return ['=== REMEMBERED ABOUT THIS USER ===', ...lines, '==='].join('\n');
}
