/**
 * requireAuth must say 401 ONLY when the token / user is genuinely unusable. A transient failure of GoTrue or
 * the database used to come back as 401 ("Invalid or expired token" / "User profile not found") — the mobile
 * apps answer that by refreshing and, if anything about the refresh hiccups, signing the user out. Transient
 * failures are 503 now (the apps keep the session and retry).
 */
const mockVerify = jest.fn();
const mockGetUser = jest.fn();
const mockFrom = jest.fn();

jest.mock('../src/lib/projects', () => ({
  currentProjectKey: () => 'default',
  verifyProjectToken: (...a: unknown[]) => mockVerify(...a),
  adminClientFor: () => ({ from: (...a: unknown[]) => mockFrom(...a) }),
}));
jest.mock('../src/lib/supabase', () => ({
  supabaseAdmin: { from: (...a: unknown[]) => mockFrom(...a), auth: { getUser: (...a: unknown[]) => mockGetUser(...a) } },
}));
jest.mock('../src/lib/clientAccess', () => ({ checkClientAccess: async () => ({ blocked: false, reason: null, message: '' }) }));
jest.mock('../src/lib/entitlements', () => ({
  resolveEntitlements: async () => ({ enabled_modules: [], enabled_packages: [], strict: false }),
}));

import { requireAuth } from '../src/middleware/auth';

type Q = { data?: unknown; error?: { message: string; code?: string } | null };
function table(res: Q) {
  const b: any = {};
  for (const m of ['select', 'eq']) b[m] = () => b;
  b.single = () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
  b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: res.data ?? [], error: res.error ?? null }).then(ok);
  return b;
}
function wire(tables: Record<string, Q>) {
  mockFrom.mockImplementation((t: string) => table(tables[t] ?? { data: [] }));
}

function run(headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any; nextCalled: boolean; headers: Record<string, string> }>((resolve) => {
    const out = { status: 200, body: null as any, nextCalled: false, headers: {} as Record<string, string> };
    const res: any = { headersSent: false };
    res.status = (c: number) => { out.status = c; return res; };
    res.set = (k: string, v: string) => { out.headers[k] = v; return res; };
    res.json = (b: unknown) => { out.body = b; res.headersSent = true; resolve(out); return res; };
    const req: any = { headers: { authorization: 'Bearer tok-' + Math.random(), ...headers }, ip: '1.1.1.1' };
    requireAuth(req, res, () => { out.nextCalled = true; resolve(out); });
  });
}

const PROFILE = { id: 'u1', org_id: 'o1', client_id: null, name: 'A', email: 'a@b.c', role: 'sub_admin', is_active: true, active_session_id: null };

beforeEach(() => { mockVerify.mockReset(); mockGetUser.mockReset(); mockFrom.mockReset(); });

describe('token verification', () => {
  it('401 for a token GoTrue rejects (invalid / expired)', async () => {
    mockVerify.mockResolvedValue(null);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { status: 401, name: 'AuthApiError', message: 'invalid JWT' } });
    const r = await run();
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  it.each([
    ['GoTrue 5xx', { status: 500, name: 'AuthApiError' }],
    ['network failure', { status: 0, name: 'AuthRetryableFetchError' }],
    ['GoTrue rate limit', { status: 429, name: 'AuthApiError' }],
  ])('503 (not 401) when the fallback GoTrue check hits %s', async (_n, error) => {
    mockVerify.mockResolvedValue(null);
    mockGetUser.mockResolvedValue({ data: { user: null }, error });
    const r = await run();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('AUTH_UNAVAILABLE');
    expect(r.headers['Retry-After']).toBeDefined();
  });

  it('503 when the GoTrue fallback throws', async () => {
    mockVerify.mockResolvedValue(null);
    mockGetUser.mockRejectedValue(new Error('ECONNRESET'));
    expect((await run()).status).toBe(503);
  });
});

describe('profile lookup', () => {
  beforeEach(() => mockVerify.mockResolvedValue({ payload: { sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 } }));

  it('passes a healthy user through', async () => {
    wire({ users: { data: PROFILE } });
    const r = await run();
    expect(r.nextCalled).toBe(true);
  });

  it('401 when the user genuinely has no profile row (PGRST116)', async () => {
    wire({ users: { error: { message: 'no rows', code: 'PGRST116' } } });
    expect((await run()).status).toBe(401);
  });

  it('503 (not 401) when the profile query fails for any other reason', async () => {
    wire({ users: { error: { message: 'fetch failed', code: '' } } });
    const r = await run();
    expect(r.status).toBe(503);
  });

  it('503 (not a hung request) when a lookup throws unexpectedly', async () => {
    mockFrom.mockImplementation(() => { throw new Error('pool exhausted'); });
    expect((await run()).status).toBe(503);
  });

  it('403 for a deactivated user stays a 403', async () => {
    wire({ users: { data: { ...PROFILE, is_active: false } } });
    expect((await run()).status).toBe(403);
  });
});

describe('single-device gate (DEVICE_REPLACED)', () => {
  beforeEach(() => mockVerify.mockResolvedValue({ payload: { sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 } }));

  it('allows the matching session id', async () => {
    wire({ users: { data: { ...PROFILE, active_session_id: 'S1' } } });
    expect((await run({ 'x-kinematic-platform': 'ios', 'x-session-id': 'S1' })).nextCalled).toBe(true);
  });

  it('kicks a stale session id', async () => {
    wire({ users: { data: { ...PROFILE, active_session_id: 'S2' } } });
    const r = await run({ 'x-kinematic-platform': 'android', 'x-session-id': 'S1' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('DEVICE_REPLACED');
  });

  it('does NOT kick a mobile request that carries no session id (e.g. right after a password reset)', async () => {
    wire({ users: { data: { ...PROFILE, active_session_id: 'S2' } } });
    const r = await run({ 'x-kinematic-platform': 'ios' });
    expect(r.nextCalled).toBe(true);
    expect(r.status).toBe(200);
  });

  it('does not enforce for web (no platform header)', async () => {
    wire({ users: { data: { ...PROFILE, active_session_id: 'S2' } } });
    expect((await run()).nextCalled).toBe(true);
  });
});
