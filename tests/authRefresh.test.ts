/**
 * /auth/refresh engine. The mobile apps sign the user OUT when this endpoint answers 4xx, so:
 *  - a GoTrue outage / timeout / 5xx / rate limit must NEVER look like a rejected token;
 *  - only a definitive GoTrue 4xx may become "rejected";
 *  - a refresh token presented twice (lost response) must be replayed, not sent to GoTrue again;
 *  - a token that belongs to another project must be found there before it is declared dead.
 */
import { classifyAuthError, performRefresh, forgetRefreshReplay, _resetRefreshState, type RefreshDeps } from '../src/lib/authRefresh';

const session = (n: number, uid = 'user-1') => ({
  data: { session: { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_at: 1000 + n, user: { id: uid } } },
  error: null,
});
const err = (status: number | undefined, name = 'AuthApiError', message = 'boom') => ({ data: { session: null }, error: { status, name, message } });

function deps(map: Record<string, any>, projects = ['default', 'kinematic']): RefreshDeps & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    allProjects: () => projects,
    refreshOnProject: async (project, token) => {
      calls.push([project, token]);
      const r = map[project];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(token) : r;
    },
  };
}

beforeEach(() => _resetRefreshState());

describe('classifyAuthError', () => {
  it.each([
    [{ status: 400, name: 'AuthApiError' }, 'rejected'],
    [{ status: 401, name: 'AuthApiError' }, 'rejected'],
    [{ status: 403, name: 'AuthApiError' }, 'rejected'],
    [{ status: 422, name: 'AuthApiError' }, 'rejected'],
    [{ status: 429, name: 'AuthApiError' }, 'unavailable'],
    [{ status: 408, name: 'AuthApiError' }, 'unavailable'],
    [{ status: 500, name: 'AuthApiError' }, 'unavailable'],
    [{ status: 502, name: 'AuthApiError' }, 'unavailable'],
    [{ status: 503, name: 'AuthApiError' }, 'unavailable'],
    [{ status: 0, name: 'AuthRetryableFetchError' }, 'unavailable'],
    [{ status: 400, name: 'AuthRetryableFetchError' }, 'unavailable'],
    [{ name: 'AuthUnknownError' }, 'unavailable'],
    [undefined, 'unavailable'],
  ])('%j -> %s', (e, want) => {
    expect(classifyAuthError(e as any)).toBe(want);
  });
});

describe('performRefresh', () => {
  it('returns the new session on success', async () => {
    const d = deps({ default: session(1) });
    const r = await performRefresh('refresh-0', 'default', d);
    expect(r).toMatchObject({ kind: 'ok', project: 'default', session: { access_token: 'access-1', refresh_token: 'refresh-1' } });
    expect(d.calls).toEqual([['default', 'refresh-0']]);
  });

  it('GoTrue 5xx / network failure is "unavailable", never "rejected"', async () => {
    for (const e of [err(500), err(503), err(0, 'AuthRetryableFetchError'), err(429)]) {
      _resetRefreshState();
      const r = await performRefresh('refresh-0', 'default', deps({ default: e }));
      expect(r.kind).toBe('unavailable');
    }
  });

  it('a thrown error (fetch exploded) is "unavailable"', async () => {
    const r = await performRefresh('refresh-0', 'default', deps({ default: new Error('socket hang up') }));
    expect(r.kind).toBe('unavailable');
  });

  it('an empty result with no error is "unavailable", not a verdict on the token', async () => {
    const r = await performRefresh('refresh-0', 'default', deps({ default: { data: { session: null }, error: null }, kinematic: { data: { session: null }, error: null } }));
    expect(r.kind).toBe('unavailable');
  });

  it('rejected only when EVERY project definitively rejects the token', async () => {
    const d = deps({ default: err(400, 'AuthApiError', 'Invalid Refresh Token: Refresh Token Not Found'), kinematic: err(400) });
    const r = await performRefresh('refresh-0', 'default', d);
    expect(r).toEqual({ kind: 'rejected', message: 'Invalid Refresh Token: Refresh Token Not Found' });
    expect(d.calls.map((c) => c[0])).toEqual(['default', 'kinematic']);
  });

  it('finds a token that belongs to another project (request routed to the default project)', async () => {
    const d = deps({ default: err(400), kinematic: session(7, 'kin-user') });
    const r = await performRefresh('refresh-0', 'default', d);
    expect(r).toMatchObject({ kind: 'ok', project: 'kinematic', session: { access_token: 'access-7' } });
  });

  it('does not declare the token dead if another project could not answer', async () => {
    const d = deps({ default: err(400), kinematic: err(503) });
    expect((await performRefresh('refresh-0', 'default', d)).kind).toBe('unavailable');
  });

  it('does not probe other projects when the routed project is merely unavailable', async () => {
    const d = deps({ default: err(502), kinematic: session(1) });
    expect((await performRefresh('refresh-0', 'default', d)).kind).toBe('unavailable');
    expect(d.calls).toHaveLength(1);
  });

  it('replays the same session when the same refresh token comes back (response lost in transit)', async () => {
    const d = deps({ default: session(1) });
    const a = await performRefresh('refresh-0', 'default', d);
    const b = await performRefresh('refresh-0', 'default', d);
    expect(b).toEqual(a);
    expect(d.calls).toHaveLength(1); // GoTrue saw the token once -> no reuse detection -> no family revoke
  });

  it('coalesces concurrent duplicates into one GoTrue call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({ default: async () => { await gate; return session(1); } });
    const p = [performRefresh('refresh-0', 'default', d), performRefresh('refresh-0', 'default', d), performRefresh('refresh-0', 'default', d)];
    release();
    const out = await Promise.all(p);
    expect(out.every((o) => o.kind === 'ok')).toBe(true);
    expect(d.calls).toHaveLength(1);
  });

  it('does not cache failures — a retry after an outage reaches GoTrue again', async () => {
    const map: Record<string, any> = { default: err(503) };
    const d = deps(map);
    expect((await performRefresh('refresh-0', 'default', d)).kind).toBe('unavailable');
    map.default = session(2);
    expect((await performRefresh('refresh-0', 'default', d)).kind).toBe('ok');
    expect(d.calls).toHaveLength(2);
  });

  it('forgets a user\'s remembered refreshes on logout', async () => {
    const d = deps({ default: session(1, 'u-9') });
    await performRefresh('refresh-0', 'default', d);
    forgetRefreshReplay('u-9');
    await performRefresh('refresh-0', 'default', d);
    expect(d.calls).toHaveLength(2);
  });

  it('expires the replay window', async () => {
    let t = 1_000_000;
    const d = { ...deps({ default: session(1) }), now: () => t };
    await performRefresh('refresh-0', 'default', d);
    t += 10 * 60_000;
    await performRefresh('refresh-0', 'default', d);
    expect(d.calls).toHaveLength(2);
  });
});
