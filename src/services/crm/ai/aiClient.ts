/**
 * Thin CRM-local adapter over the shared `AIService` class.
 * Adds:
 *   - a uniform `complete()` helper (returns text)
 *   - `chatWithTools()` for KINI tool-use loop (Anthropic tools API)
 *
 * We don't mutate the existing AIService — we just call `getFunctionalKey()`
 * and hit the Messages API directly when we need features beyond `callKiniAI`.
 */
import { AIService } from '../../ai.service';
import { AppError } from '../../../utils';
// AIService.anthropicFetch wraps fetch with an AbortController so we
// don't tie up a Node worker on a slow Anthropic response.

export interface CompleteInput {
  org_id?: string;        // accepted for forward-compat (per-org keys); currently unused
  model?: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  max_tokens?: number;
}

export async function complete(input: CompleteInput): Promise<string> {
  return AIService.callKiniAI({
    system: input.system,
    messages: input.messages,
    model: input.model,
    max_tokens: input.max_tokens,
  });
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatWithToolsInput {
  org_id?: string;
  model?: string;
  system: string;
  tools: AnthropicTool[];
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  onToolCall: (name: string, args: unknown) => Promise<unknown>;
  max_tokens?: number;
  max_turns?: number;
}

export interface ChatWithToolsOutput {
  reply: string;
  cards: Array<{ type: string; data: unknown }>;
  tool_calls: Array<{ name: string; args: unknown; result: unknown }>;
  // Summed Anthropic token usage across every response in the loop (each
  // tool-use turn plus the wrap-up call). Callers pass this into the quota
  // recorder so kini_usage reflects real cost instead of 0. Always present.
  usage: { input: number; output: number };
}

/**
 * The chat clients (web / iOS / Android) are stateless — they resend their full
 * conversation history every turn. Two shapes in that resent history make the
 * Anthropic Messages API 400, which aborts the whole turn and surfaces to the
 * user as the opaque "I hit an error processing that":
 *   1. a message with EMPTY string content — e.g. a card-only assistant turn
 *      (KINI drafts an email; the visible text bubble is empty), or a thread
 *      row stored with no text.
 *   2. a history slice that STARTS on an assistant turn — the API requires the
 *      first message to be a user turn.
 * Normalise both so a multi-turn conversation can't crash on resent history.
 * Internal tool-loop turns (content is an array of blocks) are never empty and
 * are left untouched.
 */
function sanitizeInboundMessages(
  raw: Array<{ role: 'user' | 'assistant'; content: unknown }>,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const cleaned = raw.map((m) =>
    typeof m.content === 'string' && m.content.trim() === ''
      ? { ...m, content: m.role === 'assistant' ? '(shared the result above)' : '(no message)' }
      : m,
  );
  let start = 0;
  while (start < cleaned.length && cleaned[start].role === 'assistant') start++;
  return cleaned.slice(start);
}

/**
 * Run a multi-turn conversation with Anthropic tool use. Loops until the model
 * stops emitting tool_use blocks (or max_turns is reached), then returns the
 * final assistant text plus any cards produced by tools.
 */
export async function chatWithTools(input: ChatWithToolsInput): Promise<ChatWithToolsOutput> {
  const apiKey = await AIService.getFunctionalKey();
  const model = input.model || 'claude-haiku-4-5';
  const max_tokens = input.max_tokens ?? 1500;
  const max_turns = input.max_turns ?? 5;

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [...sanitizeInboundMessages(input.messages)];
  const cards: Array<{ type: string; data: unknown }> = [];
  const tool_calls: Array<{ name: string; args: unknown; result: unknown }> = [];

  // Accumulate token usage across EVERY Anthropic response in this loop — the
  // per-turn tool-use calls AND the final wrap-up call. Previously usage was
  // never captured, so recordQuery always incremented tokens by 0. Summing it
  // here and returning it lets the call sites meter real cost.
  const usage = { input: 0, output: 0 };
  const addUsage = (u?: { input_tokens?: number; output_tokens?: number } | null): void => {
    if (!u) return;
    usage.input += Number(u.input_tokens ?? 0) || 0;
    usage.output += Number(u.output_tokens ?? 0) || 0;
  };

  for (let turn = 0; turn < max_turns; turn++) {
    // Use the AIService deadline+opaque-error wrapper so a slow
    // upstream can't pin a worker, and a 401 from Anthropic can't
    // leak the key fragment back to the user.
    const res = await AIService.anthropicFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens, system: input.system, tools: input.tools, messages }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // Log the upstream detail server-side, return an opaque code.
      const detail = (body as { error?: { message?: string } })?.error?.message || '';
      console.warn(`[chatWithTools] upstream ${res.status}: ${detail.slice(0, 300).replace(/sk-[a-zA-Z0-9-]+/g, 'sk-[REDACTED]')}`);
      const opaque =
        res.status === 401 ? 'AI authentication failed'
        : res.status === 429 ? 'AI service rate-limited — retry shortly'
        : res.status >= 500 ? 'AI service temporarily unavailable'
        : 'AI request failed';
      throw new AppError(res.status, opaque, 'AI_ERROR');
    }
    const data = await res.json() as {
      stop_reason: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
    };
    addUsage(data.usage);

    const toolUses = data.content.filter(c => c.type === 'tool_use') as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
    const textBlocks = data.content.filter(c => c.type === 'text') as Array<{ type: 'text'; text: string }>;

    if (toolUses.length === 0) {
      const reply = textBlocks.map(t => t.text).join('\n').trim();
      return { reply, cards, tool_calls, usage };
    }

    // Append assistant turn
    messages.push({ role: 'assistant', content: data.content });

    // Execute each tool, build tool_result blocks
    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const tu of toolUses) {
      let result: unknown;
      try { result = await input.onToolCall(tu.name, tu.input); }
      catch (e) { result = { error: (e as Error).message }; }
      tool_calls.push({ name: tu.name, args: tu.input, result });
      const card = (result as { card?: { type: string; data: unknown } } | null | undefined)?.card;
      if (card && card.type) cards.push(card);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify((result as { data?: unknown } | null | undefined)?.data ?? result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Loop hit max_turns without a final text-only turn. Do one no-tools
  // wrap-up call so the user gets a real summary instead of an empty reply
  // (which the dashboard renders as a generic apology).
  try {
    const finalRes = await AIService.anthropicFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens,
        system:
          input.system +
          '\n\nIMPORTANT: Tools have already run. Reply with a brief 1-2 sentence summary of what was done or found. Do NOT call any more tools.',
        messages,
      }),
    });
    if (finalRes.ok) {
      const finalData = (await finalRes.json()) as {
        usage?: { input_tokens?: number; output_tokens?: number };
        content: Array<{ type: string; text?: string }>;
      };
      addUsage(finalData.usage);
      const reply = (finalData.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n')
        .trim();
      return { reply, cards, tool_calls, usage };
    }
    const body = await finalRes.json().catch(() => ({}));
    const detail = (body as { error?: { message?: string } })?.error?.message || '';
    console.warn(`[chatWithTools.final] upstream ${finalRes.status}: ${detail.slice(0, 300).replace(/sk-[a-zA-Z0-9-]+/g, 'sk-[REDACTED]')}`);
  } catch (e) {
    console.warn('[chatWithTools.final] error:', (e as Error)?.message);
  }
  return { reply: '', cards, tool_calls, usage };
}
