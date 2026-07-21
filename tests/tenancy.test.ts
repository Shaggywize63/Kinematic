/**
 * Unit tests for the multi-tenant scope resolver (src/lib/tenancy.ts).
 *
 * Tenant isolation hinges on this precedence being exactly right:
 *   JWT-pinned client  >  X-Client-Id header  >  none.
 * A regression here would either leak one client's rows to another or hide
 * a picker-selected client's data, so it's worth pinning down directly.
 */
import type { Request } from 'express';
import { getClientScope, getClientId, isSuperAdmin } from '../src/lib/tenancy';

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const req = (opts: { user?: Record<string, unknown>; headers?: Record<string, string> } = {}): Request =>
  ({ user: opts.user, headers: opts.headers ?? {} } as unknown as Request);

describe('getClientScope', () => {
  it('prefers the JWT-pinned client (strict, source=jwt)', () => {
    const scope = getClientScope(req({ user: { client_id: UUID_A }, headers: { 'x-client-id': UUID_B } }));
    expect(scope).toEqual({ id: UUID_A, strict: true, source: 'jwt' });
  });

  it('falls back to the X-Client-Id header when no JWT client (strict, source=header)', () => {
    const scope = getClientScope(req({ headers: { 'x-client-id': UUID_B } }));
    expect(scope).toEqual({ id: UUID_B, strict: true, source: 'header' });
  });

  it('returns a non-strict null scope when neither is present', () => {
    const scope = getClientScope(req({ user: {} }));
    expect(scope).toEqual({ id: null, strict: false, source: 'none' });
  });

  it('ignores a malformed X-Client-Id header (not a UUID)', () => {
    const scope = getClientScope(req({ headers: { 'x-client-id': 'not-a-uuid' } }));
    expect(scope).toEqual({ id: null, strict: false, source: 'none' });
  });

  it('ignores a malformed JWT client_id and falls through to the header', () => {
    const scope = getClientScope(req({ user: { client_id: 'garbage' }, headers: { 'x-client-id': UUID_B } }));
    expect(scope.id).toBe(UUID_B);
    expect(scope.source).toBe('header');
  });
});

describe('getClientId', () => {
  it('returns just the resolved id', () => {
    expect(getClientId(req({ user: { client_id: UUID_A } }))).toBe(UUID_A);
    expect(getClientId(req())).toBeNull();
  });
});

describe('isSuperAdmin', () => {
  it('is case-insensitive and false for other roles / missing user', () => {
    expect(isSuperAdmin(req({ user: { role: 'super_admin' } }))).toBe(true);
    expect(isSuperAdmin(req({ user: { role: 'SUPER_ADMIN' } }))).toBe(true);
    expect(isSuperAdmin(req({ user: { role: 'admin' } }))).toBe(false);
    expect(isSuperAdmin(req())).toBe(false);
  });
});
