/**
 * Work Activities (and team attendance / route plans) used to treat any client-unbound admin — or anyone whose
 * NAME contained "sagar" — as a platform operator and, with no client picked, return EVERY org's rows. On the
 * Kinematic project that put ByteBack's field reps in the Kinematic admin's Work Activities. A response must only
 * ever hold ONE org's rows; the Tata `default` project keeps its aggregated "All clients" view for the named
 * platform operators ONLY (and a picked client must be the caller's to use).
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/lib/projects', () => ({
  ...jest.requireActual('../src/lib/projects'),
  currentProjectKey: jest.fn(() => 'kinematic'),
}));
jest.mock('../src/services/supervisor-scope.service', () => ({ fieldForceScopeIds: jest.fn().mockResolvedValue(null) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const projects = require('../src/lib/projects') as { currentProjectKey: jest.Mock };
import {
  isPlatformOperator, usesStrictTenantScope, resolveStrictTenantScope, resolveTenantScope, callerMayReadOrg,
  callerMayUseClientRow, enforcedUnlessOff,
} from '../src/lib/tenantScope';
import { getAllSubmissions, getSubmission } from '../src/controllers/forms.controller';
import { getTeamToday } from '../src/controllers/attendance.controller';
import { getRoutePlans } from '../src/controllers/route-plan.controller';
import { maybeImpersonate } from '../src/middleware/auth';

const KIN_ORG = '11111111-1111-4111-8111-111111111111';
const BYTEBACK_ORG = '7e3b1c9a-2f44-4a6e-9b1d-0a2b3c4d5e6f';
const BYTEBACK_CLIENT = '9c8d7e6f-5a4b-4c3d-8e1f-0a1b2c3d4e5f';
const OTHER_ORG = 'c0000000-0000-4000-a000-000000000001';

const OPERATOR = { id: '693bc38c-5d20-458c-9069-ac78b2e85a18', name: 'Kinematic Admin', email: 's@kinematicapp.com', role: 'super_admin', org_id: KIN_ORG, client_id: null };
const KIN_ADMIN = { id: 'a0000000-0000-4000-a000-000000000001', name: 'Asha', email: 'asha@kinematicapp.com', role: 'admin', org_id: KIN_ORG, client_id: null };
const SAGAR_LOOKALIKE = { id: 'a0000000-0000-4000-a000-000000000002', name: 'Sagar Patil', email: 'sagar@somewhere.example', role: 'admin', org_id: OTHER_ORG, client_id: null };
const BYTEBACK_SUB_ADMIN = { id: 'a0000000-0000-4000-a000-000000000003', name: 'Bisha', email: 'b@byteback.example', role: 'sub_admin', org_id: BYTEBACK_ORG, client_id: BYTEBACK_CLIENT };

/** asyncHandler doesn't hand its promise back, so wait until the handler has answered (or errored). */
async function settled(res: { json: jest.Mock }, next: jest.Mock) {
  for (let i = 0; i < 200 && !res.json.mock.calls.length && !next.mock.calls.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

const req = (user: any, { query = {}, headers = {}, params = {} }: { query?: any; headers?: any; params?: any } = {}) =>
  ({ user, query, headers, params } as any);

beforeEach(() => {
  __mock.reset();
  projects.currentProjectKey.mockReturnValue('kinematic');
  __mock.setDefault('clients', { data: { id: BYTEBACK_CLIENT, org_id: BYTEBACK_ORG, owner_org_id: null } });
});

describe('isPlatformOperator', () => {
  it('is only a named super_admin — not any admin, not a name match, not a client-bound super_admin', () => {
    expect(isPlatformOperator(OPERATOR)).toBe(true);
    expect(isPlatformOperator({ ...OPERATOR, email: 'S@KinematicApp.com ' })).toBe(true);
    expect(isPlatformOperator({ ...OPERATOR, role: 'admin' })).toBe(false);
    expect(isPlatformOperator(SAGAR_LOOKALIKE)).toBe(false);
    expect(isPlatformOperator({ ...OPERATOR, client_id: BYTEBACK_CLIENT })).toBe(false);
    expect(isPlatformOperator({ ...OPERATOR, email: 'someone@else.example' })).toBe(false);
  });
});

describe('usesStrictTenantScope', () => {
  it('applies everywhere except the Tata default project', () => {
    expect(usesStrictTenantScope()).toBe(true);
    projects.currentProjectKey.mockReturnValue('default');
    expect(usesStrictTenantScope()).toBe(false);
  });
});

describe('resolveStrictTenantScope', () => {
  it('scopes a client-unbound super_admin to their OWN org when no client is picked', async () => {
    const s = await resolveStrictTenantScope(req(OPERATOR));
    expect(s).toEqual({ scopeOrgId: KIN_ORG, pickedClientId: null, isClientBound: false });
    expect(__mock.chainsFor('clients')).toHaveLength(0);
  });

  it('treats the "All clients" picker sentinels as no pick', async () => {
    for (const sentinel of ['Kinematic', '00000000-0000-0000-0000-000000000000']) {
      const s = await resolveStrictTenantScope(req(OPERATOR), sentinel);
      expect(s.scopeOrgId).toBe(KIN_ORG);
      expect(s.pickedClientId).toBeNull();
    }
  });

  it('lets the platform operator act as a client: scope becomes that client\'s org', async () => {
    const s = await resolveStrictTenantScope(req(OPERATOR, { headers: { 'x-client-id': BYTEBACK_CLIENT } }));
    expect(s).toEqual({ scopeOrgId: BYTEBACK_ORG, pickedClientId: BYTEBACK_CLIENT, isClientBound: false });
  });

  it('prefers the X-Client-Id header over ?client_id=', async () => {
    const s = await resolveStrictTenantScope(req(OPERATOR, { headers: { 'x-client-id': BYTEBACK_CLIENT } }), '2e5127cf-a717-4a87-b7f6-f39c75d73876');
    expect(s.pickedClientId).toBe(BYTEBACK_CLIENT);
  });

  it('refuses (404) a non-operator admin picking a client of ANOTHER org — no probing, no read', async () => {
    await expect(resolveStrictTenantScope(req(KIN_ADMIN, { headers: { 'x-client-id': BYTEBACK_CLIENT } })))
      .rejects.toMatchObject({ statusCode: 404 });
    // …and a user merely NAMED Sagar gets no operator powers either.
    await expect(resolveStrictTenantScope(req(SAGAR_LOOKALIKE), BYTEBACK_CLIENT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('allows a non-operator to pick a client their own org owns', async () => {
    __mock.setDefault('clients', { data: { id: BYTEBACK_CLIENT, org_id: BYTEBACK_ORG, owner_org_id: null } });
    const s = await resolveStrictTenantScope(req({ ...KIN_ADMIN, org_id: BYTEBACK_ORG }), BYTEBACK_CLIENT);
    expect(s.scopeOrgId).toBe(BYTEBACK_ORG);
  });

  it('404s on an unknown client', async () => {
    __mock.setDefault('clients', { data: [] });
    await expect(resolveStrictTenantScope(req(OPERATOR), BYTEBACK_CLIENT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('pins a client-bound user to their JWT client and org, ignoring any header', async () => {
    const s = await resolveStrictTenantScope(req(BYTEBACK_SUB_ADMIN, { headers: { 'x-client-id': '2e5127cf-a717-4a87-b7f6-f39c75d73876' } }), 'Kinematic');
    expect(s).toEqual({ scopeOrgId: BYTEBACK_ORG, pickedClientId: BYTEBACK_CLIENT, isClientBound: true });
    expect(__mock.chainsFor('clients')).toHaveLength(0);
  });

  it('never resolves to "no org filter": a caller without an org is rejected', async () => {
    await expect(resolveStrictTenantScope(req({ ...KIN_ADMIN, org_id: null }))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('callerMayReadOrg', () => {
  it('own org or platform operator only', () => {
    expect(callerMayReadOrg(KIN_ADMIN, KIN_ORG)).toBe(true);
    expect(callerMayReadOrg(KIN_ADMIN, BYTEBACK_ORG)).toBe(false);
    expect(callerMayReadOrg(OPERATOR, BYTEBACK_ORG)).toBe(true);
    expect(callerMayReadOrg(KIN_ADMIN, null)).toBe(false);
  });
});

describe('GET /forms/admin/submissions (Work Activities)', () => {
  const run = async (user: any, opts: { query?: any; headers?: any } = {}) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await (getAllSubmissions as any)(req(user, { query: { date_from: '2026-10-18', date_to: '2026-10-20', ...(opts.query || {}) }, headers: opts.headers }), res, next);
    await settled(res, next);
    return { res, next };
  };
  const eqOrg = (table: string) => __mock.chainsFor(table)[0]?.eqs.org_id;

  it('the Kinematic admin with no client picked sees ONLY the Kinematic org (ByteBack stays out)', async () => {
    await run(OPERATOR);
    expect(eqOrg('form_submissions')).toBe(KIN_ORG);
    expect(eqOrg('builder_submissions')).toBe(KIN_ORG);
  });

  it('"All clients" (client_id=Kinematic) is still just the caller\'s own org', async () => {
    await run(OPERATOR, { query: { client_id: 'Kinematic' } });
    expect(eqOrg('form_submissions')).toBe(KIN_ORG);
  });

  it('a super-admin acting as ByteBack (X-Client-Id) is scoped to ByteBack\'s org and client', async () => {
    await run(OPERATOR, { headers: { 'x-client-id': BYTEBACK_CLIENT } });
    expect(eqOrg('form_submissions')).toBe(BYTEBACK_ORG);
    expect(eqOrg('builder_submissions')).toBe(BYTEBACK_ORG);
    expect(__mock.chainsFor('form_submissions')[0].ors).toContain(`client_id.is.null,client_id.eq.${BYTEBACK_CLIENT}`);
  });

  it('a plain org admin or a "Sagar"-named user can no longer reach every org', async () => {
    await run(KIN_ADMIN);
    expect(eqOrg('form_submissions')).toBe(KIN_ORG);
    __mock.reset();
    await run(SAGAR_LOOKALIKE);
    expect(eqOrg('form_submissions')).toBe(OTHER_ORG);
  });

  it('a non-operator naming another org\'s client gets a 404, and no submissions are queried', async () => {
    const { next } = await run(KIN_ADMIN, { headers: { 'x-client-id': BYTEBACK_CLIENT } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(__mock.chainsFor('form_submissions')).toHaveLength(0);
  });

  it('the Tata default project keeps the aggregated view for a platform operator — and counts rows only for them', async () => {
    projects.currentProjectKey.mockReturnValue('default');
    await run(OPERATOR);
    expect(eqOrg('form_submissions')).toBeUndefined();
    expect(eqOrg('builder_submissions')).toBeUndefined();
    // the page query plus the two whole-table counts
    expect(__mock.chainsFor('form_submissions').length).toBeGreaterThan(1);
  });

  it('Tata: an admin, a "Sagar"-named client-role user and a non-operator super_admin are each held to their own org', async () => {
    projects.currentProjectKey.mockReturnValue('default');
    for (const [user, org] of [
      [KIN_ADMIN, KIN_ORG],
      [SAGAR_LOOKALIKE, OTHER_ORG],
      [{ ...KIN_ADMIN, name: 'Sagar', role: 'client' }, KIN_ORG],
      [{ ...OPERATOR, email: 'srs@kinematicapp.com' }, KIN_ORG],
    ] as const) {
      __mock.reset();
      await run(user);
      expect(eqOrg('form_submissions')).toBe(org);
      expect(eqOrg('builder_submissions')).toBe(org);
      // no whole-table count leaks to a scoped caller
      expect(__mock.chainsFor('form_submissions')).toHaveLength(1);
    }
  });

  it('Tata: "All clients" (client_id=Kinematic) from an admin is still only their org', async () => {
    projects.currentProjectKey.mockReturnValue('default');
    await run(KIN_ADMIN, { query: { client_id: 'Kinematic' } });
    expect(eqOrg('form_submissions')).toBe(KIN_ORG);
  });

  it('Tata: an admin naming another org\'s client gets a 404 and nothing is queried', async () => {
    projects.currentProjectKey.mockReturnValue('default');
    const { next } = await run(KIN_ADMIN, { headers: { 'x-client-id': BYTEBACK_CLIENT } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(__mock.chainsFor('form_submissions')).toHaveLength(0);
  });

  it('Tata: a platform operator acting as a client is scoped to that client\'s org', async () => {
    projects.currentProjectKey.mockReturnValue('default');
    await run(OPERATOR, { headers: { 'x-client-id': BYTEBACK_CLIENT } });
    expect(eqOrg('form_submissions')).toBe(BYTEBACK_ORG);
  });
});

describe('resolveTenantScope', () => {
  beforeEach(() => projects.currentProjectKey.mockReturnValue('default'));
  afterEach(() => { delete process.env.TENANT_LEGACY_SCOPE; });

  it('gives only the platform operator the aggregated view (no org filter)', async () => {
    expect(await resolveTenantScope(req(OPERATOR))).toEqual({ scopeOrgId: null, pickedClientId: null, isClientBound: false, isGlobal: true });
    expect((await resolveTenantScope(req(OPERATOR), 'Kinematic')).isGlobal).toBe(true);
    expect((await resolveTenantScope(req(OPERATOR), '00000000-0000-0000-0000-000000000000')).isGlobal).toBe(true);
  });

  it('holds every other caller to their own org — never global, whatever the role or name', async () => {
    for (const u of [KIN_ADMIN, SAGAR_LOOKALIKE, { ...KIN_ADMIN, role: 'super_admin' }, { ...KIN_ADMIN, name: 'Sagar', role: 'client' }]) {
      const s = await resolveTenantScope(req(u));
      expect(s.isGlobal).toBe(false);
      expect(s.scopeOrgId).toBe(u.org_id);
    }
  });

  it('pins a client-bound caller to their JWT client and org, even a client-bound super_admin with an operator email', async () => {
    const bound = { ...OPERATOR, org_id: BYTEBACK_ORG, client_id: BYTEBACK_CLIENT };
    expect(await resolveTenantScope(req(bound, { headers: { 'x-client-id': 'f0000000-0000-4000-a000-0000000000ff' } })))
      .toEqual({ scopeOrgId: BYTEBACK_ORG, pickedClientId: BYTEBACK_CLIENT, isClientBound: true, isGlobal: false });
  });

  it('verifies a picked client: own org\'s is fine, another org\'s is a 404 (operator excepted)', async () => {
    await expect(resolveTenantScope(req(KIN_ADMIN, { headers: { 'x-client-id': BYTEBACK_CLIENT } }))).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveTenantScope(req({ ...KIN_ADMIN, role: 'super_admin' }), BYTEBACK_CLIENT)).rejects.toMatchObject({ statusCode: 404 });
    __mock.setDefault('clients', { data: { id: BYTEBACK_CLIENT, org_id: KIN_ORG, owner_org_id: null } });
    expect(await resolveTenantScope(req(KIN_ADMIN, { headers: { 'x-client-id': BYTEBACK_CLIENT } })))
      .toMatchObject({ scopeOrgId: KIN_ORG, pickedClientId: BYTEBACK_CLIENT, isGlobal: false });
    __mock.setDefault('clients', { data: { id: BYTEBACK_CLIENT, org_id: BYTEBACK_ORG, owner_org_id: null } });
    expect(await resolveTenantScope(req(OPERATOR, { headers: { 'x-client-id': BYTEBACK_CLIENT } })))
      .toMatchObject({ scopeOrgId: BYTEBACK_ORG, isGlobal: false });
  });

  it('rejects a caller with no org instead of dropping the filter', async () => {
    await expect(resolveTenantScope(req({ ...KIN_ADMIN, org_id: null }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('never returns the aggregated view on any other project, operator included', async () => {
    projects.currentProjectKey.mockReturnValue('kinematic');
    expect(await resolveTenantScope(req(OPERATOR))).toEqual({ scopeOrgId: KIN_ORG, pickedClientId: null, isClientBound: false, isGlobal: false });
  });

  it('TENANT_LEGACY_SCOPE=on (kill switch) restores the old any-admin global view, on Tata only', async () => {
    process.env.TENANT_LEGACY_SCOPE = 'on';
    expect((await resolveTenantScope(req(KIN_ADMIN))).isGlobal).toBe(true);
    expect((await resolveTenantScope(req({ ...KIN_ADMIN, role: 'client', name: 'Sagar' }))).isGlobal).toBe(true);
    expect((await resolveTenantScope(req({ ...KIN_ADMIN, role: 'supervisor' }))).isGlobal).toBe(false);
    expect((await resolveTenantScope(req(BYTEBACK_SUB_ADMIN))).isGlobal).toBe(false);
    projects.currentProjectKey.mockReturnValue('kinematic');
    expect((await resolveTenantScope(req(KIN_ADMIN))).isGlobal).toBe(false);
  });
});

describe('callerMayUseClientRow', () => {
  it('own org, owning org or platform operator — not any super_admin', () => {
    const row = { org_id: BYTEBACK_ORG, owner_org_id: KIN_ORG };
    expect(callerMayUseClientRow(KIN_ADMIN, row)).toBe(true);
    expect(callerMayUseClientRow({ ...KIN_ADMIN, org_id: BYTEBACK_ORG }, row)).toBe(true);
    expect(callerMayUseClientRow({ ...KIN_ADMIN, org_id: OTHER_ORG }, row)).toBe(false);
    expect(callerMayUseClientRow({ ...KIN_ADMIN, org_id: OTHER_ORG, role: 'super_admin' }, row)).toBe(false);
    expect(callerMayUseClientRow({ ...OPERATOR, org_id: OTHER_ORG }, row)).toBe(true);
  });
});

describe('team attendance and route plans (Tata default project)', () => {
  beforeEach(() => projects.currentProjectKey.mockReturnValue('default'));

  const call = async (handler: any, user: any, opts: { query?: any; headers?: any } = {}) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await handler(req(user, { query: { f: '2026-10-18', t: '2026-10-20', date: '2026-10-20', ...(opts.query || {}) }, headers: opts.headers }), res, next);
    await settled(res, next);
    return { res, next };
  };

  it('team attendance: an admin and a "Sagar" are held to their org; the operator keeps the all-clients view', async () => {
    await call(getTeamToday, KIN_ADMIN);
    expect(__mock.chainsFor('attendance')[0].eqs.org_id).toBe(KIN_ORG);
    __mock.reset();
    await call(getTeamToday, { ...KIN_ADMIN, name: 'Sagar', role: 'client' });
    expect(__mock.chainsFor('attendance')[0].eqs.org_id).toBe(KIN_ORG);
    __mock.reset();
    await call(getTeamToday, OPERATOR);
    expect(__mock.chainsFor('attendance')[0].eqs.org_id).toBeUndefined();
  });

  it('team attendance: another org\'s client is a 404 for an admin, even with the header alone', async () => {
    const { next } = await call(getTeamToday, KIN_ADMIN, { headers: { 'x-client-id': BYTEBACK_CLIENT } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(__mock.chainsFor('attendance')).toHaveLength(0);
  });

  it('route plans: ?client_id=Kinematic or a bare admin no longer returns every org\'s plans', async () => {
    await call(getRoutePlans, KIN_ADMIN, { query: { client_id: 'Kinematic' } });
    expect(__mock.chainsFor('v_route_plan_daily')[0].eqs.org_id).toBe(KIN_ORG);
    __mock.reset();
    await call(getRoutePlans, { ...KIN_ADMIN, name: 'Sagar' });
    expect(__mock.chainsFor('v_route_plan_daily')[0].eqs.org_id).toBe(KIN_ORG);
    __mock.reset();
    await call(getRoutePlans, OPERATOR);
    expect(__mock.chainsFor('v_route_plan_daily')[0].eqs.org_id).toBeUndefined();
  });

  it('route plans: another org\'s client is a 404 for an admin', async () => {
    const { next } = await call(getRoutePlans, KIN_ADMIN, { query: { client_id: BYTEBACK_CLIENT } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(__mock.chainsFor('v_route_plan_daily')).toHaveLength(0);
  });
});

describe('X-Org-Id act-as', () => {
  const asOrg = (u: any) => maybeImpersonate(u, { headers: { 'x-org-id': BYTEBACK_ORG } } as any) as any;
  afterEach(() => { delete process.env.IMPERSONATE_OPERATOR_ONLY; });

  it('only a platform operator may act as another org; any other super_admin keeps their own', () => {
    expect(asOrg(OPERATOR).org_id).toBe(BYTEBACK_ORG);
    expect(asOrg({ ...OPERATOR, email: 'srs@kinematicapp.com' }).org_id).toBe(KIN_ORG);
    expect(asOrg({ ...OPERATOR, client_id: BYTEBACK_CLIENT }).org_id).toBe(KIN_ORG);
  });

  it('IMPERSONATE_OPERATOR_ONLY=off is the kill switch', () => {
    process.env.IMPERSONATE_OPERATOR_ONLY = 'off';
    expect(asOrg({ ...OPERATOR, email: 'srs@kinematicapp.com' }).org_id).toBe(BYTEBACK_ORG);
  });

  it('never touches a non-super_admin', () => {
    expect(asOrg(KIN_ADMIN).org_id).toBe(KIN_ORG);
  });
});

describe('enforcedUnlessOff', () => {
  it('is on unless the flag is explicitly off', () => {
    delete process.env.SOME_TEST_FLAG;
    expect(enforcedUnlessOff('SOME_TEST_FLAG')).toBe(true);
    process.env.SOME_TEST_FLAG = 'on';
    expect(enforcedUnlessOff('SOME_TEST_FLAG')).toBe(true);
    process.env.SOME_TEST_FLAG = ' OFF ';
    expect(enforcedUnlessOff('SOME_TEST_FLAG')).toBe(false);
    delete process.env.SOME_TEST_FLAG;
  });
});

describe('GET /forms/submissions/:id', () => {
  const fetchOne = async (user: any, row: any) => {
    __mock.queue('form_submissions', { data: row });
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await (getSubmission as any)(req(user, { params: { id: 'f0000000-0000-4000-a000-000000000001' } }), res, next);
    await settled(res, next);
    return res;
  };

  it('404s another org\'s submission for a normal caller, but serves the platform operator and the submitter', async () => {
    const row = { id: 'f0000000-0000-4000-a000-000000000001', org_id: BYTEBACK_ORG, user_id: BYTEBACK_SUB_ADMIN.id };
    expect((await fetchOne(KIN_ADMIN, row)).status).toHaveBeenCalledWith(404);
    expect((await fetchOne(OPERATOR, row)).status).not.toHaveBeenCalledWith(404);
    expect((await fetchOne(BYTEBACK_SUB_ADMIN, row)).status).not.toHaveBeenCalledWith(404);
  });

  it('is the same on the Tata default project — a submission id from another org is a 404 there too', async () => {
    projects.currentProjectKey.mockReturnValue('default');
    const row = { id: 'f0000000-0000-4000-a000-000000000001', org_id: BYTEBACK_ORG, user_id: BYTEBACK_SUB_ADMIN.id };
    expect((await fetchOne(KIN_ADMIN, row)).status).toHaveBeenCalledWith(404);
    expect((await fetchOne({ ...KIN_ADMIN, name: 'Sagar', role: 'client' }, row)).status).toHaveBeenCalledWith(404);
    expect((await fetchOne(OPERATOR, row)).status).not.toHaveBeenCalledWith(404);
  });
});
