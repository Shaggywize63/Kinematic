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

/**
 * Progress events emitted DURING a streaming chat turn (only when `onEvent` is
 * supplied on ChatWithToolsInput). Purely for UX — correctness never depends on
 * them: the full reply/cards/usage are still assembled server-side and returned
 * in ChatWithToolsOutput exactly as in the buffered path.
 *   - token     : an incremental slice of the assistant's visible text.
 *   - tool_call : a tool is about to run (`start`) / has finished (`done`, with
 *                 `ok` = the tool did not error).
 *   - card      : a tool produced a renderable card.
 */
export type StreamEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call'; tool: string; phase: 'start' }
  | { kind: 'tool_call'; tool: string; phase: 'done'; ok: boolean }
  | { kind: 'card'; card: { type: string; data: unknown } };

export interface ChatWithToolsInput {
  org_id?: string;
  model?: string;
  system: string;
  tools: AnthropicTool[];
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  onToolCall: (name: string, args: unknown) => Promise<unknown>;
  max_tokens?: number;
  max_turns?: number;
  // OPTIONAL streaming hook. When supplied, the per-turn Anthropic call runs
  // with `stream: true` and this callback fires for each token / tool_call /
  // card as they happen. When omitted, chatWithTools is byte-for-byte the
  // original buffered implementation. Either way the returned output is the same.
  onEvent?: (ev: StreamEvent) => void;
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

// The normalised result of a single Anthropic turn — identical shape whether it
// came from the buffered JSON path or the streamed SSE path, so the tool-use
// loop below can consume either without branching on structure.
type TurnData = {
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
};

// A streamed agentic turn can legitimately run far longer than a buffered one
// (multiple tool round-trips of model thinking). anthropicFetch's deadline only
// bounds time-to-headers — for an SSE response headers arrive immediately, so it
// would leave the body read UNBOUNDED. We therefore give the streaming turn its
// OWN AbortController with a longer deadline that bounds the entire stream read.
// This does NOT touch the buffered path's 60s deadline.
const STREAM_TURN_DEADLINE_MS = 120_000;

/** Extract and JSON-parse the `data:` payload of one raw SSE event block. */
function parseSseData(block: string): unknown {
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
}

/**
 * Run ONE Anthropic Messages turn with `stream: true`, parsing the SSE and
 * emitting each `text_delta` via `onToken`. Accumulates text + tool_use content
 * blocks (assembling each tool_use's input JSON from its `input_json_delta`
 * fragments) and returns the SAME TurnData shape the buffered path produces, so
 * the loop's tool-execution logic is shared. Usage is taken from `message_start`
 * (input) and `message_delta` (output).
 */
async function streamAnthropicTurn(params: {
  apiKey: string;
  model: string;
  max_tokens: number;
  system: string;
  tools: AnthropicTool[];
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  onToken: (text: string) => void;
}): Promise<TurnData> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), STREAM_TURN_DEADLINE_MS);

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.max_tokens,
        system: params.system,
        tools: params.tools,
        messages: params.messages,
        stream: true,
      }),
      signal: ac.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    if ((e as { name?: string })?.name === 'AbortError') {
      throw new AppError(504, 'AI service timed out', 'AI_TIMEOUT');
    }
    throw e;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const body = await res.json().catch(() => ({}));
    const detail = (body as { error?: { message?: string } })?.error?.message || '';
    console.warn(`[chatWithTools.stream] upstream ${res.status}: ${detail.slice(0, 300).replace(/sk-[a-zA-Z0-9-]+/g, 'sk-[REDACTED]')}`);
    const opaque =
      res.status === 401 ? 'AI authentication failed'
      : res.status === 429 ? 'AI service rate-limited — retry shortly'
      : res.status >= 500 ? 'AI service temporarily unavailable'
      : 'AI request failed';
    throw new AppError(res.status, opaque, 'AI_ERROR');
  }

  // Content blocks accumulated by their stream index; tool_use input JSON is
  // reassembled from input_json_delta fragments per index.
  const blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  > = [];
  const toolJson: Record<number, string> = {};
  let stop_reason = '';
  const usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 };

  try {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseSseData(rawEvent) as
          | {
              type?: string;
              index?: number;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              [k: string]: any;
            }
          | null;
        if (!ev || typeof ev !== 'object' || !ev.type) continue;
        switch (ev.type) {
          case 'message_start': {
            const u = ev.message?.usage;
            if (u) {
              usage.input_tokens = Number(u.input_tokens ?? 0) || 0;
              usage.output_tokens = Number(u.output_tokens ?? 0) || 0;
            }
            break;
          }
          case 'content_block_start': {
            const index = Number(ev.index ?? 0);
            const cb = ev.content_block;
            if (cb?.type === 'text') {
              blocks[index] = { type: 'text', text: typeof cb.text === 'string' ? cb.text : '' };
            } else if (cb?.type === 'tool_use') {
              blocks[index] = { type: 'tool_use', id: String(cb.id ?? ''), name: String(cb.name ?? ''), input: {} };
              toolJson[index] = '';
            }
            break;
          }
          case 'content_block_delta': {
            const index = Number(ev.index ?? 0);
            const delta = ev.delta;
            if (delta?.type === 'text_delta') {
              const text = typeof delta.text === 'string' ? delta.text : '';
              const b = blocks[index];
              if (b && b.type === 'text') b.text += text;
              if (text) params.onToken(text);
            } else if (delta?.type === 'input_json_delta') {
              toolJson[index] = (toolJson[index] ?? '') + (typeof delta.partial_json === 'string' ? delta.partial_json : '');
            }
            break;
          }
          case 'content_block_stop': {
            const index = Number(ev.index ?? 0);
            const b = blocks[index];
            if (b && b.type === 'tool_use') {
              const raw = (toolJson[index] ?? '').trim();
              try {
                b.input = raw ? JSON.parse(raw) : {};
              } catch {
                b.input = {};
              }
            }
            break;
          }
          case 'message_delta': {
            if (ev.delta?.stop_reason) stop_reason = String(ev.delta.stop_reason);
            if (ev.usage?.output_tokens != null) usage.output_tokens = Number(ev.usage.output_tokens) || usage.output_tokens;
            break;
          }
          case 'message_stop': {
            done = true;
            break;
          }
          case 'error': {
            const detail = ev.error?.message || 'stream error';
            console.warn(`[chatWithTools.stream] event error: ${String(detail).slice(0, 200)}`);
            throw new AppError(502, 'AI service temporarily unavailable', 'AI_ERROR');
          }
          default:
            break;
        }
      }
    }
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === 'AbortError') {
      throw new AppError(504, 'AI service timed out', 'AI_TIMEOUT');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  return { stop_reason, usage, content: blocks.filter(Boolean) };
}

/**
 * Run a multi-turn conversation with Anthropic tool use. Loops until the model
 * stops emitting tool_use blocks (or max_turns is reached), then returns the
 * final assistant text plus any cards produced by tools.
 */
export async function chatWithTools(input: ChatWithToolsInput): Promise<ChatWithToolsOutput> {
  const apiKey = await AIService.getFunctionalKey();
  const model = input.model || 'claude-haiku-4-5-20251001';
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
    let data: TurnData;
    if (input.onEvent) {
      // Streaming path — same request, `stream: true`. Tokens are emitted as
      // they arrive; the assembled TurnData below is identical to the buffered
      // shape so the tool loop is shared and the returned reply is complete.
      const onEvent = input.onEvent;
      data = await streamAnthropicTurn({
        apiKey,
        model,
        max_tokens,
        system: input.system,
        tools: input.tools,
        messages,
        onToken: (text) => onEvent({ kind: 'token', text }),
      });
    } else {
      // Buffered path — UNCHANGED. Use the AIService deadline+opaque-error
      // wrapper so a slow upstream can't pin a worker, and a 401 from Anthropic
      // can't leak the key fragment back to the user.
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
      data = await res.json() as TurnData;
    }
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
      if (input.onEvent) input.onEvent({ kind: 'tool_call', tool: tu.name, phase: 'start' });
      let result: unknown;
      try { result = await input.onToolCall(tu.name, tu.input); }
      catch (e) { result = { error: (e as Error).message }; }
      tool_calls.push({ name: tu.name, args: tu.input, result });
      const card = (result as { card?: { type: string; data: unknown } } | null | undefined)?.card;
      if (card && card.type) {
        cards.push(card);
        if (input.onEvent) input.onEvent({ kind: 'card', card });
      }
      if (input.onEvent) {
        // `ok` = the tool neither threw (top-level `error`) nor returned a
        // swallowed failure (`data.error`).
        const r = result as { error?: unknown; data?: { error?: unknown } } | null | undefined;
        const ok = !(r?.error ?? r?.data?.error);
        input.onEvent({ kind: 'tool_call', tool: tu.name, phase: 'done', ok });
      }
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
