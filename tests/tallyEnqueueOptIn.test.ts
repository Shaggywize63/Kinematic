jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
import { enqueueForIntegration } from '../src/services/distribution/integrations/enqueue.poller';

const supa = () => (global as any).__supa;
const base = { id: 'i1', org_id: 'o1', last_sync_at: '2026-10-01T00:00:00Z' };
const touched = () => new Set(supa().chains.map((c: any) => c.table));
const insertedKinds = () => supa().chainsFor('distribution_integration_events')
  .flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert').flatMap((o: any) => (o.args[0] as any[]).map(r => r.kind)));

beforeEach(() => supa().reset());

describe('Tally enqueue: outbound masters and orders are opt-in', () => {
  it('with no flags it touches only invoices / payments / returns (existing behaviour)', async () => {
    await enqueueForIntegration({ ...base, config: { company_name: 'X' } });
    for (const t of ['orders', 'distributors', 'skus']) expect(touched().has(t)).toBe(false);
    expect(touched().has('invoices')).toBe(true);
  });

  it('flags must be exactly true; each switches on only its own source', async () => {
    await enqueueForIntegration({ ...base, config: { sync_orders: 'yes', auto_create_ledgers: 1 } });
    expect(touched().has('orders')).toBe(false);
    expect(touched().has('distributors')).toBe(false);
    supa().reset();
    await enqueueForIntegration({ ...base, config: { sync_orders: true } });
    expect(touched().has('orders')).toBe(true);
    expect(touched().has('distributors')).toBe(false);
    expect(touched().has('skus')).toBe(false);
  });

  it('enqueues the right kinds and skips dealers/products already linked to Tally', async () => {
    const s = supa();
    s.setDefault('orders', { data: [{ id: 'ord1' }], error: null });
    s.setDefault('distributors', { data: [{ id: 'dA' }, { id: 'dB' }], error: null });
    s.setDefault('skus', { data: [{ id: 'kA' }], error: null });
    s.setDefault('distribution_tally_masters', (c: any) => c.eqs.kind === 'party'
      ? { data: [{ matched_ref_id: 'dA' }], error: null } : { data: [], error: null });
    await enqueueForIntegration({ ...base, config: { sync_orders: true, auto_create_ledgers: true, auto_create_stock_items: true } });
    const rows = s.chainsFor('distribution_integration_events')
      .flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert').flatMap((o: any) => o.args[0]));
    const byKind = (k: string) => rows.filter((r: any) => r.kind === k).map((r: any) => r.ref_id);
    expect(byKind('order')).toEqual(['ord1']);
    expect(byKind('master_ledger')).toEqual(['dB']);       // dA already linked
    expect(byKind('master_stock_item')).toEqual(['kA']);
    expect(rows.find((r: any) => r.kind === 'master_ledger').ref_table).toBe('distributors');
    expect(insertedKinds().length).toBe(3);
  });
});

describe('Tally enqueue: a connection pinned to a company only syncs that company', () => {
  const CO = '22222222-2222-4222-8222-222222222222';
  const matches = (table: string) => supa().chainsFor(table).flatMap((c: any) => c.ops.filter((o: any) => o.method === 'match').map((o: any) => o.args[0]));

  it('filters invoices, payments and returns (and opt-in sources) by client_id', async () => {
    await enqueueForIntegration({ ...base, config: { client_id: CO, sync_orders: true, auto_create_ledgers: true, auto_create_stock_items: true } });
    for (const t of ['invoices', 'payments', 'returns', 'orders', 'distributors', 'skus']) {
      expect(matches(t)).toEqual([{ client_id: CO }]);
    }
  });

  it('an unpinned or malformed client_id leaves the whole org in scope, as before', async () => {
    await enqueueForIntegration({ ...base, config: {} });
    await enqueueForIntegration({ ...base, config: { client_id: 'not-a-uuid' } });
    expect(matches('invoices')).toEqual([{}, {}]);
  });
});
