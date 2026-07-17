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
import { isAgenticV2Enabled } from '../../services/crm/ai/kiniFlags.service';
import {
  buildContextBlock,
  planningInstruction,
  type KiniContext,
} from '../../services/crm/ai/kiniContext.service';
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

  const systemPrompt = [
    extraSystem || '',
    "You are KINI, Kinematic's agentic platform copilot.",
    'You have tools that span CRM, Field Force, Distribution, Analytics, and Admin. Pick the right tool for the question; do not explain how to do things manually.',
    'When a tool returns a card, the UI renders it — confirm in 1-2 short sentences and do not repeat full record details in your text reply.',
    contextBlock,
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
        const t0 = Date.now();
        try {
          const r = await executeTool(
            org_id,
            effectiveClientId,
            name,
            args as Record<string, unknown>,
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

    // Never return empty text — clients render that as a generic apology.
    const text =
      result.reply ||
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
