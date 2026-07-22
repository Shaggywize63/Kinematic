// Per-request context + guard helpers shared by every MCP tool.
//
// The guard chain mirrors the HTTP stack exactly, so a connected assistant can
// never exceed the user's own permissions:
//   1. scope   — the user consented to this capability (req.oauth.scopes)
//   2. module  — the user's role permits read/write on the CRM module (RBAC)
//   3. write   — the account is not read-only (readOnlyGuard equivalent)
// Effective capability = granted scope ∩ the user's role. Data is always
// org-scoped (and client-scoped when the user is client-pinned), and own-scope
// roles are further narrowed to their own records.

import { AuthRequest } from '../types';
import { moduleAccessAllowed } from '../middleware/rbac';
import { currentProjectKey } from '../lib/projects';
import { recordAudit } from '../lib/oauth/store';
import type { OAuthScope } from '../lib/oauth/scopes';

type ToolContent = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface McpCtx {
  user: NonNullable<AuthRequest['user']>;
  scopes: string[];
  clientId: string;             // the OAuth client (ChatGPT/Claude) — for audit
  orgId: string;
  userId: string;
  userClientId: string | null;  // the user's pinned client_id, if any
  projectKey: string;
  /** Own-scope roles are constrained to records they own/are assigned. */
  ownScope: boolean;
}

export function mcpCtxFromReq(req: AuthRequest): McpCtx {
  const user = req.user!;
  const role = (user.role || '').toLowerCase();
  const isAdminish = ['super_admin', 'admin', 'main_admin'].includes(role);
  return {
    user,
    scopes: req.oauth?.scopes ?? [],
    clientId: req.oauth?.clientId ?? 'unknown',
    orgId: user.org_id,
    userId: user.id,
    userClientId: (user.client_id as string) ?? null,
    projectKey: currentProjectKey(),
    ownScope: !isAdminish && user.org_role_data_scope === 'own',
  };
}

export function textResult(text: string): ToolContent {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolContent {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Enforce scope + module + read-only for a tool. Returns an error ToolContent
 * when denied (the tool should return it verbatim), or null when allowed.
 */
export function denyIfNotAllowed(
  ctx: McpCtx,
  opts: { scope: OAuthScope; module: string; write?: boolean },
): ToolContent | null {
  if (!ctx.scopes.includes(opts.scope)) {
    return errorResult(`This connection wasn't granted the "${opts.scope}" permission. Ask the account owner to reconnect and allow it.`);
  }
  if (opts.write && ctx.user.is_read_only) {
    return errorResult('This account is read-only — the assistant can view data but cannot make changes.');
  }
  if (!moduleAccessAllowed(ctx.user, opts.module, !!opts.write)) {
    return errorResult(`Your role doesn't allow ${opts.write ? 'changing' : 'viewing'} this data (${opts.module}).`);
  }
  return null;
}

/**
 * Extra crud opts that narrow reads to what the user may see: own-scope roles
 * are limited to records they own/are assigned to. Tenant isolation (org +
 * client) is applied separately by the caller via clientScopedList.
 */
export function ownerScopeOpts(ctx: McpCtx, columns: string[] = ['owner_id']): { userScope?: { user_id: string; columns: string[] } } {
  if (!ctx.ownScope) return {};
  return { userScope: { user_id: ctx.userId, columns } };
}

/** Fire-and-forget audit of an assistant action. */
export async function audit(ctx: McpCtx, entry: {
  tool: string; targetType?: string; targetId?: string; request?: unknown;
  outcome?: 'ok' | 'denied' | 'error'; error?: string;
}): Promise<void> {
  await recordAudit({
    clientId: ctx.clientId,
    userId: ctx.userId,
    projectKey: ctx.projectKey,
    orgId: ctx.orgId,
    tool: entry.tool,
    scopes: ctx.scopes,
    targetType: entry.targetType,
    targetId: entry.targetId,
    request: entry.request,
    outcome: entry.outcome,
    error: entry.error,
  });
}
