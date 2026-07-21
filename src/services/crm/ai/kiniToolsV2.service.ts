/**
 * KINI agentic-v2 tool registry. Composes the legacy CRM tool set with new
 * module-scoped tool files (Field Force here; Distribution / Analytics /
 * Admin to follow). The legacy kiniTools.service.ts is NOT modified, so the
 * v1 chat path is bit-for-bit identical when the v2 flag is off.
 */
import {
  tools as crmTools,
  executeTool as executeCrmTool,
  type KiniTool,
  type KiniToolResult,
} from './kiniTools.service';
import { ffTools } from './tools/ff.tools';

export const tools: KiniTool[] = [...crmTools, ...ffTools];

export function toAnthropicTools() {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Find and execute a tool by name. v2-module tools (ff, dist, analytics,
 * admin) are checked first; anything else falls through to the legacy CRM
 * registry. Result shape is normalised to `{ tool, data, card? }`.
 */
export async function executeTool(
  org_id: string,
  client_id: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<KiniToolResult | null> {
  const v2Tool = ffTools.find((t) => t.name === name);
  if (v2Tool) {
    try {
      const result = await v2Tool.exec(org_id, client_id, args);
      if (typeof result === 'object' && result !== null && 'card' in result) {
        const r = result as { data: unknown; card?: { type: string; data: unknown } };
        return { tool: name, data: r.data, card: r.card };
      }
      return { tool: name, data: result };
    } catch (e) {
      // Never let a Field-Force tool throw abort the whole turn (surfaces as the
      // opaque "I hit an error"). Return the error as a tool result so the model
      // can recover. Legacy CRM tools get the same treatment in executeCrmTool.
      const msg = (e as { message?: string })?.message || 'Tool execution failed';
      return { tool: name, data: { error: msg } };
    }
  }
  return executeCrmTool(org_id, client_id, name, args);
}
