/**
 * Fire-and-forget logger for KINI tool calls. We never await the insert on
 * the chat hot path — failures are warned and dropped.
 *
 * The data lands in `kini_tool_calls` and is the source of truth for the
 * "which tools is the agent actually picking, with what success rate and
 * latency" super-admin dashboard.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

export interface ToolCallLog {
  org_id: string;
  client_id: string | null;
  user_id: string | null;
  thread_id: string | null;
  tool_name: string;
  args: unknown;
  result_size?: number;
  success: boolean;
  error_code?: string;
  latency_ms: number;
}

const MAX_ARGS_BYTES = 4000;

function safeArgs(args: unknown): unknown {
  try {
    const json = JSON.stringify(args);
    if (json.length > MAX_ARGS_BYTES) {
      return { _truncated: true, head: json.slice(0, MAX_ARGS_BYTES) };
    }
    return args;
  } catch {
    return { _unstringifiable: true };
  }
}

export function logToolCall(entry: ToolCallLog): void {
  supabaseAdmin
    .from('kini_tool_calls')
    .insert({
      org_id: entry.org_id,
      client_id: entry.client_id,
      user_id: entry.user_id,
      thread_id: entry.thread_id,
      tool_name: entry.tool_name,
      args: safeArgs(entry.args),
      result_size: entry.result_size ?? null,
      success: entry.success,
      error_code: entry.error_code ?? null,
      latency_ms: entry.latency_ms,
    })
    .then(({ error }) => {
      if (error) logger.warn(`[kiniObs] insert failed: ${error.message}`);
    });
}
