import { createHash } from 'crypto';
import { logger } from './logger';

/**
 * POST /auth/refresh engine + GoTrue error classification.
 *
 * WHY THIS EXISTS (the "users keep getting logged out" investigation):
 *
 *  1. The old controller answered **401 "Invalid or expired refresh token" for EVERY GoTrue failure** —
 *     a GoTrue outage / timeout / 5xx / rate limit looked exactly like a revoked refresh token. Both
 *     mobile apps read a 4xx from /auth/refresh as "the session is dead" and wipe the local session.
 *     So one GoTrue blip signed out every phone that happened to refresh in that window.
 *     `classifyAuthError` separates a DEFINITIVE rejection (-> 401) from a retryable one (-> 503).
 *
 *  2. A refresh response that never reaches the phone (app backgrounded / process killed / cell handover
 *     mid-request) leaves the phone holding a refresh token GoTrue has already rotated. Its next refresh
 *     is a "reuse" and, outside GoTrue's tiny reuse interval, revokes the whole session family -> logout.
 *     `performRefresh` keeps a short in-memory REPLAY window: the same refresh token presented again
 *     within `replayTtlMs` gets the SAME new session back instead of hitting GoTrue a second time.
 *     Concurrent duplicates are coalesced into one GoTrue call for the same reason.
 *     (Per ECS task only — see the report: GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL is the
 *     cluster-wide counterpart.)
 *
 *  3. A refresh token is minted by exactly one Supabase project. A client whose session pre-dates the
 *     multi-project header (or lost it) refreshes against the default (Tata) project, which answers "not
 *     found" for a Kinematic token. On a definitive rejection we therefore try the other projects before
 *     declaring the token dead.
 */

export type AuthErrorLike = { status?: number; code?: string; name?: string; message?: string } | null | undefined;

export type AuthErrorClass = 'rejected' | 'unavailable';

/**
 * Is a GoTrue error a definitive "this credential is no good" answer, or something retryable?
 *
 *  - supabase-js wraps network failures / 5xx / unparseable replies in `AuthRetryableFetchError`
 *    (status 0 or >= 500) — retryable.
 *  - 429 (GoTrue rate limit) and 408 are retryable.
 *  - Other 4xx (400 refresh_token_not_found / refresh_token_already_used / session_not_found,
 *    401 bad_jwt, 403, 404, 422) are definitive.
 *  - Anything we cannot classify is treated as retryable: signing someone out on a guess is the
 *    expensive mistake, a retry is cheap.
 */
export function classifyAuthError(err: AuthErrorLike): AuthErrorClass {
  if (!err) return 'unavailable';
  if (err.name === 'AuthRetryableFetchError') return 'unavailable';
  const status = typeof err.status === 'number' ? err.status : undefined;
  if (status === undefined || status === 0) return 'unavailable';
  if (status === 408 || status === 429 || status >= 500) return 'unavailable';
  if (status >= 400 && status < 500) return 'rejected';
  return 'unavailable';
}

export type RefreshedSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user_id?: string;
};

export type RefreshOutcome =
  | { kind: 'ok'; session: RefreshedSession; project: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'unavailable'; reason: string };

type GoTrueRefreshResult = {
  data?: { session?: { access_token: string; refresh_token: string; expires_at?: number; user?: { id?: string } } | null } | null;
  error?: AuthErrorLike;
};

export interface RefreshDeps {
  /** Calls that project's GoTrue `refreshSession`. May reject (treated as unavailable). */
  refreshOnProject(project: string, refreshToken: string): Promise<GoTrueRefreshResult>;
  /** Every configured project key. */
  allProjects(): string[];
  now?: () => number;
}

const REPLAY_TTL_MS = Math.max(0, Number(process.env.AUTH_REFRESH_REPLAY_SECONDS ?? 120) * 1000);
const REPLAY_MAX = 2000;

type Replay = { outcome: Extract<RefreshOutcome, { kind: 'ok' }>; expiresAt: number; userId?: string };
const replay = new Map<string, Replay>();
const inflight = new Map<string, Promise<RefreshOutcome>>();

const keyOf = (refreshToken: string) => createHash('sha256').update(refreshToken).digest('hex');

/** Test hook. */
export function _resetRefreshState() {
  replay.clear();
  inflight.clear();
}

/** Forget remembered refreshes for a user — called on logout so a signed-out session cannot be replayed. */
export function forgetRefreshReplay(userId: string | undefined | null) {
  if (!userId) return;
  for (const [k, v] of replay) if (v.userId === userId) replay.delete(k);
}

function remember(key: string, outcome: Extract<RefreshOutcome, { kind: 'ok' }>, now: number) {
  if (REPLAY_TTL_MS <= 0) return;
  if (replay.size >= REPLAY_MAX) {
    const first = replay.keys().next().value;
    if (first !== undefined) replay.delete(first);
  }
  replay.set(key, { outcome, expiresAt: now + REPLAY_TTL_MS, userId: outcome.session.user_id });
}

async function attempt(project: string, refreshToken: string, deps: RefreshDeps): Promise<
  | { kind: 'ok'; session: RefreshedSession }
  | { kind: 'rejected'; message: string }
  | { kind: 'unavailable'; reason: string }
> {
  let res: GoTrueRefreshResult;
  try {
    res = await deps.refreshOnProject(project, refreshToken);
  } catch (e) {
    return { kind: 'unavailable', reason: `${project}: ${(e as Error)?.message || 'request failed'}` };
  }
  const s = res?.data?.session;
  if (!res?.error && s?.access_token && s.refresh_token) {
    return {
      kind: 'ok',
      session: {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at,
        user_id: s.user?.id,
      },
    };
  }
  if (res?.error) {
    return classifyAuthError(res.error) === 'rejected'
      ? { kind: 'rejected', message: res.error.message || 'Invalid refresh token' }
      : { kind: 'unavailable', reason: `${project}: ${res.error.message || res.error.status || 'auth error'}` };
  }
  // No error and no usable session: not a statement about the token — retry later.
  return { kind: 'unavailable', reason: `${project}: empty refresh result` };
}

async function run(refreshToken: string, primary: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const first = await attempt(primary, refreshToken, deps);
  if (first.kind === 'ok') return { kind: 'ok', session: first.session, project: primary };
  if (first.kind === 'unavailable') return { kind: 'unavailable', reason: first.reason };

  // Rejected by the project the request was routed to. The token may belong to another project (session
  // that lost / never had the routing header). It is only DEAD if every project says so; if any project
  // could not answer we cannot conclude that.
  let blocked: string | null = null;
  for (const p of deps.allProjects()) {
    if (p === primary) continue;
    const r = await attempt(p, refreshToken, deps);
    if (r.kind === 'ok') {
      logger.info(`[Auth] refresh token belonged to project '${p}', request was routed to '${primary}'`);
      return { kind: 'ok', session: r.session, project: p };
    }
    if (r.kind === 'unavailable') blocked = r.reason;
  }
  if (blocked) return { kind: 'unavailable', reason: blocked };
  return { kind: 'rejected', message: first.message };
}

/**
 * Refresh a session with replay-window + in-flight coalescing. Never throws.
 */
export async function performRefresh(refreshToken: string, primaryProject: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const now = (deps.now ?? Date.now)();
  const key = keyOf(refreshToken);

  const hit = replay.get(key);
  if (hit) {
    if (hit.expiresAt > now) return hit.outcome;
    replay.delete(key);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = run(refreshToken, primaryProject, deps)
    .then((outcome) => {
      if (outcome.kind === 'ok') remember(key, outcome, (deps.now ?? Date.now)());
      return outcome;
    })
    .catch((e): RefreshOutcome => ({ kind: 'unavailable', reason: (e as Error)?.message || 'refresh failed' }))
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}
