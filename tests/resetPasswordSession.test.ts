/**
 * A password reset on a phone signs that phone in, so it must claim the single-device session like /auth/login —
 * otherwise the response has no session_id, the device sends no X-Session-Id, and requireAuth answers
 * DEVICE_REPLACED while users.active_session_id still holds an earlier login's id.
 */
const mockRpc = jest.fn();
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  m.setDefault('users', { data: { id: 'u1', email: 'a@b.c' } });
  return {
    supabaseAdmin: { from: m.client.from, rpc: (...a: unknown[]) => mockRpc(...a), auth: { admin: {} } },
    supabase: { auth: {} },
    getUserClient: () => m.client,
  };
});
jest.mock('../src/services/auth/passwordReset.service', () => ({
  requestReset: jest.fn(),
  verifyAndReset: jest.fn().mockResolvedValue({
    success: true,
    session: { user_id: 'u1', email: 'a@b.c', access_token: 'a', refresh_token: 'r', expires_at: 9 },
  }),
}));

import { resetPassword } from '../src/controllers/auth.controller';

function call(headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const res: any = { statusCode: 200, body: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; resolve(res); return res; };
    (resetPassword as any)({ body: { email: 'rep@example.com', token: '123456', password: 'Orchid-Lantern-47' }, headers }, res, (e: unknown) => reject(e ?? new Error('next')));
  });
}

beforeEach(() => mockRpc.mockReset());

it('mobile reset rotates the device session and returns session_id', async () => {
  mockRpc.mockResolvedValue({ error: null });
  const res = await call({ 'x-kinematic-platform': 'ios', 'x-device-model': 'iPhone15,3', 'x-os-version': '17.4' });
  expect(res.statusCode).toBe(200);
  expect(typeof res.body.data.session_id).toBe('string');
  expect(mockRpc).toHaveBeenCalledWith('rotate_user_session', expect.objectContaining({
    p_user_id: 'u1', p_new_session_id: res.body.data.session_id, p_device_label: 'iPhone15,3 · iOS 17.4',
  }));
});

it('a failed rotation yields session_id null (no phantom id) but the reset still succeeds', async () => {
  mockRpc.mockResolvedValue({ error: { message: 'boom' } });
  const res = await call({ 'x-kinematic-platform': 'android' });
  expect(res.statusCode).toBe(200);
  expect(res.body.data.session_id).toBeNull();
});

it('web reset does not touch the session', async () => {
  const res = await call({});
  expect(mockRpc).not.toHaveBeenCalled();
  expect(res.body.data.session_id).toBeNull();
});
