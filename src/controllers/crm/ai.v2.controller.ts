/**
 * KINI agentic v2 controllers. Mounted under /api/v1/kini/v2/* via
 * src/routes/kini.routes.ts. Gated by the `kini_agentic_v2` per-tenant flag
 * — when the flag is off, every endpoint returns 403 KINI_V2_DISABLED and
 * clients fall back to the legacy /api/v1/crm/ai/chat path.
 */
import { Response } from 'express';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, notFound } from '../../utils';
import { chatWithTools } from '../../services/crm/ai/aiClient';
import { toAnthropicTools, executeTool } from '../../services/crm/ai/kiniToolsV2.service';
import { isToolAllowedForRole } from '../../services/crm/ai/kiniTools.service';
import {
  isConfirmRequired,
  createPendingCollector,
  pendingActionText,
  PENDING_TOOL_RESULT,
  doneText,
  labelForTool,
} from '../../services/crm/ai/kiniApproval.service';
import { isAgenticV2Enabled } from '../../services/crm/ai/kiniFlags.service';
import {
  buildContextBlock,
  planningInstruction,
  type KiniContext,
} from '../../services/crm/ai/kiniContext.service';
import { getKiniDomainContext } from '../../services/crm/ai/orgAiContext';
import {
  formatMemoryForPrompt,
  listMemory,
  setMemory,
  deleteMemory,
} from '../../services/crm/ai/kiniMemory.service';
import {
  createThread,
  getThread,
  listThreads,
  deleteThread as removeThread,
  appendMessages,
  setTitle,
} from '../../services/crm/ai/kiniThreads.service';
import { logToolCall } from '../../services/crm/ai/kiniObservability.service';
import * as kiniQuota from '../../services/crm/ai/kiniQuota.service';
import { logger } from '../../lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthUser = any;

function platformOf(req: AuthRequest): 'web' | 'ios' | 'android' {
  const raw = (req.headers['x-kinematic-platform'] as string | undefined ?? '').toLowerCase().trim();
  return raw === 'ios' || raw === 'android' ? raw : 'web';
}

// ── Streaming tool labels ─────────────────────────────────────────────────────
// Friendly, present-progressive labels for the common read/lookup tools shown in
// the streaming UI while a tool runs. Confirm-required (write) tools reuse the
// approval-gate labels via labelForTool(); anything unmapped is prettified from
// its snake_case name.
const STREAM_TOOL_LABELS: Record<string, string> = {
  crm_search_leads: 'Searching leads',
  crm_search_deals: 'Searching deals',
  crm_search_activities: 'Searching activities',
  crm_get_lead: 'Looking up lead',
  crm_get_deal: 'Looking up deal',
  crm_top_leads_by_score: 'Ranking top leads',
  crm_pipeline_summary: 'Summarizing pipeline',
  crm_deals_closing: 'Finding deals closing soon',
  crm_rep_leaderboard: 'Building rep leaderboard',
  crm_conversion_funnel: 'Computing conversion funnel',
  crm_summarize_account: 'Summarizing account',
  crm_draft_email: 'Drafting email',
  remember_fact: 'Saving to memory',
  ff_visits_today: "Checking today's visits",
  ff_attendance_today: "Checking today's attendance",
  ff_live_locations: 'Fetching live locations',
};

/** Strip the module prefix and Title-Case a snake_case tool name. */
function prettifyToolName(tool: string): string {
  return tool
    .replace(/^(crm|ff|kini|analytics|dist)_/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Human label for a tool in a streaming `tool_call` event. */
function labelFor(tool: string): string {
  if (STREAM_TOOL_LABELS[tool]) return STREAM_TOOL_LABELS[tool];
  const known = labelForTool(tool); // write / confirm-required tools carry labels
  if (known && known !== tool) return known;
  return prettifyToolName(tool);
}

async function gate(req: AuthRequest, res: Response): Promise<boolean> {
  const user = req.user as AuthUser;
  const enabled = await isAgenticV2Enabled(user.org_id, user.client_id ?? null);
  if (!enabled) {
    res.status(403).json({
      success: false,
      error: 'Agentic v2 is not enabled for this tenant.',
      code: 'KINI_V2_DISABLED',
    });
    return false;
  }
  return true;
}

// ── Chat ────────────────────────────────────────────────────────────────────
export const chat = asyncHandler(async (req: AuthRequest, res: Response) => {
 try {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const { org_id, client_id, id: user_id, role, full_name, city } = user;

  const {
    messages,
    context,
    thread_id: clientThreadId,
    system: extraSystem,
  } = req.body as {
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
    context?: KiniContext;
    thread_id?: string;
    system?: string;
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest(res, 'messages is required');
  }

  // Tenant gate — the cross-tenant ("all clients") view is allowed ONLY for
  // super_admin. Resolve the caller's client: JWT-pinned client_id, else a
  // valid X-Client-Id picker header. A non-super_admin with no client in
  // scope is blocked so they can never browse another tenant's data via KINI.
  const headerClient = (req.headers['x-client-id'] as string | undefined)?.trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const effectiveClientId: string | null =
    client_id || (headerClient && UUID_RE.test(headerClient) ? headerClient : null);
  const isSuperAdmin = String(role ?? '').toLowerCase() === 'super_admin';
  if (!effectiveClientId && !isSuperAdmin) {
    return ok(res, {
      text: "Select a client from the workspace switcher to use KINI — it stays scoped to that client's data.",
      cards: [],
      tool_calls: [],
      thread_id: null,
    });
  }

  // Quota gate — v2 chat meters exactly like the legacy v1 path so the
  // upgrade doesn't silently make KINI unlimited. Mirrors the 429 shape the
  // clients already handle for v1.
  const actor = { id: user_id, org_id, role, client_id: effectiveClientId };
  const platform = platformOf(req);
  const gateQuota = await kiniQuota.checkQuota(actor);
  if (!gateQuota.allowed) {
    const code = gateQuota.reason ?? 'USER_KINI_LIMIT_REACHED';
    const msg = code === 'ORG_KINI_LIMIT_REACHED'
      ? `Your organization has reached its monthly AI limit (${gateQuota.org_cap ?? gateQuota.cap} queries). Resets on the 1st.`
      : `Monthly AI limit reached (${gateQuota.cap} queries). Resets on the 1st.`;
    return res.status(429).json({
      success: false,
      error: { code, message: msg },
      data: {
        usage: {
          used: gateQuota.used, cap: gateQuota.cap, remaining: 0,
          month: gateQuota.month, exempt: gateQuota.exempt, limit_reached: true,
          reason: code, org_used: gateQuota.org_used, org_cap: gateQuota.org_cap,
        },
      },
    });
  }

  // Resolve thread. A client that passes a thread_id opts into persistent
  // history (we load prior turns and append the new ones). A client that
  // passes NO thread_id runs EPHEMERAL: we answer from the messages it sent
  // and persist nothing. This keeps the stateless web/iOS/Android chat
  // clients — which resend their full history every turn — from spawning a
  // throwaway thread row per message (and from double-counting history that
  // they already include). Threads remain available for a future history UI.
  let thread: Awaited<ReturnType<typeof getThread>> = null;
  const thread_id = clientThreadId ?? null;
  if (thread_id) {
    const r = await getThread(thread_id, user_id);
    if (!r) return notFound(res, 'Thread not found');
    thread = r;
  }

  // Assemble system prompt: identity + role + context + memory + planning.
  const [memoryBlock] = await Promise.all([formatMemoryForPrompt(user_id)]);
  const contextBlock = buildContextBlock(context, {
    user_id,
    org_id,
    client_id: effectiveClientId,
    role,
    full_name,
    city,
  });

  const domainContext = await getKiniDomainContext(org_id);

  const systemPrompt = [
    extraSystem || '',
    "You are KINI, Kinematic's agentic platform copilot.",
    'You have tools that span CRM, Field Force, Distribution, Analytics, and Admin. Pick the right tool for the question; do not explain how to do things manually.',
    'You can CREATE and UPDATE records — leads, deals, contacts, accounts, tasks, and activities — and take Field Force actions. When the user asks you to add, create, log, update, or convert something ("add a lead for Rahul from Acme", "log a visit", "create a deal worth 2 lakh"), CALL the matching tool and actually do it. NEVER reply that you cannot create leads or take actions; if you have the details, act; if a required detail is missing, ask one short follow-up question, then act.',
    'You can DRAFT messages for the user to review and send — an email, a WhatsApp/SMS message, or a call script. Drafting is just writing text: put a short, ready-to-send draft directly in your reply. Use the lookup tools only to find who the message is for; you do NOT need a tool to write a draft, and a lookup returning an error is never a reason to refuse — draft it anyway and note any assumption (e.g. the contact\'s name).',
    'To actually SEND a WhatsApp (not just draft), call crm_send_whatsapp with the recipient (lead_id / contact_id, or a phone in "to") and the body. Only send when the user EXPLICITLY asks to send — otherwise show the draft and ask them to confirm first. After a successful send, confirm in one short line.',
    'Default currency is INR (₹). Indian numbering: "2 lakh" = 200000, "1 crore" = 10000000.',
    'When a tool returns a card, the UI renders it — confirm in 1-2 short sentences and do not repeat full record details in your text reply.',
    contextBlock,
    domainContext ? `Company and product knowledge (use when relevant):\n${domainContext}` : '',
    memoryBlock,
    planningInstruction(),
  ]
    .filter(Boolean)
    .join('\n\n');

  // Prepend prior thread turns (capped) so the model has conversation memory.
  const priorMessages = thread
    ? thread.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content || '',
        }))
    : [];
  const fullMessages = [...priorMessages, ...messages] as Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }>;

  // Human-in-the-loop approval gate. When the model calls a confirm-required
  // tool (a CRM mutation or crm_send_whatsapp) we do NOT execute it — we record
  // the first such call as a pending_action and hand the model a "not executed"
  // tool_result so it wraps up by asking the user to confirm. The client then
  // POSTs the echoed action to /kini/v2/confirm to actually run it.
  const pending = createPendingCollector();

  const turnStart = Date.now();
  try {
    const result = await chatWithTools({
      org_id,
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      max_turns: 8,
      system: systemPrompt,
      tools: toAnthropicTools(),
      messages: fullMessages,
      onToolCall: async (name, args) => {
        // Intercept confirm-required writes BEFORE execution. First one wins;
        // any further write in this turn is likewise refused (never executed).
        if (isConfirmRequired(name)) {
          pending.record(name, (args ?? {}) as Record<string, unknown>);
          return { data: PENDING_TOOL_RESULT };
        }
        const t0 = Date.now();
        try {
          const r = await executeTool(
            org_id,
            effectiveClientId,
            name,
            args as Record<string, unknown>,
            // Thread the active city scope (from the client's KiniContext —
            // mirrors the dashboard's global `?city=`) and the operator role
            // so tools can city-scope reads and the RBAC gate can apply.
            { user_id, city: context?.city ?? null, role: role ?? null },
          );
          const out = r ?? { data: { error: `Unknown tool: ${name}` } };
          let resultSize = 0;
          try {
            resultSize = JSON.stringify(out).length;
          } catch {
            /* unstringifiable result — leave size at 0 */
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const errMsg = (out as any)?.data?.error as string | undefined;
          logToolCall({
            org_id,
            client_id: effectiveClientId,
            user_id,
            thread_id,
            tool_name: name,
            args,
            result_size: resultSize,
            success: !errMsg,
            error_code: errMsg ? 'TOOL_ERROR' : undefined,
            latency_ms: Date.now() - t0,
          });
          return out;
        } catch (e) {
          logToolCall({
            org_id,
            client_id: client_id ?? null,
            user_id,
            thread_id,
            tool_name: name,
            args,
            success: false,
            error_code: 'TOOL_EXCEPTION',
            latency_ms: Date.now() - t0,
          });
          throw e;
        }
      },
    });

    // If a write was queued for confirmation, the chat line is deterministic
    // ("Ready to … — confirm to proceed.") regardless of the model's wrap-up,
    // and we attach the pending_action below. Otherwise use the model reply.
    const pendingAction = pending.get();
    const text = pendingAction
      ? pendingActionText(pendingAction)
      : result.reply ||
        (result.tool_calls.length > 0
          ? 'Done — see the results above.'
          : "Sorry, I couldn't generate a response for that. Could you rephrase?");

    // Persist the user's last turn + the assistant turn into the thread.
    if (thread_id) {
      const lastUserMsg = messages[messages.length - 1];
      const userContent =
        typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg?.content);
      await appendMessages(thread_id, [
        {
          role: 'user',
          content: userContent,
          tool_calls: null,
          cards: null,
          tokens_in: null,
          tokens_out: null,
        },
        {
          role: 'assistant',
          content: text,
          tool_calls: result.tool_calls.map((t) => ({ name: t.name, args: t.args })),
          cards: result.cards,
          tokens_in: null,
          tokens_out: null,
        },
      ]);
      // Auto-title an untitled thread from the user's first message.
      if (thread && !thread.thread.title && userContent) {
        await setTitle(thread_id, user_id, userContent.slice(0, 80));
      }
    }

    // Meter the successful turn + return the fresh usage view so the client's
    // quota badge updates exactly as it did on v1.
    const tokenUsage = (result as { usage?: { input?: number; output?: number } }).usage;
    void kiniQuota.recordQuery(actor, tokenUsage, platform);
    const usage = await kiniQuota.getUsage(actor);

    return ok(res, {
      text,
      cards: result.cards,
      tool_calls: result.tool_calls.map((t) => ({ name: t.name, args: t.args })),
      // Only present when a write was queued for user confirmation. A client
      // that ignores it simply won't execute the write (backward-compatible).
      ...(pendingAction ? { pending_action: pendingAction } : {}),
      usage,
      thread_id,
      took_ms: Date.now() - turnStart,
    });
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ee = e as any;
    if (ee?.code === 'CONFIG_ERROR') {
      return ok(res, {
        text: 'AI features require ANTHROPIC_API_KEY to be set on the server.',
        cards: [],
        tool_calls: [],
        thread_id,
      });
    }
    logger.error(`[kini.v2.chat] error: ${ee?.message || ee}`);
    return ok(res, {
      text: 'I hit an error processing that — try again?',
      cards: [],
      tool_calls: [],
      thread_id,
    });
  }
 } catch (e: unknown) {
    // Errors thrown BEFORE the model call (gate / quota / memory / context)
    // would otherwise escape to the generic error envelope the clients render
    // as the opaque "I apologize…" fallback. Surface the real reason to a
    // super_admin so a broken chat is diagnosable.
    if (res.headersSent) return;
    const role = String((req.user as { role?: string } | undefined)?.role || '').toLowerCase();
    const detail = (e as { message?: string })?.message || 'unknown error';
    logger.error(`[kini.v2.chat] pre-flight error: ${detail}`);
    return ok(res, {
      text: role === 'super_admin' ? `KINI hit a server error: ${detail}` : 'I ran into a problem on my end — please try again.',
      cards: [],
      tool_calls: [],
      thread_id: null,
    });
  }
});

// ── Chat (SSE streaming) ─────────────────────────────────────────────────────
// Additive, non-breaking mirror of `chat` that streams the turn over
// Server-Sent Events for a live typing UX. ALL gate/quota/scope/thread checks
// run BEFORE any SSE byte is written, and on failure return the SAME JSON
// status/shape as buffered `chat` so a client can fall back to POST /v2/chat.
// Once streaming starts the event contract is:
//   start → (tool_call | card | token)* → pending_action? → usage → done
// with `error` replacing the tail on a mid-stream failure.
export const chatStream = asyncHandler(async (req: AuthRequest, res: Response) => {
 try {
  // ---- Pre-flight (identical to `chat`): NOTHING is streamed yet, so any
  // failure below returns the same JSON envelope the buffered path returns. ----
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const { org_id, client_id, id: user_id, role, full_name, city } = user;

  const {
    messages,
    context,
    thread_id: clientThreadId,
    system: extraSystem,
  } = req.body as {
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
    context?: KiniContext;
    thread_id?: string;
    system?: string;
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest(res, 'messages is required');
  }

  const headerClient = (req.headers['x-client-id'] as string | undefined)?.trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const effectiveClientId: string | null =
    client_id || (headerClient && UUID_RE.test(headerClient) ? headerClient : null);
  const isSuperAdmin = String(role ?? '').toLowerCase() === 'super_admin';
  if (!effectiveClientId && !isSuperAdmin) {
    return ok(res, {
      text: "Select a client from the workspace switcher to use KINI — it stays scoped to that client's data.",
      cards: [],
      tool_calls: [],
      thread_id: null,
    });
  }

  const actor = { id: user_id, org_id, role, client_id: effectiveClientId };
  const platform = platformOf(req);
  const gateQuota = await kiniQuota.checkQuota(actor);
  if (!gateQuota.allowed) {
    const code = gateQuota.reason ?? 'USER_KINI_LIMIT_REACHED';
    const msg = code === 'ORG_KINI_LIMIT_REACHED'
      ? `Your organization has reached its monthly AI limit (${gateQuota.org_cap ?? gateQuota.cap} queries). Resets on the 1st.`
      : `Monthly AI limit reached (${gateQuota.cap} queries). Resets on the 1st.`;
    return res.status(429).json({
      success: false,
      error: { code, message: msg },
      data: {
        usage: {
          used: gateQuota.used, cap: gateQuota.cap, remaining: 0,
          month: gateQuota.month, exempt: gateQuota.exempt, limit_reached: true,
          reason: code, org_used: gateQuota.org_used, org_cap: gateQuota.org_cap,
        },
      },
    });
  }

  let thread: Awaited<ReturnType<typeof getThread>> = null;
  const thread_id = clientThreadId ?? null;
  if (thread_id) {
    const r = await getThread(thread_id, user_id);
    if (!r) return notFound(res, 'Thread not found');
    thread = r;
  }

  const [memoryBlock] = await Promise.all([formatMemoryForPrompt(user_id)]);
  const contextBlock = buildContextBlock(context, {
    user_id,
    org_id,
    client_id: effectiveClientId,
    role,
    full_name,
    city,
  });

  const domainContext = await getKiniDomainContext(org_id);

  const systemPrompt = [
    extraSystem || '',
    "You are KINI, Kinematic's agentic platform copilot.",
    'You have tools that span CRM, Field Force, Distribution, Analytics, and Admin. Pick the right tool for the question; do not explain how to do things manually.',
    'You can CREATE and UPDATE records — leads, deals, contacts, accounts, tasks, and activities — and take Field Force actions. When the user asks you to add, create, log, update, or convert something ("add a lead for Rahul from Acme", "log a visit", "create a deal worth 2 lakh"), CALL the matching tool and actually do it. NEVER reply that you cannot create leads or take actions; if you have the details, act; if a required detail is missing, ask one short follow-up question, then act.',
    'You can DRAFT messages for the user to review and send — an email, a WhatsApp/SMS message, or a call script. Drafting is just writing text: put a short, ready-to-send draft directly in your reply. Use the lookup tools only to find who the message is for; you do NOT need a tool to write a draft, and a lookup returning an error is never a reason to refuse — draft it anyway and note any assumption (e.g. the contact\'s name).',
    'To actually SEND a WhatsApp (not just draft), call crm_send_whatsapp with the recipient (lead_id / contact_id, or a phone in "to") and the body. Only send when the user EXPLICITLY asks to send — otherwise show the draft and ask them to confirm first. After a successful send, confirm in one short line.',
    'Default currency is INR (₹). Indian numbering: "2 lakh" = 200000, "1 crore" = 10000000.',
    'When a tool returns a card, the UI renders it — confirm in 1-2 short sentences and do not repeat full record details in your text reply.',
    contextBlock,
    domainContext ? `Company and product knowledge (use when relevant):\n${domainContext}` : '',
    memoryBlock,
    planningInstruction(),
  ]
    .filter(Boolean)
    .join('\n\n');

  const priorMessages = thread
    ? thread.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content || '',
        }))
    : [];
  const fullMessages = [...priorMessages, ...messages] as Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }>;

  const pending = createPendingCollector();

  // ---- All checks passed. Begin the event stream. ----
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  res.flushHeaders?.();

  // Write one SSE frame: `event: <name>\n` + `data: <json>\n\n`, flushing if the
  // runtime supports it (e.g. behind compression middleware).
  const sse = (event: string, dataObj: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).flush?.();
  };

  sse('start', { thread_id });

  const turnStart = Date.now();
  try {
    const result = await chatWithTools({
      org_id,
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      max_turns: 8,
      system: systemPrompt,
      tools: toAnthropicTools(),
      messages: fullMessages,
      // Translate the aiClient stream events into SSE frames.
      onEvent: (ev) => {
        if (ev.kind === 'token') {
          sse('token', { text: ev.text });
        } else if (ev.kind === 'tool_call') {
          const payload: Record<string, unknown> = {
            tool: ev.tool,
            label: labelFor(ev.tool),
            phase: ev.phase,
          };
          if (ev.phase === 'done') payload.ok = ev.ok;
          sse('tool_call', payload);
        } else if (ev.kind === 'card') {
          sse('card', ev.card);
        }
      },
      onToolCall: async (name, args) => {
        // IDENTICAL approval gate + execution + logging as `chat`.
        if (isConfirmRequired(name)) {
          pending.record(name, (args ?? {}) as Record<string, unknown>);
          return { data: PENDING_TOOL_RESULT };
        }
        const t0 = Date.now();
        try {
          const r = await executeTool(
            org_id,
            effectiveClientId,
            name,
            args as Record<string, unknown>,
            { user_id, city: context?.city ?? null, role: role ?? null },
          );
          const out = r ?? { data: { error: `Unknown tool: ${name}` } };
          let resultSize = 0;
          try {
            resultSize = JSON.stringify(out).length;
          } catch {
            /* unstringifiable result — leave size at 0 */
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const errMsg = (out as any)?.data?.error as string | undefined;
          logToolCall({
            org_id,
            client_id: effectiveClientId,
            user_id,
            thread_id,
            tool_name: name,
            args,
            result_size: resultSize,
            success: !errMsg,
            error_code: errMsg ? 'TOOL_ERROR' : undefined,
            latency_ms: Date.now() - t0,
          });
          return out;
        } catch (e) {
          logToolCall({
            org_id,
            client_id: client_id ?? null,
            user_id,
            thread_id,
            tool_name: name,
            args,
            success: false,
            error_code: 'TOOL_EXCEPTION',
            latency_ms: Date.now() - t0,
          });
          throw e;
        }
      },
    });

    const pendingAction = pending.get();
    const text = pendingAction
      ? pendingActionText(pendingAction)
      : result.reply ||
        (result.tool_calls.length > 0
          ? 'Done — see the results above.'
          : "Sorry, I couldn't generate a response for that. Could you rephrase?");

    if (thread_id) {
      const lastUserMsg = messages[messages.length - 1];
      const userContent =
        typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg?.content);
      await appendMessages(thread_id, [
        {
          role: 'user',
          content: userContent,
          tool_calls: null,
          cards: null,
          tokens_in: null,
          tokens_out: null,
        },
        {
          role: 'assistant',
          content: text,
          tool_calls: result.tool_calls.map((t) => ({ name: t.name, args: t.args })),
          cards: result.cards,
          tokens_in: null,
          tokens_out: null,
        },
      ]);
      if (thread && !thread.thread.title && userContent) {
        await setTitle(thread_id, user_id, userContent.slice(0, 80));
      }
    }

    const tokenUsage = (result as { usage?: { input?: number; output?: number } }).usage;
    void kiniQuota.recordQuery(actor, tokenUsage, platform);
    const usage = await kiniQuota.getUsage(actor);

    // Tail of the stream, in the order the client expects.
    if (pendingAction) sse('pending_action', pendingAction);
    sse('usage', usage);
    sse('done', {
      text,
      cards: result.cards,
      tool_calls: result.tool_calls.map((t) => ({ name: t.name, args: t.args })),
      pending_action: pendingAction ?? null,
      thread_id,
      took_ms: Date.now() - turnStart,
    });
    return res.end();
  } catch (e) {
    // Error AFTER the stream opened. Headers are already sent, so we cannot
    // switch to a JSON body — surface an SSE `error` frame and close.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ee = e as any;
    if (ee?.code === 'CONFIG_ERROR') {
      sse('error', { message: 'AI features require ANTHROPIC_API_KEY to be set on the server.' });
      return res.end();
    }
    logger.error(`[kini.v2.chatStream] error: ${ee?.message || ee}`);
    sse('error', { message: 'I hit an error processing that — try again?' });
    return res.end();
  }
 } catch (e: unknown) {
    // Pre-flight error (gate / quota / scope / memory / context) — thrown BEFORE
    // any SSE byte. If nothing was streamed, fall back to the buffered JSON
    // envelope the clients render; if headers somehow went out already, close
    // the stream with an error frame instead.
    const detail = (e as { message?: string })?.message || 'unknown error';
    if (res.headersSent) {
      logger.error(`[kini.v2.chatStream] post-header error: ${detail}`);
      try {
        res.write('event: error\n');
        res.write(`data: ${JSON.stringify({ message: 'I ran into a problem on my end — please try again.' })}\n\n`);
      } catch {
        /* socket already gone */
      }
      return res.end();
    }
    const role = String((req.user as { role?: string } | undefined)?.role || '').toLowerCase();
    logger.error(`[kini.v2.chatStream] pre-flight error: ${detail}`);
    return ok(res, {
      text: role === 'super_admin' ? `KINI hit a server error: ${detail}` : 'I ran into a problem on my end — please try again.',
      cards: [],
      tool_calls: [],
      thread_id: null,
    });
  }
});

// ── Confirm (human-in-the-loop approval gate) ────────────────────────────────
// Executes a pending_action that /chat previously queued. NO Anthropic call —
// the tool runs deterministically. Same tenant/client scoping + RBAC as chat.
export const confirm = asyncHandler(async (req: AuthRequest, res: Response) => {
 try {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const { org_id, client_id, id: user_id, role } = user;

  // Rebuild the SAME scoping chat uses: JWT-pinned client_id, else a valid
  // X-Client-Id picker header. A non-super_admin with no client in scope is
  // blocked so a confirm can never execute against another tenant's data.
  const headerClient = (req.headers['x-client-id'] as string | undefined)?.trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const effectiveClientId: string | null =
    client_id || (headerClient && UUID_RE.test(headerClient) ? headerClient : null);
  const isSuperAdmin = String(role ?? '').toLowerCase() === 'super_admin';
  if (!effectiveClientId && !isSuperAdmin) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'KINI_NO_CLIENT_SCOPE',
        message: "Select a client from the workspace switcher before confirming — KINI stays scoped to that client's data.",
      },
    });
  }

  // Validate the echoed action.
  const action = (req.body as { action?: { id?: unknown; tool?: unknown; args?: unknown } })?.action;
  if (!action || typeof action !== 'object') {
    return res.status(400).json({ success: false, error: { code: 'BAD_ACTION', message: 'action { id, tool, args } is required.' } });
  }
  const tool = typeof action.tool === 'string' ? action.tool : '';
  const args = (action.args && typeof action.args === 'object' && !Array.isArray(action.args))
    ? (action.args as Record<string, unknown>)
    : {};
  if (!tool) {
    return res.status(400).json({ success: false, error: { code: 'BAD_ACTION', message: 'action.tool is required.' } });
  }
  // Only confirm-required tools may be executed here — a read or an unknown
  // tool is rejected (they never produce a pending_action).
  if (!isConfirmRequired(tool)) {
    return res.status(400).json({ success: false, error: { code: 'NOT_CONFIRMABLE', message: `"${tool}" is not a confirmable action.` } });
  }
  // Re-validate RBAC for (role, tool) — the same gate chat applies before it
  // would have executed the tool.
  if (!isToolAllowedForRole(role ?? null, tool)) {
    return res.status(403).json({ success: false, error: { code: 'ROLE_FORBIDDEN', message: `Your role (${String(role ?? '').trim() || 'unknown'}) can't perform ${tool}.` } });
  }

  // City scope only affects reads (all confirm-required tools are writes), but
  // pass it through for ctx parity with chat if the client sent it.
  const ctxCity =
    typeof req.query.city === 'string' && req.query.city.trim()
      ? req.query.city.trim()
      : (req.body as { context?: { city?: unknown } })?.context?.city;
  const ctx = { user_id, city: typeof ctxCity === 'string' ? ctxCity : null, role: role ?? null };

  const platform = platformOf(req);
  const t0 = Date.now();
  const result = await executeTool(org_id, effectiveClientId, tool, args, ctx);
  if (!result) {
    return res.status(400).json({ success: false, error: { code: 'UNKNOWN_TOOL', message: `Tool "${tool}" is not registered.` } });
  }
  // The tool swallows scope/validation failures into { data: { error } } rather
  // than throwing (so a chat turn can recover) — surface those as a 4xx here.
  const toolErr = (result.data as { error?: unknown } | null | undefined)?.error;
  if (typeof toolErr === 'string' && toolErr) {
    logToolCall({
      org_id, client_id: effectiveClientId, user_id, thread_id: null,
      tool_name: tool, args, success: false, error_code: 'TOOL_ERROR', latency_ms: Date.now() - t0,
    });
    return res.status(400).json({ success: false, error: { code: 'ACTION_FAILED', message: toolErr } });
  }

  logToolCall({
    org_id, client_id: effectiveClientId, user_id, thread_id: null,
    tool_name: tool, args, result_size: 0, success: true, latency_ms: Date.now() - t0,
  });

  // Meter the confirmed action as one KINI action (no Anthropic call → 0
  // tokens). Best-effort, non-blocking — mirrors how chat records a query.
  const actor = { id: user_id, org_id, role, client_id: effectiveClientId };
  void kiniQuota.recordQuery(actor, undefined, platform);

  return ok(res, {
    text: doneText(tool, result.data),
    cards: result.card ? [result.card] : [],
  });
 } catch (e: unknown) {
    if (res.headersSent) return;
    const detail = (e as { message?: string })?.message || 'unknown error';
    logger.error(`[kini.v2.confirm] error: ${detail}`);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Failed to run that action — please try again.' } });
  }
});

// ── Threads CRUD ────────────────────────────────────────────────────────────
export const threadsList = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const threads = await listThreads(user.id, limit);
  return ok(res, { threads });
});

export const threadGet = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const r = await getThread(req.params.id, user.id);
  if (!r) return notFound(res, 'Thread not found');
  return ok(res, r);
});

export const threadCreate = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const created = await createThread(
    user.id,
    user.org_id,
    user.client_id ?? null,
    typeof req.body?.title === 'string' ? req.body.title : undefined,
  );
  if (!created) {
    return res.status(500).json({ success: false, error: 'Failed to create thread' });
  }
  return ok(res, created);
});

export const threadDelete = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const success = await removeThread(req.params.id, user.id);
  if (!success) return notFound(res, 'Thread not found');
  return ok(res, { deleted: true });
});

export const threadRename = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const title = String(req.body?.title || '').trim();
  if (!title) return badRequest(res, 'title is required');
  const success = await setTitle(req.params.id, user.id, title);
  if (!success) return notFound(res, 'Thread not found');
  return ok(res, { renamed: true });
});

// ── Memory CRUD ─────────────────────────────────────────────────────────────
export const memoryList = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const entries = await listMemory(user.id);
  return ok(res, { entries });
});

export const memorySet = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const key = String(req.params.key || '').trim();
  const value = String(req.body?.value || '').trim();
  if (!key || !value) return badRequest(res, 'key and value are required');
  const entry = await setMemory(user.id, user.org_id, key, value, {
    source: 'user',
    pinned: Boolean(req.body?.pinned),
  });
  if (!entry) {
    return res.status(500).json({ success: false, error: 'Failed to set memory' });
  }
  return ok(res, entry);
});

export const memoryDelete = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!(await gate(req, res))) return;
  const user = req.user as AuthUser;
  const success = await deleteMemory(user.id, String(req.params.key));
  return ok(res, { deleted: success });
});
