/**
 * Thin CRM-local adapter over the shared `AIService` class.
 * Adds:
 *   - a uniform `complete()` helper (returns text)
 *   - `chatWithTools()` for KINI tool-use loop (Anthropic tools API)
 *
 * We don't mutate the existing AIService — we just call `getFunctionalKey()`
 * and hit the Messages API directly when we need features beyond `callKiniAI`.
 */
import { AIService } from '../ai.service';
import { AppError } from '../../utils';

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
}

/**
 * Run a multi-turn conversation with Anthropic tool use. Loops until the model
 * stops emitting tool_use blocks (or max_turns is reached), then returns the
 * final assistant text plus any cards produced by tools.
 */
export async function chatWithTools(input: ChatWithToolsInput): Promise<ChatWithToolsOutput> {
  const apiKey = await AIService.getFunctionalKey();
  const model = input.model || 'claude-3-5-sonnet-20241022';
  const max_tokens = input.max_tokens ?? 1500;
  const max_turns = input.max_turns ?? 5;

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [...input.messages];
  const cards: Array<{ type: string; data: unknown }> = [];
  const tool_calls: Array<{ name: string; args: unknown; result: unknown }> = [];

  for (let turn = 0; turn < max_turns; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
      throw new AppError(res.status, (body as { error?: { message?: string } })?.error?.message || `AI ${res.status}`, 'AI_ERROR');
    }
    const data = await res.json() as {
      stop_reason: string;
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
    };

    const toolUses = data.content.filter(c => c.type === 'tool_use') as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
    const textBlocks = data.content.filter(c => c.type === 'text') as Array<{ type: 'text'; text: string }>;

    if (toolUses.length === 0) {
      const reply = textBlocks.map(t => t.text).join('\n').trim();
      return { reply, cards, tool_calls };
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
  return { reply: '', cards, tool_calls };
}
