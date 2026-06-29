/**
 * Builds the context + planning blocks injected into KINI's system prompt.
 *
 * The dashboard and mobile clients attach a `context` payload describing
 * what the user is currently looking at — the screen, the open record, any
 * active filters or multi-selection. Surfacing that to the model means it
 * can answer with the user's actual frame in mind ("this lead" / "these
 * three deals") without the user spelling it out.
 */

export interface KiniContext {
  module?: string;          // 'crm' | 'field_force' | 'distribution' | ...
  screen?: string;          // 'lead_detail' | 'deals_kanban' | 'map' | ...
  record_type?: string;     // 'lead' | 'deal' | 'account' | 'contact' | 'outlet'
  record_id?: string;
  filters?: Record<string, unknown>;
  selected_ids?: string[];
  city?: string;
  date?: string;            // ISO date the user is viewing
  locale?: string;
}

export interface KiniUserContext {
  user_id: string;
  org_id: string;
  client_id?: string | null;
  role?: string;
  hierarchy_level?: string;
  city?: string;
  full_name?: string;
}

export function buildContextBlock(
  ctx: KiniContext | undefined,
  user: KiniUserContext,
): string {
  const lines: string[] = ['=== USER CONTEXT ==='];
  if (user.full_name) lines.push(`Operator: ${user.full_name}`);
  if (user.role) lines.push(`Role: ${user.role}`);
  if (user.hierarchy_level) lines.push(`Hierarchy level: ${user.hierarchy_level}`);
  if (user.city) lines.push(`Home city: ${user.city}`);
  if (ctx?.module) lines.push(`Module in use: ${ctx.module}`);
  if (ctx?.screen) lines.push(`Current screen: ${ctx.screen}`);
  if (ctx?.record_type && ctx?.record_id) {
    lines.push(`Open record: ${ctx.record_type} ${ctx.record_id}`);
  }
  if (ctx?.selected_ids && ctx.selected_ids.length > 0) {
    const head = ctx.selected_ids.slice(0, 5).join(', ');
    const tail = ctx.selected_ids.length > 5 ? ', ...' : '';
    lines.push(
      `Selected ${ctx.record_type ?? 'records'}: ${ctx.selected_ids.length} (ids: ${head}${tail})`,
    );
  }
  if (ctx?.filters && Object.keys(ctx.filters).length > 0) {
    lines.push(`Active filters: ${JSON.stringify(ctx.filters).slice(0, 500)}`);
  }
  if (ctx?.city && ctx.city !== user.city) lines.push(`Viewing city: ${ctx.city}`);
  if (ctx?.date) lines.push(`Viewing date: ${ctx.date}`);
  lines.push('===');
  return lines.join('\n');
}

/**
 * Operating instructions for the agentic loop. Kept terse to leave headroom
 * for tool descriptions in the system prompt.
 */
export function planningInstruction(): string {
  return [
    '=== HOW TO WORK ===',
    'You are an agentic copilot, not a chatbot. For every user request:',
    '  1. PLAN — note your 1-3 step plan in one short sentence.',
    '  2. ACT — call tools in order. The open record/screen is CONTEXT, not a fence: if the user asks about anything else (another module, another record, the whole pipeline, field-force, distribution, analytics), answer THAT fully using the right tools. Never refuse or redirect just because a different record is on screen. Only prefer the open record when the user is clearly talking about "this" one.',
    '  3. VERIFY — confirm writes in 1-2 sentences; on failure, explain and offer a recovery path.',
    '  4. SUGGEST — end EVERY reply with one concrete next action the user can take right now (e.g. "Want me to log this call?", "Draft a follow-up to them?", "Shall I create a deal for this?"). When that next action maps to a tool, offer to do it for them in the same breath.',
    'Never invent record IDs — search first, act second. If a tool exists for the task, use it; do not explain manual steps.',
    'When a tool returns a card, the UI renders it — do NOT repeat the full record details in your text reply.',
    'Indian context: default currency INR (₹); "2 lakh" = 200000, "1 crore" = 10000000.',
    'If intent is ambiguous, ask one clarifying question before acting. Never mutate data on a guess.',
    '===',
  ].join('\n');
}
