/**
 * Master-admin READ-ONLY "view as user" mirror.
 *
 * The impersonation token minted by POST /auth/impersonate/start carries a
 * `ro:true` claim; requireAuth forces users.is_read_only on that session so it
 * is an EXACT mirror of the target that cannot write:
 *
 *  - readOnlyGuard (mounted on the V1 catch-all) blocks every write for a
 *    read-only session while leaving reads + the login-as/impersonate
 *    view-switch intact.
 *  - The /auth session routes bypass that guard, so updateMe + changePassword
 *    independently refuse a read-only MIRROR (impersonation_read_only) — the
 *    mirror must not edit the target's own profile or password.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

// updateMe / changePassword import the supabase lib at module load, so mock it
// (mirrors changePassword.test.ts). The guards short-circuit before any query.
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

import { readOnlyGuard } from '../src/middleware/readOnly';
import { updateMe, changePassword } from '../src/controllers/auth.controller';

function runGuard(user: any, method: string, path: string) {
  const req: any = { user, method, path };
  let status = 0;
  let nextCalled = false;
  const res: any = {
    status(c: number) { status = c; return this; },
    json() { return this; },
  };
  readOnlyGuard(req, res, () => { nextCalled = true; });
  return { nextCalled, status };
}

describe('readOnlyGuard — a read-only session', () => {
  const ro = { id: 'u1', is_read_only: true };

  it('blocks every write (POST) with 403', () => {
    const r = runGuard(ro, 'POST', '/crm/leads');
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
  });

  it('allows all reads (GET)', () => {
    expect(runGuard(ro, 'GET', '/crm/leads').nextCalled).toBe(true);
  });

  it('allows the login-as / impersonate view-switch so a viewer can move between tenants', () => {
    expect(runGuard(ro, 'POST', '/clients/abc/impersonate').nextCalled).toBe(true);
    expect(runGuard(ro, 'POST', '/clients/abc/login-as').nextCalled).toBe(true);
  });

  it('never blocks a normal writable user', () => {
    expect(runGuard({ id: 'u2', is_read_only: false }, 'POST', '/crm/leads').nextCalled).toBe(true);
  });
});

function call(handler: any, user: any, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const res: any = { statusCode: 200, body: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; resolve(res); return res; };
    handler({ user, body }, res, (e: unknown) => reject(e ?? new Error('next() called')));
  });
}

describe('read-only mirror cannot mutate the target account', () => {
  const mirror = {
    id: 'tgt', org_id: 'o1', role: 'field_executive',
    is_read_only: true, impersonation_read_only: true,
  };

  it('updateMe refuses with 403 (the guard returns before any DB write)', async () => {
    const res = await call(updateMe, mirror, { name: 'Hacked Name' });
    expect(res.statusCode).toBe(403);
  });

  it('changePassword refuses with 403 before any GoTrue call', async () => {
    const res = await call(changePassword, mirror, { new_password: 'Orchid-Lantern-47' });
    expect(res.statusCode).toBe(403);
    expect(lib.__authAdmin.updateUserById).not.toHaveBeenCalled();
    expect(lib.__signIn).not.toHaveBeenCalled();
  });
});
