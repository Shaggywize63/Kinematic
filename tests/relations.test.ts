/**
 * Related rows by id instead of a PostgREST foreign-key embed. The Kinematic database has no FOREIGN KEY from
 * orders / invoices to distributors (nor stock batches to skus) and carries TWO from distributor stock to skus, so
 * `select('*, distributor:distributor_id(...)')` failed the whole request ("Could not find a relationship ..." /
 * "more than one relationship was found") and the mobile order detail screen showed an error. These tests pin
 * the helper and the four call sites: the embed is gone from the query, the response keeps its shape, and a
 * failing lookup never takes the main record down with it.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { columnList, distinctIds, fetchRelated, pickColumns } from '../src/lib/relations';
import { get as getOrder } from '../src/controllers/distribution/orders.controller';
import { invoiceForOrder } from '../src/controllers/distribution/invoices.controller';
import { list as listStock } from '../src/controllers/distribution/stock.controller';
import { listBatches } from '../src/services/distribution/batchStock.service';
import { logger } from '../src/lib/logger';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const DIST = '11111111-1111-4111-8111-111111111111';
const OUTLET = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const SKU_A = '44444444-4444-4444-8444-444444444444';
const SKU_B = '55555555-5555-4555-8555-555555555555';
const USER = { id: '66666666-6666-4666-8666-666666666666', org_id: ORG, role: 'executive' };

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  __mock.reset();
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation((() => undefined) as any);
});
afterEach(() => warnSpy.mockRestore());

function call(handler: any, req: Record<string, unknown>) {
  return new Promise<{ res: any; body: any }>((resolve, reject) => {
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn((body) => resolve({ res, body })),
    };
    handler({ user: USER, query: {}, params: {}, ...req }, res, (err: unknown) => reject(err ?? new Error('next() called')));
  });
}

const selectOf = (table: string) => {
  const op = __mock.chainsFor(table)[0].ops.find((o) => o.method === 'select');
  return String(op?.args[0] ?? '');
};

describe('relations helpers', () => {
  it('lists the columns of a select string', () => {
    expect(columnList('name, gstin ,address')).toEqual(['name', 'gstin', 'address']);
    expect(columnList('')).toEqual([]);
  });

  it('picks only the wanted keys and turns a missing one into null (like an embed of a NULL column)', () => {
    expect(pickColumns({ id: 'x', name: 'A', extra: 1 }, ['name', 'gstin'])).toEqual({ name: 'A', gstin: null });
  });

  it('keeps distinct, non-empty string ids in first-seen order', () => {
    expect(distinctIds(['a', 'b', 'a', '', null, undefined, 3, 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('asks nothing when there are no ids', async () => {
    const out = await fetchRelated('distributors', [null, undefined, ''], 'name');
    expect(out.size).toBe(0);
    expect(__mock.chains).toHaveLength(0);
  });

  it('returns rows keyed by id holding exactly the requested columns, one IN query', async () => {
    __mock.queue('distributors', { data: [{ id: DIST, name: 'Gomant Distributors', gstin: '29ABC', secret: 'x' }] });
    const out = await fetchRelated('distributors', [DIST, DIST], 'name, gstin');
    expect(out.get(DIST)).toEqual({ name: 'Gomant Distributors', gstin: '29ABC' });
    expect(__mock.chains).toHaveLength(1);
    expect(selectOf('distributors')).toBe('id, name, gstin');
    expect(__mock.chains[0].ops.find((o) => o.method === 'in')?.args).toEqual(['id', [DIST]]);
  });

  it('does not repeat the id column when it was asked for', async () => {
    __mock.queue('skus', { data: [{ id: SKU_A, name: 'Tiscon' }] });
    await fetchRelated('skus', [SKU_A], 'id, name');
    expect(selectOf('skus')).toBe('id, name');
  });

  it('gives an empty map and a warning when the lookup fails', async () => {
    __mock.queue('distributors', { error: { message: 'boom' } });
    const out = await fetchRelated('distributors', [DIST], 'name');
    expect(out.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('GET /salesman/orders/:id — order detail', () => {
  const order = { id: ORDER, org_id: ORG, order_no: 'GOM-ORD-0001', status: 'placed', distributor_id: DIST, outlet_id: OUTLET, order_items: [{ sku_id: SKU_A, qty: 2 }] };

  it('no longer embeds the distributor through a foreign key, and still sends it', async () => {
    __mock.queue('orders', { data: order });
    __mock.queue('distributors', { data: [{ id: DIST, name: 'Gomant Distributors', gstin: '29ABC', address: 'Bengaluru', state_code: '29', place_of_supply: '29' }] });

    const { res, body } = await call(getOrder, { params: { id: ORDER } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(selectOf('orders')).toBe('*, order_items(*)');
    expect(selectOf('orders')).not.toContain('distributor_id(');
    expect(body.data).toMatchObject({
      id: ORDER, order_no: 'GOM-ORD-0001', order_items: [{ sku_id: SKU_A, qty: 2 }],
      distributor: { name: 'Gomant Distributors', gstin: '29ABC', address: 'Bengaluru', state_code: '29', place_of_supply: '29' },
    });
  });

  it('serves the order with distributor null when the seller lookup fails', async () => {
    __mock.queue('orders', { data: order });
    __mock.queue('distributors', { error: { message: 'permission denied' } });

    const { res, body } = await call(getOrder, { params: { id: ORDER } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.data.order_no).toBe('GOM-ORD-0001');
    expect(body.data.distributor).toBeNull();
  });

  it('is still scoped to the caller org', async () => {
    __mock.queue('orders', { data: order });
    __mock.queue('distributors', { data: [] });
    const { body } = await call(getOrder, { params: { id: ORDER } });
    expect(__mock.chainsFor('orders')[0].eqs).toMatchObject({ id: ORDER, org_id: ORG });
    expect(body.data.distributor).toBeNull();
  });
});

describe('GET /salesman/orders/:id/invoice', () => {
  it('builds seller, outlet and buyer details without foreign-key embeds', async () => {
    __mock.queue('invoices', { data: { id: 'inv1', order_id: ORDER, distributor_id: DIST, outlet_id: OUTLET, invoice_items: [] } });
    __mock.queue('distributors', { data: [{ id: DIST, name: 'Gomant Distributors', gstin: '29ABC', address: 'Bengaluru', state_code: '29', place_of_supply: '29' }] });
    __mock.queue('stores', { data: [{ id: OUTLET, name: 'Shree Traders', address: 'MG Road' }] });
    __mock.queue('outlet_distribution_ext', { data: { gstin: '29BUYER', state_code: '29' } });

    const { res, body } = await call(invoiceForOrder, { params: { id: ORDER } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(selectOf('invoices')).toBe('*, invoice_items(*)');
    expect(body.data).toMatchObject({
      id: 'inv1',
      distributor: { name: 'Gomant Distributors', gstin: '29ABC' },
      outlet: { name: 'Shree Traders', address: 'MG Road' },
      buyer_gstin: '29BUYER', buyer_state_code: '29',
    });
  });
});

describe('GET /distribution/stock', () => {
  it('lists on-hand per SKU with names from a lookup (the table has two FKs to skus on some databases)', async () => {
    __mock.queue('distribution_distributor_stock', { data: [
      { id: 's1', distributor_id: DIST, sku_id: SKU_A, qty: 10, reserved: 4, updated_at: 't' },
      { id: 's2', distributor_id: DIST, sku_id: SKU_B, qty: 1, reserved: 1, updated_at: 't' },
    ] });
    __mock.queue('skus', { data: [{ id: SKU_A, name: 'Tiscon 8mm', sku_code: 'T8', category: 'Rebar' }] });

    const { res, body } = await call(listStock, { query: { distributor_id: DIST } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(selectOf('distribution_distributor_stock')).not.toContain('sku_id(');
    expect(body.data[0]).toMatchObject({ sku_id: SKU_A, available: 6, sku_name: 'Tiscon 8mm', sku_code: 'T8', category: 'Rebar' });
    expect(body.data[1]).toMatchObject({ sku_id: SKU_B, available: 0, sku_name: null, sku_code: null, category: null });
  });

  it('low=1 keeps only the rows with nothing available', async () => {
    __mock.queue('distribution_distributor_stock', { data: [
      { id: 's1', distributor_id: DIST, sku_id: SKU_A, qty: 10, reserved: 4 },
      { id: 's2', distributor_id: DIST, sku_id: SKU_B, qty: 1, reserved: 1 },
    ] });
    const { body } = await call(listStock, { query: { distributor_id: DIST, low: '1' } });
    expect(body.data.map((r: any) => r.id)).toEqual(['s2']);
  });
});

describe('listBatches', () => {
  it('adds the SKU name and expiry threshold from a lookup, not an embed', async () => {
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    __mock.queue('distribution_stock_batches', { data: [{ id: 'b1', sku_id: SKU_A, distributor_id: DIST, qty_remaining: 5, expiry_date: soon }] });
    __mock.queue('skus', { data: [{ id: SKU_A, name: 'Cement', sku_code: 'C1', category: 'Cement', expiry_alert_days: 10 }] });

    const rows = await listBatches({ orgId: ORG, distributorId: DIST });

    expect(selectOf('distribution_stock_batches')).toBe('*');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'b1', sku_name: 'Cement', sku_code: 'C1', status: 'near_expiry' });
  });

  it('still lists batches (without names) when the SKU lookup fails', async () => {
    __mock.queue('distribution_stock_batches', { data: [{ id: 'b1', sku_id: SKU_A, distributor_id: DIST, qty_remaining: 5, expiry_date: null }] });
    __mock.queue('skus', { error: { message: 'boom' } });

    const rows = await listBatches({ orgId: ORG });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'b1', sku_name: null, sku_code: null, status: 'active' });
  });
});
