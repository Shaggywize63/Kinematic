/**
 * Website chatbot (KINI) controllers.
 *
 *   • publicIngest  — UNAUTHENTICATED, shared-key protected. Called by the
 *     marketing website's kini-chat.php proxy on every conversation turn.
 *     Fixed to the Kinematic marketing project via runWithProject so the
 *     transcript + any created lead land in that tenant regardless of headers.
 *
 *   • listWebChats / getWebChat — authenticated dashboard reads (mounted under
 *     requireAuth in crm.routes.ts), scoped to the caller's org.
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { runWithProject } from '../../lib/projects';
import { AuthRequest } from '../../types';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import * as webChat from '../../services/crm/ai/webChat.service';

const asyncHandler =
  <R extends Request>(fn: (req: R, res: Response, next: NextFunction) => Promise<void>) =>
  (req: R, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

// Which Supabase project stores website chats. The whole feature is
// Kinematic-tenant only; default to 'kinematic' but allow an env override.
const WEB_CHAT_PROJECT = (process.env.KINI_WEB_CHAT_PROJECT || 'kinematic').trim();

function keyOk(req: Request): boolean {
  const expected = (process.env.KINI_WEB_CHAT_KEY || '').trim();
  if (!expected) return false; // never accept when unconfigured
  const provided = String(
    (req.headers['x-kini-key'] as string | undefined) ?? (req.query.key as string | undefined) ?? '',
  );
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, 2000) : null;
}

export const publicIngest = asyncHandler<Request>(async (req, res) => {
  if (!keyOk(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const visitor = (b.visitor ?? {}) as Record<string, unknown>;
  const page = (b.page ?? {}) as Record<string, unknown>;
  const utm = (b.utm ?? {}) as Record<string, unknown>;
  const rawTranscript = Array.isArray(b.transcript) ? (b.transcript as unknown[]) : [];

  const input: webChat.WebChatIngestInput = {
    session_key: String(b.session_key ?? '').slice(0, 200),
    transcript: rawTranscript
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const role = o.role === 'kini' ? 'kini' : o.role === 'visitor' ? 'visitor' : null;
        const content = typeof o.content === 'string' ? o.content : null;
        if (!role || content === null) return null;
        return { role, content, ts: typeof o.ts === 'string' ? o.ts : undefined };
      })
      .filter(Boolean) as webChat.WebChatTurn[],
    visitor: {
      name: str(visitor.name),
      email: str(visitor.email),
      phone: str(visitor.phone),
      company: str(visitor.company),
      team_size: str(visitor.team_size),
      interest: str(visitor.interest),
      city: str(visitor.city),
    },
    page: { url: str(page.url), path: str(page.path), title: str(page.title) },
    referrer_url: str(b.referrer_url),
    landing_page: str(b.landing_page),
    utm: { source: str(utm.source), medium: str(utm.medium), campaign: str(utm.campaign) },
    user_agent: str(req.headers['user-agent']),
  };

  if (!input.session_key) {
    res.status(400).json({ ok: false, error: 'session_key required' });
    return;
  }

  // Health probe from kini-chat.php?selftest — the key matched and we got here,
  // so report success without storing a junk conversation.
  if (input.session_key === '__selftest__') {
    res.status(200).json({ ok: true, selftest: true });
    return;
  }

  try {
    const result = await runWithProject(WEB_CHAT_PROJECT, () => webChat.ingestWebChat(input));
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'webChat.publicIngest failed');
    // Non-fatal for the website — it keeps chatting even if storage failed.
    res.status(200).json({ ok: false, error: 'store_failed' });
  }
});

// ── Authenticated dashboard reads ────────────────────────────────────────

function authOrgId(req: AuthRequest): string {
  const id =
    (req as { user?: { org_id?: string } }).user?.org_id ??
    (req.headers['x-org-id'] as string | undefined);
  if (!id) throw new AppError(400, 'No org context on request', 'NO_ORG');
  return String(id);
}

export const list = asyncHandler<AuthRequest>(async (req, res) => {
  const { rows, total } = await webChat.listWebChats(authOrgId(req), {
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
    search: (req.query.search as string | undefined) ?? undefined,
  });
  res.json({ rows, total });
});

export const detail = asyncHandler<AuthRequest>(async (req, res) => {
  const row = await webChat.getWebChat(authOrgId(req), String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(row);
});
