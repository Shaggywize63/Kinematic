/**
 * Daily closing stock — pure rules + the worksheet/save/approve/report controllers against the chainable Supabase
 * double. Variance = physical − system; approving a non-zero variance posts a stock adjustment of exactly that
 * variance and locks the row; a zero variance or an already-adjusted row cannot be approved.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn(async () => undefined) }));
const applyStockDelta = jest.fn(async () => 0);
jest.mock('../src/controllers/distribution/stock.controller', () => ({ applyStockDelta: (...a: unknown[]) => (applyStockDelta as any)(...a) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { variance, cleanCount, buildWorksheet, canApprove, summarise } from '../src/services/distribution/closingStock.service';
import { worksheet, save, approve } from '../src/controllers/distribution/closingStock.controller';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const DIST = '11111111-1111-4111-8111-111111111111';
const SKU_A = '44444444-4444-4444-8444-444444444444';
const SKU_B = '55555555-5555-4555-8555-555555555555';
const USER = { id: '66666666-6666-4666-8666-666666666666', org_id: ORG, client_id: null, role: 'admin' };

function call(handler: any, req: Record<string, unknown>) {
  return new Promise<{ res: any; body: any }>((resolve, reject) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn((b) => resolve({ res, body: b })) };
    handler({ user: USER, query: {}, params: {}, body: {}, headers: {}, ...req }, res, (e: unknown) => reject(e ?? new Error('next()')));
  });
}

beforeEach(() => { __mock.reset(); applyStockDelta.mockClear(); });

describe('closing-stock pure rules', () => {
  it('variance is physical − system, null when uncounted', () => {
    expect(variance(10, 7)).toBe(3);
    expect(variance(5, 9)).toBe(-4);
    expect(variance(null, 9)).toBeNull();
    expect(variance(undefined, 9)).toBeNull();
  });
  it('cleanCount keeps whole non-negative ints, else null', () => {
    expect(cleanCount('12')).toBe(12);
    expect(cleanCount(3.9)).toBe(3);
    expect(cleanCount('')).toBeNull();
    expect(cleanCount(-1)).toBeNull();
    expect(cleanCount('x')).toBeNull();
  });
  it('buildWorksheet merges on-hand with saved counts and keeps counted-but-zero-stock SKUs', () => {
    const rows = buildWorksheet(
      [{ sku_id: SKU_A, qty: 10 }],
      [{ sku_id: SKU_B, physical_qty: 2, system_qty: 0, variance: 2, status: 'recorded', id: 'c1' }],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.sku_id === SKU_A)).toMatchObject({ system_qty: 10, physical_qty: null, status: 'uncounted', id: null });
    expect(rows.find((r) => r.sku_id === SKU_B)).toMatchObject({ system_qty: 0, physical_qty: 2, variance: 2, status: 'recorded', id: 'c1' });
  });
  it('only a recorded, non-zero variance can be approved', () => {
    expect(canApprove({ status: 'recorded', variance: 3 })).toBe(true);
    expect(canApprove({ status: 'recorded', variance: 0 })).toBe(false);
    expect(canApprove({ status: 'adjusted', variance: 3 })).toBe(false);
  });
  it('summarise counts matched / over / short / adjusted', () => {
    expect(summarise([
      { variance: 0, status: 'recorded' }, { variance: 3, status: 'recorded' },
      { variance: -2, status: 'adjusted' }, { variance: null, status: 'uncounted' },
    ])).toEqual({ counted: 3, matched: 1, over: 1, short: 1, adjusted: 1 });
  });
});

describe('GET worksheet', () => {
  it('returns a row per SKU with system, physical and variance', async () => {
    __mock.queue('distribution_distributor_stock', { data: [{ sku_id: SKU_A, qty: 10 }, { sku_id: SKU_B, qty: 4 }] });
    __mock.queue('distribution_closing_stock', { data: [{ id: 'c1', sku_id: SKU_A, physical_qty: 8, system_qty: 10, variance: -2, status: 'recorded', note: null }] });
    __mock.queue('skus', { data: [{ id: SKU_A, name: 'Tiscon 8mm', sku_code: 'T8', unit: 'kg' }, { id: SKU_B, name: 'Cement', sku_code: 'C1', unit: 'bag' }] });

    const { res, body } = await call(worksheet, { query: { distributor_id: DIST, date: '2026-10-12' } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.data.rows).toHaveLength(2);
    const a = body.data.rows.find((r: any) => r.sku_id === SKU_A);
    expect(a).toMatchObject({ system_qty: 10, physical_qty: 8, variance: -2, status: 'recorded', sku_name: 'Tiscon 8mm' });
    expect(body.data.summary).toMatchObject({ counted: 1, short: 1 });
  });
  it('requires distributor_id', async () => {
    const { res } = await call(worksheet, { query: {} });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST save', () => {
  it('snapshots system qty, computes variance, and skips an already-adjusted SKU', async () => {
    __mock.queue('distribution_distributor_stock', { data: [{ sku_id: SKU_A, qty: 10 }, { sku_id: SKU_B, qty: 4 }] });
    __mock.queue('distribution_closing_stock', { data: [{ sku_id: SKU_B, status: 'adjusted' }] }); // existing locked
    __mock.queue('distribution_closing_stock', (chain) => {
      const row = chain.ops.find((o) => o.method === 'upsert')?.args[0] as any[];
      return { data: row };
    });
    const { res, body } = await call(save, {
      body: { distributor_id: DIST, stock_date: '2026-10-12', counts: [{ sku_id: SKU_A, physical_qty: 7 }, { sku_id: SKU_B, physical_qty: 4 }] },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    const upserted = body.data.rows;
    expect(upserted).toHaveLength(1); // SKU_B skipped (adjusted)
    expect(upserted[0]).toMatchObject({ sku_id: SKU_A, system_qty: 10, physical_qty: 7, variance: -3, status: 'recorded' });
    expect(body.data.skipped_adjusted).toBe(1);
  });
  it('400s when no valid counts', async () => {
    __mock.queue('distribution_distributor_stock', { data: [] });
    __mock.queue('distribution_closing_stock', { data: [] });
    const { res } = await call(save, { body: { distributor_id: DIST, counts: [{ sku_id: SKU_A, physical_qty: 'abc' }] } });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST approve', () => {
  it('posts an adjustment equal to the variance and marks the row adjusted', async () => {
    __mock.queue('distribution_closing_stock', { data: { id: 'c1', org_id: ORG, distributor_id: DIST, sku_id: SKU_A, stock_date: '2026-10-12', physical_qty: 8, system_qty: 10, variance: -2, status: 'recorded' } });
    __mock.queue('distribution_stock_movements', { data: { id: 'mv1' } });
    __mock.queue('distribution_closing_stock', { data: { id: 'c1', status: 'adjusted' } });

    const { res } = await call(approve, { params: { id: 'c1' } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(applyStockDelta).toHaveBeenCalledTimes(1);
    expect(applyStockDelta.mock.calls[0][0]).toMatchObject({ delta: -2, reason: 'adjustment', refType: 'closing_stock', refId: 'c1' });
  });
  it('409s a zero-variance row and never adjusts', async () => {
    __mock.queue('distribution_closing_stock', { data: { id: 'c2', org_id: ORG, distributor_id: DIST, sku_id: SKU_A, variance: 0, status: 'recorded' } });
    const { res } = await call(approve, { params: { id: 'c2' } });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(applyStockDelta).not.toHaveBeenCalled();
  });
  it('409s an already-adjusted row', async () => {
    __mock.queue('distribution_closing_stock', { data: { id: 'c3', org_id: ORG, variance: -2, status: 'adjusted' } });
    const { res } = await call(approve, { params: { id: 'c3' } });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(applyStockDelta).not.toHaveBeenCalled();
  });
});
