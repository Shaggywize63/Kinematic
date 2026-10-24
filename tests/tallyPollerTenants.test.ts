let current = 'default';
jest.mock('../src/lib/projects', () => ({
  DEFAULT_PROJECT: 'default',
  knownProjectKeys: () => ['kinematic', 'default', 'broken'],
  runWithProject: (key: string, fn: () => Promise<unknown>) => {
    if (key === 'broken') throw new Error('project unreachable');
    current = key; return fn();
  },
}));
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
import { runOnce } from '../src/services/distribution/integrations/enqueue.poller';

const supa = () => (global as any).__supa;
beforeEach(() => { supa().reset(); current = 'default'; });

describe('Tally enqueue poller visits every tenant', () => {
  it('processes a Kinematic-tenant integration (previously only the default project was visited)', async () => {
    const seenDuring: string[] = [];
    supa().setDefault('distribution_integrations', (c: any) => {
      const isSelect = c.ops.some((o: any) => o.method === 'select') && !c.ops.some((o: any) => o.method === 'update');
      if (isSelect) return { data: current === 'kinematic' ? [{ id: 'kin-int', org_id: 'org1', last_sync_at: '2026-10-01T00:00:00Z', config: {} }] : [], error: null };
      return { data: [], error: null };
    });
    supa().setDefault('invoices', (c: any) => { seenDuring.push(current); return { data: [{ id: 'inv-1' }], error: null }; });
    await runOnce();
    expect(seenDuring).toEqual(['kinematic']);                        // invoices were scanned inside the kinematic project
    const inserts = supa().chainsFor('distribution_integration_events')
      .flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert').flatMap((o: any) => o.args[0]));
    expect(inserts).toEqual([expect.objectContaining({ integration_id: 'kin-int', org_id: 'org1', kind: 'invoice', ref_id: 'inv-1' })]);
  });

  it('one unreachable project does not stop the others, and the default project is still processed', async () => {
    supa().setDefault('distribution_integrations', (c: any) =>
      c.ops.some((o: any) => o.method === 'select') && current === 'default'
        ? { data: [{ id: 'tata-int', org_id: 'orgT', last_sync_at: null, config: {} }], error: null } : { data: [], error: null });
    supa().setDefault('invoices', { data: [{ id: 'inv-T' }], error: null });
    await expect(runOnce()).resolves.toBeUndefined();               // 'broken' threw, nothing escaped
    const kinds = supa().chainsFor('distribution_integration_events')
      .flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert').flatMap((o: any) => o.args[0].map((r: any) => r.integration_id)));
    expect(kinds).toEqual(['tata-int']);
  });

  it('a project whose integrations query errors is skipped without crashing (only the default project logs it)', async () => {
    supa().setDefault('distribution_integrations', { data: null, error: { message: 'relation does not exist' } });
    await expect(runOnce()).resolves.toBeUndefined();
    expect(supa().chainsFor('invoices')).toHaveLength(0);
  });
});
