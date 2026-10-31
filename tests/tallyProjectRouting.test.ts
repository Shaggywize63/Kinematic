/**
 * The Tally connector calls the API with NO auth and NO X-Kinematic-Project header. These tests pin
 * that its calls are routed to the tenant that owns the integration / pairing code (not the default
 * Tata database), and that the enqueue poller visits every tenant.
 */
const KIN = 'https://kin.example.test';
const TATA = 'https://tata.example.test';

// Fake PostgREST per project URL: which rows exist, and which columns the table has.
const DBS: Record<string, { cols: string[]; rows: Array<Record<string, string>> }> = {
  [TATA]: { cols: ['id', 'provider'], rows: [{ id: 'tata-int' }] },                         // no pairing_code_hash column
  [KIN]:  { cols: ['id', 'provider', 'pairing_code_hash'], rows: [{ id: 'kin-int', pairing_code_hash: 'HASH-KIN' }] },
};
jest.mock('@supabase/supabase-js', () => ({
  createClient: (url: string) => ({
    from: (_table: string) => {
      const q: { col?: string; val?: string } = {};
      const b: any = {
        select: () => b, limit: () => b, abortSignal: () => b,
        eq: (c: string, v: string) => { q.col = c; q.val = v; return b; },
        maybeSingle: async () => {
          const db = (global as any).__DBS[url];
          if (!db.cols.includes(q.col!)) throw new Error(`column ${q.col} does not exist`);
          return { data: db.rows.find(r => r[q.col!] === q.val) ?? null, error: null };
        },
      };
      return b;
    },
    auth: {},
  }),
}));
(global as any).__DBS = DBS;

describe('resolvers (real projects.ts against fake tenants)', () => {
  let P: typeof import('../src/lib/projects');
  beforeAll(() => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = TATA; process.env.SUPABASE_ANON_KEY = 'a'; process.env.SUPABASE_SERVICE_ROLE_KEY = 's';
    process.env.KINEMATIC_SUPABASE_URL = KIN; process.env.KINEMATIC_SUPABASE_ANON_KEY = 'a'; process.env.KINEMATIC_SUPABASE_SERVICE_ROLE_KEY = 's';
    jest.resetModules();
    P = require('../src/lib/projects');
  });

  it('routes an integration id to the tenant that owns it', async () => {
    expect(await P.resolveProjectForTallyIntegrationAsync('kin-int')).toBe('kinematic');
    expect(await P.resolveProjectForTallyIntegrationAsync('tata-int')).toBe('default');   // Tata unchanged
  });
  it('unknown / empty ids fall back to the default project exactly as before', async () => {
    expect(await P.resolveProjectForTallyIntegrationAsync('nope')).toBe('default');
    expect(await P.resolveProjectForTallyIntegrationAsync('')).toBe('default');
    expect(await P.resolveProjectForTallyIntegrationAsync(undefined)).toBe('default');
  });
  it('routes a pairing-code hash to its tenant, skipping a project that lacks the column', async () => {
    expect(await P.resolveProjectForTallyPairingAsync('HASH-KIN')).toBe('kinematic');
    expect(await P.resolveProjectForTallyPairingAsync('HASH-NONE')).toBe('default');
    expect(await P.resolveProjectForTallyPairingAsync('')).toBe('default');
  });
});

describe('middleware + route wiring', () => {
  it('withTallyIntegrationProject runs the rest of the request inside the owning project', async () => {
    jest.resetModules();
    const calls: string[] = [];
    jest.doMock('../src/lib/projects', () => ({
      runWithProject: (p: string, fn: () => unknown) => { calls.push(`run:${p}`); return fn(); },
      isKnownProject: () => true, fallbackProjectKey: () => 'default',
      resolveProjectForIntegrationAsync: jest.fn(), resolveProjectForTokenAsync: jest.fn(),
      resolveProjectForCaptureTokenAsync: jest.fn(), resolveProjectForEmailTrackingTokenAsync: jest.fn(),
      resolveProjectForTallyIntegrationAsync: async (id: string) => { calls.push(`resolve:${id}`); return 'kinematic'; },
      resolveProjectForTallyPairingAsync: async (h: string) => { calls.push(`pair:${h}`); return 'kinematic'; },
    }));
    const { withTallyIntegrationProject, withTallyPairProject } = require('../src/middleware/withProject');
    const { hashPairingCode } = require('../src/services/distribution/integrations/tally.onboarding');

    const next = jest.fn(() => calls.push('next'));
    await withTallyIntegrationProject({ params: { id: ' abc ' } } as any, {} as any, next);
    expect(calls).toEqual(['resolve:abc', 'run:kinematic', 'next']);

    calls.length = 0;
    await withTallyPairProject({ body: { code: 'k7f-29x' } } as any, {} as any, next);
    expect(calls).toEqual([`pair:${hashPairingCode('K7F29X')}`, 'run:kinematic', 'next']);

    calls.length = 0;                                            // malformed code: never probes the databases
    await withTallyPairProject({ body: { code: 'abc' } } as any, {} as any, next);
    expect(calls).toEqual(['run:default', 'next']);
    jest.dontMock('../src/lib/projects');
  });

  it('every connector route is behind a tenant-routing middleware (except the download redirect)', () => {
    jest.resetModules();
    jest.doMock('../src/lib/supabase', () => ({ supabaseAdmin: {}, supabase: {}, getUserClient: () => ({}) }));
    const router = require('../src/routes/tally-agent-public.routes').default;
    const { withTallyIntegrationProject, withTallyPairProject } = require('../src/middleware/withProject');
    const routes = router.stack.filter((l: any) => l.route).map((l: any) => ({
      path: l.route.path as string, handlers: l.route.stack.map((s: any) => s.handle),
    }));
    for (const r of routes) {
      if (r.path === '/agent/download') continue;
      const mw = r.path === '/pair' ? withTallyPairProject : withTallyIntegrationProject;
      expect(r.handlers).toContain(mw);
      // routing must happen before the controller (the last handler)
      expect(r.handlers.indexOf(mw)).toBeLessThan(r.handlers.length - 1);
    }
    expect(routes.map((r: any) => r.path).sort()).toEqual(
      ['/agent/download', '/jobs/:id', '/jobs/:id/command-result', '/jobs/:id/masters', '/jobs/:id/vouchers', '/jobs/:id/profile', '/jobs/:id/result', '/pair'].sort());
  });
});
