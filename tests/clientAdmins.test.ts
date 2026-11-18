// Client Management → Admins: a master admin adds more admins to a client. They must land in the org (and project)
// that holds the client's users, never the caller's own org (what POST /users does).

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// A second project ("default") for clients whose users live elsewhere. Everything else in projects.ts is real.
jest.mock('../src/lib/projects', () => {
  const actual = jest.requireActual('../src/lib/projects');
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const remote = createSupabaseMock();
  (global as any).__remote = remote;
  return {
    ...actual,
    adminClientFor: (key?: string | null) => (key === 'default' ? remote.client : (global as any).__supa.client),
    isKnownProject: (key?: string | null) => key === 'default' || key === 'kinematic',
    currentProjectKey: () => 'kinematic',
    clearEmailProjectCache: jest.fn(),
  };
});

import { addClientAdmin, getClientAdmins, updateClientAdmin } from '../src/controllers/client.controller';
import { parseNewClientAdmin, seatProblem } from '../src/services/clientAdmins.service';

const supa = () => (global as any).__supa;
const remote = () => (global as any).__remote;
const CLIENT = '11111111-1111-4111-8111-111111111111';
const REMOTE_CLIENT = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ADMIN = '44444444-4444-4444-8444-444444444444';
const GOOD_PASSWORD = 'Harbour-Lantern-58';

const operator = { id: 'u-master', org_id: 'org-parent', role: 'super_admin', email: 'ops@example.com' };

type Out = { status: number; body: any };
const call = (handler: any, req: any) => new Promise<Out>((resolve) => {
  let status = 200;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: unknown) => { resolve({ status, body: b }); return res; } };
  // AppErrors thrown by the service reach `next`; report them the way the error middleware does.
  handler({ params: { id: CLIENT }, body: {}, query: {}, user: operator, ...req }, res, (e: any) => resolve({ status: e?.statusCode ?? 500, body: { success: false, error: e?.message, code: e?.code } }));
});

/** GoTrue's admin API, which the generic PostgREST double does not have. */
const withAuthAdmin = (m: any) => {
  const createUser = jest.fn(async () => ({ data: { user: { id: NEW_ID } }, error: null }));
  const deleteUser = jest.fn(async () => ({ data: null, error: null }));
  m.client.auth.admin = { createUser, deleteUser };
  return { createUser, deleteUser };
};

const insertOf = (m: any, table: string) => {
  const chain = m.chainsFor(table).find((c: any) => c.ops.some((o: any) => o.method === 'insert'));
  return chain?.ops.find((o: any) => o.method === 'insert').args[0];
};

const body = (over: Record<string, unknown> = {}) => ({ name: '  Priya Nair ', email: 'Priya@Client.co ', mobile: '9876543210', password: GOOD_PASSWORD, ...over });

let auth: ReturnType<typeof withAuthAdmin>;
let remoteAuth: ReturnType<typeof withAuthAdmin>;

beforeEach(() => {
  supa().reset();
  remote().reset();
  auth = withAuthAdmin(supa());
  remoteAuth = withAuthAdmin(remote());
  supa().setDefault('clients', { data: { id: CLIENT, org_id: 'org-client', owner_org_id: 'org-parent', email: 'owner@client.co' } });
  supa().setDefault('org_settings', { data: null }); // no seat cap
  supa().setDefault('client_modules', { data: [{ module_id: 'crm_leads', expires_at: null }, { module_id: 'crm_deals', expires_at: null }] });
});

describe('parseNewClientAdmin', () => {
  it('accepts a complete form, trimming the name and lower-casing the email', () => {
    const r = parseNewClientAdmin(body());
    expect(r).toEqual({ ok: true, value: { name: 'Priya Nair', email: 'priya@client.co', mobile: '9876543210', password: GOOD_PASSWORD } });
  });

  it('makes the mobile optional', () => {
    const r = parseNewClientAdmin(body({ mobile: '  ' }));
    expect(r.ok && r.value.mobile).toBeNull();
  });

  it.each([
    [{ name: '' }, 'name'],
    [{ email: '' }, 'email'],
    [{ email: 'not-an-email' }, 'valid email'],
    [{ mobile: '12345' }, '10 digits'],
    [{ password: 'short' }, 'at least 10'],
  ])('refuses %j', (over, words) => {
    const r = parseNewClientAdmin(body(over));
    expect(r.ok).toBe(false);
    expect((r as any).message).toContain(words);
  });
});

describe('seatProblem', () => {
  it('only blocks a non-staff admin once every seat is taken', () => {
    expect(seatProblem(null, 99, 'a@client.co')).toBeNull();
    expect(seatProblem(5, 4, 'a@client.co')).toBeNull();
    expect(seatProblem(5, 5, 'a@client.co')).toContain('all 5');
    expect(seatProblem(5, 5, 'someone@kinematicapp.com')).toBeNull();
  });
});

describe('POST /clients/:id/admins', () => {
  it('creates the admin in the client\'s own org, bound to the client, with the client\'s modules', async () => {
    supa().setDefault('users', (chain: any) => (chain.ops.some((o: any) => o.method === 'insert')
      ? { data: { id: NEW_ID, name: 'Priya Nair', email: 'priya@client.co', mobile: '9876543210', role: 'client', is_active: true, created_at: '2026-11-18T10:00:00Z', org_id: 'org-client' } }
      : { data: null }));

    const { status, body: out } = await call(addClientAdmin, { body: body() });

    expect(status).toBe(201);
    expect(out.data).toMatchObject({ id: NEW_ID, role: 'client', in_client_org: true, is_primary: false, project: 'kinematic' });
    expect(auth.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'priya@client.co', password: GOOD_PASSWORD, email_confirm: true }));
    expect(insertOf(supa(), 'users')).toEqual({
      id: NEW_ID, org_id: 'org-client', client_id: CLIENT, name: 'Priya Nair', email: 'priya@client.co', mobile: '9876543210', role: 'client', is_active: true,
    });
    expect(insertOf(supa(), 'user_module_permissions')).toEqual([
      { user_id: NEW_ID, module_id: 'crm_leads' }, { user_id: NEW_ID, module_id: 'crm_deals' },
    ]);
    // Only a client the caller's org owns.
    expect(supa().chainsFor('clients')[0].eqs).toMatchObject({ id: CLIENT, owner_org_id: 'org-parent' });
  });

  it('400s on a bad form before touching the database', async () => {
    const { status, body: out } = await call(addClientAdmin, { body: body({ password: 'password1' }) });
    expect(status).toBe(400);
    expect(out.success).toBe(false);
    expect(supa().chains).toHaveLength(0);
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('404s for a client outside the caller\'s reach', async () => {
    supa().setDefault('clients', { data: null });
    expect((await call(addClientAdmin, { body: body() })).status).toBe(404);
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('refuses an email that is already in use, without creating a login', async () => {
    supa().setDefault('users', { data: { id: OTHER_ADMIN, name: 'Old Account' } });
    const { status, body: out } = await call(addClientAdmin, { body: body() });
    expect(status).toBe(409);
    expect(out.error).toContain('Old Account');
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('refuses when the client has used all its seats', async () => {
    supa().setDefault('org_settings', { data: { value: '2' } });
    supa().setDefault('users', (chain: any) => (chain.single ? { data: null } : { data: [{ id: 'a', email: 'a@client.co' }, { id: 'b', email: 'b@client.co' }] }));
    const { status, body: out } = await call(addClientAdmin, { body: body() });
    expect(status).toBe(409);
    expect(out.code).toBe('SEAT_LIMIT');
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('removes the sign-in account again when the profile cannot be saved', async () => {
    supa().setDefault('users', (chain: any) => (chain.ops.some((o: any) => o.method === 'insert')
      ? { error: { message: 'boom', code: 'XX000' } }
      : { data: null }));
    const { status } = await call(addClientAdmin, { body: body() });
    expect(status).toBe(500);
    expect(auth.deleteUser).toHaveBeenCalledWith(NEW_ID);
  });

  it('removes the profile and the sign-in account when the modules cannot be saved', async () => {
    supa().setDefault('users', (chain: any) => (chain.ops.some((o: any) => o.method === 'insert')
      ? { data: { id: NEW_ID, org_id: 'org-client', role: 'client', is_active: true } }
      : { data: null }));
    supa().setDefault('user_module_permissions', { error: { message: 'fk', code: '23503' } });
    const { status } = await call(addClientAdmin, { body: body() });
    expect(status).toBe(500);
    expect(supa().chainsFor('users').some((c: any) => c.ops.some((o: any) => o.method === 'delete') && c.eqs.id === NEW_ID)).toBe(true);
    expect(auth.deleteUser).toHaveBeenCalledWith(NEW_ID);
  });

  it('creates the admin in the linked project for a client whose users live there', async () => {
    supa().setDefault('clients', { data: { id: CLIENT, org_id: 'org-local', owner_org_id: 'org-parent', data_project_key: 'default', data_client_id: REMOTE_CLIENT } });
    remote().setDefault('clients', { data: { id: REMOTE_CLIENT, org_id: 'org-remote' } });
    remote().setDefault('org_settings', { data: null });
    remote().setDefault('client_modules', { data: [{ module_id: 'crm_leads', expires_at: null }] });
    remote().setDefault('users', (chain: any) => (chain.ops.some((o: any) => o.method === 'insert')
      ? { data: { id: NEW_ID, org_id: 'org-remote', role: 'client', is_active: true } }
      : { data: null }));

    const { status, body: out } = await call(addClientAdmin, { body: body() });

    expect(status).toBe(201);
    expect(out.data.project).toBe('default');
    expect(remoteAuth.createUser).toHaveBeenCalled();
    expect(auth.createUser).not.toHaveBeenCalled();
    expect(insertOf(remote(), 'users')).toMatchObject({ org_id: 'org-remote', client_id: REMOTE_CLIENT, role: 'client' });
    expect(insertOf(remote(), 'user_module_permissions')).toEqual([{ user_id: NEW_ID, module_id: 'crm_leads' }]);
    expect(insertOf(supa(), 'users')).toBeUndefined();
  });

  it('refuses a broken project link instead of creating a login in the wrong place', async () => {
    supa().setDefault('clients', { data: { id: CLIENT, org_id: 'org-local', owner_org_id: 'org-parent', data_project_key: 'default', data_client_id: REMOTE_CLIENT } });
    remote().setDefault('clients', { data: null });
    const { status, body: out } = await call(addClientAdmin, { body: body() });
    expect(status).toBe(400);
    expect(out.error).toContain('Linked Client ID');
    expect(remoteAuth.createUser).not.toHaveBeenCalled();
    expect(auth.createUser).not.toHaveBeenCalled();
  });
});

describe('GET /clients/:id/admins', () => {
  it('lists the client\'s admins, marking the main login and any stored in another org', async () => {
    supa().setDefault('users', (chain: any) => (chain.ops.some((o: any) => o.method === 'order')
      ? { data: [
        { id: 'a1', name: 'Owner', email: 'Owner@client.co', role: 'client', is_active: true, org_id: 'org-client' },
        { id: 'a2', name: 'Misplaced', email: 'm@client.co', role: 'client', is_active: true, org_id: 'org-parent' },
        { id: 'fe1', name: 'Field Rep', email: 'rep@client.co', role: 'executive', is_active: true, org_id: 'org-client' },
      ] }
      : { data: [] }));
    supa().setDefault('org_settings', { data: { value: '10' } });

    const { status, body: out } = await call(getClientAdmins, {});

    expect(status).toBe(200);
    expect(out.data.project).toBe('kinematic');
    expect(out.data.seats).toEqual({ allocated: 10, active: 0 });
    expect(out.data.admins.map((a: any) => [a.id, a.is_primary, a.in_client_org])).toEqual([['a1', true, true], ['a2', false, false]]);
    const list = supa().chainsFor('users').find((c: any) => c.ops.some((o: any) => o.method === 'order'));
    expect(list.eqs).toMatchObject({ client_id: CLIENT });
    expect(list.ops).toEqual(expect.arrayContaining([{ method: 'is', args: ['deleted_at', null] }]));
    // No role filter in the query: users.role is an enum whose values differ by project (Kinematic has no
    // main_admin), and PostgREST rejects a filter naming a value the enum lacks. Roles are filtered in code.
    expect(list.ops.some((o: any) => o.method === 'in')).toBe(false);
  });
});

describe('PATCH /clients/:id/admins/:userId', () => {
  const adminRow = { id: OTHER_ADMIN, name: 'Priya', email: 'priya@client.co', role: 'client', is_active: true, org_id: 'org-client' };

  it('switches an admin of this client off', async () => {
    supa().setDefault('users', (chain: any) => (chain.ops.some((o: any) => o.method === 'update')
      ? { data: { ...adminRow, is_active: false } }
      : { data: adminRow }));
    const { status, body: out } = await call(updateClientAdmin, { params: { id: CLIENT, userId: OTHER_ADMIN }, body: { is_active: false } });
    expect(status).toBe(200);
    expect(out.data.is_active).toBe(false);
    const upd = supa().chainsFor('users').find((c: any) => c.ops.some((o: any) => o.method === 'update'));
    expect(upd.ops.find((o: any) => o.method === 'update').args[0]).toEqual({ is_active: false });
    expect(upd.eqs).toMatchObject({ id: OTHER_ADMIN, client_id: CLIENT });
  });

  it('404s for a user who is not an admin of this client', async () => {
    supa().setDefault('users', { data: null });
    const { status } = await call(updateClientAdmin, { params: { id: CLIENT, userId: OTHER_ADMIN }, body: { is_active: false } });
    expect(status).toBe(404);
  });

  it('404s for a non-admin user of this client, and changes nothing', async () => {
    supa().setDefault('users', { data: { ...adminRow, role: 'executive' } });
    const { status } = await call(updateClientAdmin, { params: { id: CLIENT, userId: OTHER_ADMIN }, body: { is_active: false } });
    expect(status).toBe(404);
    expect(supa().chainsFor('users').some((c: any) => c.ops.some((o: any) => o.method === 'update'))).toBe(false);
  });

  it('will not let the caller switch off their own login', async () => {
    const self = '55555555-5555-4555-8555-555555555555';
    supa().setDefault('users', { data: { ...adminRow, id: self } });
    const { status } = await call(updateClientAdmin, { user: { ...operator, id: self }, params: { id: CLIENT, userId: self }, body: { is_active: false } });
    expect(status).toBe(400);
  });

  it('checks the seat cap when switching someone back on', async () => {
    supa().setDefault('org_settings', { data: { value: '1' } });
    supa().setDefault('users', (chain: any) => (chain.single
      ? { data: { ...adminRow, is_active: false } }
      : { data: [{ id: 'x', email: 'x@client.co' }] }));
    const { status, body: out } = await call(updateClientAdmin, { params: { id: CLIENT, userId: OTHER_ADMIN }, body: { is_active: true } });
    expect(status).toBe(409);
    expect(out.code).toBe('SEAT_LIMIT');
  });

  it('moves an admin stored in another org into the client\'s org', async () => {
    const misplaced = { ...adminRow, org_id: 'org-parent' };
    supa().setDefault('users', (chain: any) => (chain.ops.some((o: any) => o.method === 'update')
      ? { data: { ...misplaced, org_id: 'org-client' } }
      : chain.single ? { data: misplaced } : { data: [] }));
    const { status, body: out } = await call(updateClientAdmin, { params: { id: CLIENT, userId: OTHER_ADMIN }, body: { move_to_client_org: true } });
    expect(status).toBe(200);
    expect(out.data.in_client_org).toBe(true);
    const upd = supa().chainsFor('users').find((c: any) => c.ops.some((o: any) => o.method === 'update'));
    expect(upd.ops.find((o: any) => o.method === 'update').args[0]).toEqual({ org_id: 'org-client' });
    expect(upd.eqs).toMatchObject({ id: OTHER_ADMIN, client_id: CLIENT });
  });

  it('leaves an admin already in the client\'s org alone', async () => {
    supa().setDefault('users', { data: adminRow });
    const { status } = await call(updateClientAdmin, { params: { id: CLIENT, userId: OTHER_ADMIN }, body: { move_to_client_org: true } });
    expect(status).toBe(200);
    expect(supa().chainsFor('users').some((c: any) => c.ops.some((o: any) => o.method === 'update'))).toBe(false);
  });

  it('400s when is_active is not a boolean', async () => {
    const { status } = await call(updateClientAdmin, { params: { id: CLIENT, userId: OTHER_ADMIN }, body: { is_active: 'no' } });
    expect(status).toBe(400);
  });
});
