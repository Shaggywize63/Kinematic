import { moduleGate, ruleFor, moduleHeld, MODULE_RULES } from '../src/middleware/moduleGate';
import { logger } from '../src/lib/logger';

const run = (user: any, path: string, method = 'GET', headers: Record<string, string> = {}) => {
  let status = 200; let body: any; let nexted = false;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: unknown) => { body = b; return res; } };
  moduleGate({ user, path, method, headers } as any, res, () => { nexted = true; });
  return { status, body, nexted };
};
const client = (modules: string[], extra: Record<string, unknown> = {}) =>
  ({ id: 'u1', role: 'admin', client_id: 'c1', enabled_modules: modules, entitlements_strict: true, ...extra });

afterEach(() => { delete process.env.MODULE_GATE; });

describe('route → module rules', () => {
  it('matches a prefix and its children only', () => {
    expect(ruleFor('/leave')?.any).toEqual(['leave']);
    expect(ruleFor('/leave/requests/1')?.any).toEqual(['leave']);
    expect(ruleFor('/leaves')).toBeUndefined();
    expect(ruleFor('/crm/leads')).toBeUndefined();
  });
  it('every rule names at least one module', () => {
    for (const r of MODULE_RULES) expect(r.any.length).toBeGreaterThan(0);
  });
  it('moduleHeld is true when any listed module is held', () => {
    expect(moduleHeld(client(['leave']) as any, { prefix: '/x', any: ['a', 'leave'] })).toBe(true);
    expect(moduleHeld(client([]) as any, { prefix: '/x', any: ['a'] })).toBe(false);
  });
});

describe('moduleGate', () => {
  it('shadow (default): lets an un-ticked module through', () => {
    expect(run(client([]), '/leave/requests').nexted).toBe(true);
  });
  it('enforce: refuses an un-ticked module with 403, passes a ticked one', () => {
    process.env.MODULE_GATE = 'enforce';
    const denied = run(client(['broadcast']), '/leave/requests');
    expect(denied.nexted).toBe(false);
    expect(denied.status).toBe(403);
    expect(run(client(['leave']), '/leave/requests').nexted).toBe(true);
  });
  it('enforce: an empty complete list refuses everything covered', () => {
    process.env.MODULE_GATE = 'enforce';
    expect(run(client([]), '/learning').status).toBe(403);
  });
  it('never applies to platform staff, super_admin, non-strict lists or uncovered routes', () => {
    process.env.MODULE_GATE = 'enforce';
    expect(run(client([], { entitlements_strict: false }), '/leave').nexted).toBe(true);
    expect(run(client([], { role: 'super_admin' }), '/leave').nexted).toBe(true);
    expect(run(client([]), '/crm/leads').nexted).toBe(true);
    expect(run(undefined, '/leave').nexted).toBe(true);
  });
  it('MODULE_GATE=off disables it', () => {
    process.env.MODULE_GATE = 'off';
    expect(run(client([]), '/leave').nexted).toBe(true);
  });
});

describe('reference data (cities, zones, stores)', () => {
  it('only those three are readOpen — everything else is gated for reads too', () => {
    expect(MODULE_RULES.filter((r) => r.readOpen).map((r) => r.prefix).sort()).toEqual(['/cities', '/stores', '/zones']);
  });
  it('enforce: a client without the module can still READ them (GET / HEAD) but not write', () => {
    process.env.MODULE_GATE = 'enforce';
    for (const path of ['/cities', '/zones/abc', '/stores']) {
      expect(run(client([]), path, 'GET').nexted).toBe(true);
      expect(run(client([]), path, 'HEAD').nexted).toBe(true);
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = run(client([]), path, m);
        expect(r.nexted).toBe(false);
        expect(r.status).toBe(403);
      }
      expect(run(client([path.split('/')[1]]), path, 'POST').nexted).toBe(true);
    }
  });
  it('enforce: broadcast, leaderboard and route plans stay gated for reads', () => {
    process.env.MODULE_GATE = 'enforce';
    for (const path of ['/broadcast', '/leaderboard', '/route-plan/me', '/route-plans']) {
      expect(run(client([]), path, 'GET').status).toBe(403);
    }
  });
  it('shadow: an exempt read is not even logged', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation((() => logger) as any);
    run(client([], { client_id: 'c-ref-1' }), '/cities', 'GET');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('shadow log line', () => {
  it('names the role and a sanitised user agent, once per client and route prefix', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation((() => logger) as any);
    const u = client([], { client_id: 'c-log-1', role: 'field_executive' });
    run(u, '/leaderboard', 'GET', { 'user-agent': 'okhttp/4.12.0\r\nforged line' });
    run(u, '/leaderboard', 'GET', { 'user-agent': 'okhttp/4.12.0' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('[module-shadow] would refuse GET /leaderboard* for client=c-log-1');
    expect(line).toContain('role=field_executive');
    expect(line).toContain('ua="okhttp/4.12.0forged line"');
    expect(line).not.toMatch(/[\r\n]/);
    warn.mockRestore();
  });
});
