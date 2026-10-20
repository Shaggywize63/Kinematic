import { moduleGate, ruleFor, moduleHeld, MODULE_RULES } from '../src/middleware/moduleGate';

const run = (user: any, path: string, method = 'GET') => {
  let status = 200; let body: any; let nexted = false;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: unknown) => { body = b; return res; } };
  moduleGate({ user, path, method } as any, res, () => { nexted = true; });
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
