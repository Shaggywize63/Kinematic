/**
 * POST /auth/change-password serves two callers:
 *  - the forced first-login flow (users.must_change_password = true): new_password only;
 *  - a voluntary change from Settings: current_password is required and verified.
 * Failures must be 400 (never 401 — the mobile apps treat a 401 as "session expired").
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  const authAdmin = { updateUserById: jest.fn(), getUserById: jest.fn() };
  const signIn = jest.fn();
  return {
    __mock: m, __authAdmin: authAdmin, __signIn: signIn,
    supabaseAdmin: { from: m.client.from, auth: { admin: authAdmin } },
    supabase: { auth: { signInWithPassword: signIn } },
    getUserClient: () => m.client,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require('../src/lib/supabase') as {
  __mock: ReturnType<typeof createSupabaseMock>;
  __authAdmin: { updateUserById: jest.Mock; getUserById: jest.Mock };
  __signIn: jest.Mock;
};
import { changePassword } from '../src/controllers/auth.controller';

const USER = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'field_executive' };
const CURRENT = 'Old-Secret-Value-12';
const NEXT = 'Orchid-Lantern-47';

// asyncHandler does not return the handler's promise, so wait for the response itself.
function call(body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const res: any = { statusCode: 200, body: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; resolve(res); return res; };
    (changePassword as any)({ user: USER, body }, res, (e: unknown) => reject(e ?? new Error('next() called')));
  });
}
const setForced = (forced: boolean) => lib.__mock.setDefault('users', { data: { must_change_password: forced } });

beforeEach(() => {
  lib.__mock.reset();
  lib.__authAdmin.updateUserById.mockReset().mockResolvedValue({ error: null });
  lib.__authAdmin.getUserById.mockReset().mockResolvedValue({ data: { user: { email: 'rep@example.com' } } });
  lib.__signIn.mockReset().mockResolvedValue({ error: null });
});

describe('forced first-login change', () => {
  it('needs only the new password', async () => {
    setForced(true);
    const res = await call({ new_password: NEXT });
    expect(res.statusCode).toBe(200);
    expect(lib.__signIn).not.toHaveBeenCalled();
    expect(lib.__authAdmin.updateUserById).toHaveBeenCalledWith(USER.id, { password: NEXT });
  });
});

describe('voluntary change from Settings', () => {
  beforeEach(() => setForced(false));

  it('asks for the current password when none is sent', async () => {
    const res = await call({ new_password: NEXT });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('CURRENT_PASSWORD_REQUIRED');
    expect(lib.__authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('refuses a wrong current password with 400 (not 401) and changes nothing', async () => {
    lib.__signIn.mockResolvedValue({ error: { status: 400, message: 'Invalid login credentials' } });
    const res = await call({ current_password: 'nope-nope-nope', new_password: NEXT });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(lib.__authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('changes the password when the current one is right, verified against the account sign-in email', async () => {
    const res = await call({ current_password: CURRENT, new_password: NEXT });
    expect(res.statusCode).toBe(200);
    expect(lib.__signIn).toHaveBeenCalledWith({ email: 'rep@example.com', password: CURRENT });
    expect(lib.__authAdmin.updateUserById).toHaveBeenCalledWith(USER.id, { password: NEXT });
  });

  it('verifies mobile-only users against their <mobile>@kinematic.app identity', async () => {
    lib.__authAdmin.getUserById.mockResolvedValue({ data: { user: { email: '9876543210@kinematic.app' } } });
    await call({ current_password: CURRENT, new_password: NEXT });
    expect(lib.__signIn).toHaveBeenCalledWith({ email: '9876543210@kinematic.app', password: CURRENT });
  });

  it('rejects reusing the current password without calling GoTrue', async () => {
    const res = await call({ current_password: NEXT, new_password: NEXT });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('SAME_PASSWORD');
    expect(lib.__signIn).not.toHaveBeenCalled();
  });

  it('applies the password policy before anything else', async () => {
    const res = await call({ current_password: CURRENT, new_password: 'abcd1234' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at least 10 characters/i);
    expect(lib.__signIn).not.toHaveBeenCalled();
    expect(lib.__authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('passes a GoTrue rate-limit through as 429', async () => {
    lib.__signIn.mockResolvedValue({ error: { status: 429, message: 'rate limited' } });
    const res = await call({ current_password: CURRENT, new_password: NEXT });
    expect(res.statusCode).toBe(429);
    expect(lib.__authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('surfaces a breached-password rejection from GoTrue as 4xx with its reason', async () => {
    lib.__authAdmin.updateUserById.mockResolvedValue({ error: { status: 422, message: 'Password is known to be weak' } });
    const res = await call({ current_password: CURRENT, new_password: NEXT });
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toMatch(/weak/i);
  });
});
