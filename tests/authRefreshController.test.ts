/**
 * HTTP contract of POST /auth/refresh as the mobile apps rely on it:
 *   401 = refresh token definitively dead (sign out), 503 = try again later (KEEP the session).
 * The 503 body must not be a JSON object — already-installed Android builds parse it as {success,...}.
 */
const mockRefresh = jest.fn();
jest.mock('../src/lib/projects', () => {
  const actual = jest.requireActual('../src/lib/projects');
  return {
    ...actual,
    currentProjectKey: () => 'default',
    listProjectKeys: () => ['default'],
    anonClientFor: () => ({ auth: { refreshSession: (a: unknown) => mockRefresh(a) } }),
  };
});
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { supabaseAdmin: { from: m.client.from, auth: { admin: {} } }, supabase: { auth: {} }, getUserClient: () => m.client };
});

import { refresh } from '../src/controllers/auth.controller';
import { _resetRefreshState } from '../src/lib/authRefresh';

function call(body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const res: any = { statusCode: 200, body: null, headers: {} as Record<string, string>, contentType: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.set = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.type = (t: string) => { res.contentType = t; return res; };
    res.json = (b: unknown) => { res.body = b; resolve(res); return res; };
    res.send = (b: unknown) => { res.body = b; resolve(res); return res; };
    (refresh as any)({ body, headers: {} }, res, (e: unknown) => reject(e ?? new Error('next() called')));
  });
}

beforeEach(() => { mockRefresh.mockReset(); _resetRefreshState(); });

const ok = { data: { session: { access_token: 'a', refresh_token: 'r', expires_at: 5, user: { id: 'u' } } }, error: null };

it('200 with the new tokens', async () => {
  mockRefresh.mockResolvedValue(ok);
  const res = await call({ refresh_token: 'old' });
  expect(res.statusCode).toBe(200);
  expect(res.body.data).toMatchObject({ access_token: 'a', refresh_token: 'r', expires_at: 5 });
});

it('401 only for a definitive rejection', async () => {
  mockRefresh.mockResolvedValue({ data: { session: null }, error: { status: 400, name: 'AuthApiError', message: 'Invalid Refresh Token: Refresh Token Not Found' } });
  const res = await call({ refresh_token: 'old' });
  expect(res.statusCode).toBe(401);
  expect(res.body).toMatchObject({ success: false, code: 'INVALID_REFRESH_TOKEN' });
});

it.each([
  ['5xx', { status: 500, name: 'AuthApiError' }],
  ['network', { status: 0, name: 'AuthRetryableFetchError' }],
  ['rate limit', { status: 429, name: 'AuthApiError' }],
])('503 + Retry-After + non-JSON body on GoTrue %s (never 401/429)', async (_n, error) => {
  mockRefresh.mockResolvedValue({ data: { session: null }, error });
  const res = await call({ refresh_token: 'old' });
  expect(res.statusCode).toBe(503);
  expect(res.headers['Retry-After']).toBeDefined();
  expect(res.contentType).toBe('text/plain');
  expect(typeof res.body).toBe('string');
});

it('503 when the auth call throws', async () => {
  mockRefresh.mockRejectedValue(new Error('ECONNRESET'));
  expect((await call({ refresh_token: 'old' })).statusCode).toBe(503);
});

it('400 for a missing refresh_token (client bug, not a dead session)', async () => {
  const res = await call({});
  expect(res.statusCode).toBe(400);
});
