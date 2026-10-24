import { decideAssignRole, decideManage, roleRank } from '../src/lib/userGuard';

const orgA = 'a0000000-0000-4000-8000-000000000001';
const orgB = 'b0000000-0000-4000-8000-000000000002';
const actor = (over: Record<string, unknown> = {}) => ({ id: 'u-actor', role: 'admin', org_id: orgA, email: 'admin@a.test', client_id: null, ...over });
const target = (over: Record<string, unknown> = {}) => ({ id: 'u-target', org_id: orgA, client_id: null, role: 'executive', ...over });
const denied = (d: { ok: boolean }) => d.ok === false;

afterEach(() => { delete process.env.USER_RANK_ENFORCE; });

describe('decideManage', () => {
  it('lets an admin manage a lower-ranked user of the same org', () => {
    expect(decideManage(actor(), target(), false)).toEqual({ ok: true });
  });

  it('hides a user of another org behind a 404', () => {
    const d = decideManage(actor(), target({ org_id: orgB }), false) as { ok: false; status: number };
    expect(d.ok).toBe(false);
    expect(d.status).toBe(404);
  });

  it('allows another org\'s user when the actor\'s org owns the target\'s client', () => {
    expect(decideManage(actor(), target({ org_id: orgB, client_id: 'c1' }), true).ok).toBe(true);
  });

  it('allows the named platform operator everywhere', () => {
    const op = actor({ role: 'super_admin', email: 's@kinematicapp.com' });
    expect(decideManage(op, target({ org_id: orgB, role: 'admin' }), false).ok).toBe(true);
  });

  it('does not treat any other super_admin as an operator', () => {
    const sa = actor({ role: 'super_admin', email: 'boss@tenant.test' });
    expect(denied(decideManage(sa, target({ org_id: orgB }), false))).toBe(true);
  });

  it('only a super_admin may manage a super_admin', () => {
    const d = decideManage(actor(), target({ role: 'super_admin' }), false) as { ok: false; status: number };
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
    expect(decideManage(actor({ role: 'super_admin' }), target({ role: 'super_admin' }), false).ok).toBe(true);
  });

  it('may always edit itself', () => {
    expect(decideManage(actor(), target({ id: 'u-actor', org_id: orgB }), false).ok).toBe(true);
  });

  it('a higher-ranked target is logged, not blocked, until USER_RANK_ENFORCE=on', () => {
    const hr = actor({ role: 'hr' });
    const d = decideManage(hr, target({ role: 'admin' }), false);
    expect(d.ok).toBe(true);
    expect((d as { shadow?: string }).shadow).toMatch(/higher role/);
    process.env.USER_RANK_ENFORCE = 'on';
    expect(denied(decideManage(hr, target({ role: 'admin' }), false))).toBe(true);
  });

  it('peers may manage each other', () => {
    expect(decideManage(actor({ role: 'hr' }), target({ role: 'city_manager' }), false)).toEqual({ ok: true });
  });
});

describe('decideAssignRole', () => {
  it('ignores a missing role and roles at or below the caller', () => {
    expect(decideAssignRole(actor(), undefined, 'x')).toEqual({ ok: true });
    expect(decideAssignRole(actor({ role: 'sub_admin' }), 'executive', 'x')).toEqual({ ok: true });
    expect(decideAssignRole(actor({ role: 'sub_admin' }), 'sub_admin', 'x')).toEqual({ ok: true });
  });

  it('refuses to let anyone raise their own role', () => {
    const d = decideAssignRole(actor({ role: 'sub_admin' }), 'super_admin', 'u-actor') as { ok: false; status: number };
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
  });

  it('assigning above the caller to someone else is logged first, blocked when enforced', () => {
    const d = decideAssignRole(actor({ role: 'sub_admin' }), 'admin', 'someone-else');
    expect(d.ok).toBe(true);
    expect((d as { shadow?: string }).shadow).toMatch(/assign higher role/);
    process.env.USER_RANK_ENFORCE = 'on';
    expect(denied(decideAssignRole(actor({ role: 'sub_admin' }), 'admin', 'someone-else'))).toBe(true);
  });

  it('super_admins and operators may assign any role', () => {
    expect(decideAssignRole(actor({ role: 'super_admin' }), 'super_admin', 'x')).toEqual({ ok: true });
  });
});

describe('roleRank', () => {
  it('orders the roles and treats unknown ones as lowest', () => {
    expect(roleRank('super_admin')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('sub_admin'));
    expect(roleRank('sub_admin')).toBeGreaterThan(roleRank('executive'));
    expect(roleRank('mystery')).toBe(0);
    expect(roleRank(null)).toBe(0);
  });
});
