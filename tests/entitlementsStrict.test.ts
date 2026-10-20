jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { resolveEntitlements, clearEntitlementCache, strictProjects } from '../src/lib/entitlements';
import { requireModule } from '../src/middleware/rbac';

const supa = () => (global as any).__supa;

beforeEach(() => { supa().reset(); clearEntitlementCache(); delete process.env.MODULE_STRICT_PROJECTS; });
afterAll(() => { delete process.env.MODULE_STRICT_PROJECTS; });

describe('strict entitlements', () => {
  it('only the configured projects are strict (Tata `default` is not, by default)', () => {
    expect([...strictProjects()]).toEqual(['kinematic']);
    process.env.MODULE_STRICT_PROJECTS = 'kinematic, default';
    expect([...strictProjects()].sort()).toEqual(['default', 'kinematic']);
    process.env.MODULE_STRICT_PROJECTS = '';
    expect(strictProjects().size).toBe(0);
  });

  it('in the default project (tests run as `default`) a client list is not strict', async () => {
    supa().setDefault('v_client_enabled_modules', { data: [{ module_id: 'leave', package: 'people' }] });
    const e = await resolveEntitlements({ role: 'admin', clientId: 'c1', orgId: 'o1' });
    expect(e.enabled_modules).toEqual(['leave']);
    expect(e.strict).toBe(false);
  });

  it('is strict for a client-bound user when the project is listed; never for platform users', async () => {
    process.env.MODULE_STRICT_PROJECTS = 'default';
    supa().setDefault('v_client_enabled_modules', { data: [{ module_id: 'leave', package: 'people' }] });
    supa().setDefault('modules', { data: [{ id: 'leave', package: 'people' }, { id: 'hr', package: 'people' }] });
    expect((await resolveEntitlements({ role: 'admin', clientId: 'c1', orgId: 'o1' })).strict).toBe(true);
    expect((await resolveEntitlements({ role: 'admin', clientId: null, orgId: 'o1' })).strict).not.toBe(true);
    expect((await resolveEntitlements({ role: 'super_admin', clientId: 'c1', orgId: 'o1' })).strict).not.toBe(true);
  });

  it('a failed lookup is not strict (never locks anyone out)', async () => {
    process.env.MODULE_STRICT_PROJECTS = 'default';
    supa().setDefault('v_client_enabled_modules', { data: null, error: { message: 'boom' } });
    supa().setDefault('modules', { data: [] });
    expect((await resolveEntitlements({ role: 'admin', clientId: 'c-fail', orgId: 'o1' })).strict).toBe(false);
  });
});

describe('requireModule with a complete list', () => {
  const call = (user: any, module: string) => {
    let status = 200; let nexted = false;
    const res: any = { status: (s: number) => { status = s; return res; }, json: () => res };
    requireModule(module)({ user } as any, res, () => { nexted = true; });
    return { status, nexted };
  };
  it('an empty strict list denies; an empty non-strict list keeps the old reading', () => {
    expect(call({ role: 'admin', enabled_modules: [], entitlements_strict: true, permissions: ['users'] }, 'users').nexted).toBe(false);
    expect(call({ role: 'admin', enabled_modules: [], permissions: ['users'] }, 'users').nexted).toBe(true);
  });
  it('a strict list admits what it holds and refuses what it lacks', () => {
    expect(call({ role: 'admin', enabled_modules: ['users'], entitlements_strict: true }, 'users').nexted).toBe(true);
    expect(call({ role: 'admin', enabled_modules: ['users'], entitlements_strict: true }, 'reports').nexted).toBe(false);
  });
});
