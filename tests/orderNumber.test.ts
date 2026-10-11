/**
 * Order numbers. `gen_order_no` is `count(today's orders) + 1` with a day boundary compared in the wrong time zone, so
 * between 00:00 and 05:30 IST the second order of the night got the first one's number and the insert failed with
 * 409 "Duplicate order" (an app reads that as "already saved"). The insert now steps over a taken number.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import {
  datePartOf, formatOrderNo, insertOrderWithFreeNo, isOrderNoClash, nextFreeOrderNo, orderSeqOf,
} from '../src/services/distribution/orderNumber';
import { logger } from '../src/lib/logger';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const NO_CLASH = { code: '23505', message: 'duplicate key value violates unique constraint "orders_org_id_order_no_key"', details: 'Key (org_id, order_no)=(x, ORD-261012-00001) already exists.' };
const IDEM_CLASH = { code: '23505', message: 'duplicate key value violates unique constraint "orders_org_id_idempotency_key_key"', details: 'Key (org_id, idempotency_key)=(x, k) already exists.' };

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  __mock.reset();
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation((() => undefined) as any);
});
afterEach(() => warnSpy.mockRestore());

const insertedNos = () => __mock.chainsFor('orders')
  .map((c) => c.ops.find((o) => o.method === 'insert')?.args[0] as { order_no?: string } | undefined)
  .filter((r): r is { order_no?: string } => !!r)
  .map((r) => r.order_no);

describe('order number helpers', () => {
  it('reads the running number of a dated order number', () => {
    expect(orderSeqOf('ORD-261012-00007', '261012')).toBe(7);
    expect(orderSeqOf('ORD-261012-123456', '261012')).toBe(123456);
  });

  it('ignores numbers of another day, other shapes and non-strings', () => {
    expect(orderSeqOf('ORD-261011-00007', '261012')).toBeNull();
    expect(orderSeqOf('ORD-1760000000000', '261012')).toBeNull();
    expect(orderSeqOf('GOM-ORD-0005', '261012')).toBeNull();
    expect(orderSeqOf(null, '261012')).toBeNull();
    expect(orderSeqOf(42, '261012')).toBeNull();
  });

  it('formats with at least five digits', () => {
    expect(formatOrderNo('261012', 2)).toBe('ORD-261012-00002');
    expect(formatOrderNo('261012', 123456)).toBe('ORD-261012-123456');
    expect(formatOrderNo('261012', 0)).toBe('ORD-261012-00001');
  });

  it('finds the date part only of a generated number', () => {
    expect(datePartOf('ORD-261012-00001')).toBe('261012');
    expect(datePartOf('ORD-1760000000000')).toBeNull();
    expect(datePartOf(undefined)).toBeNull();
  });

  it('tells an order-number clash from an idempotency clash and from other errors', () => {
    expect(isOrderNoClash(NO_CLASH)).toBe(true);
    expect(isOrderNoClash(IDEM_CLASH)).toBe(false);
    expect(isOrderNoClash({ code: '23503', message: 'foreign key violation on order_no' })).toBe(false);
    expect(isOrderNoClash({ code: '23505', message: 'duplicate key value violates unique constraint "something_else"' })).toBe(false);
    expect(isOrderNoClash(null)).toBe(false);
  });
});

describe('nextFreeOrderNo', () => {
  it('goes one past the highest number used that day', async () => {
    __mock.queue('orders', { data: [{ order_no: 'ORD-261012-00004' }] });
    expect(await nextFreeOrderNo(ORG, 'ORD-261012-00001')).toBe('ORD-261012-00005');
    expect(__mock.chainsFor('orders')[0].eqs).toMatchObject({ org_id: ORG });
  });

  it('goes past the clashed number when nothing higher is found', async () => {
    __mock.queue('orders', { data: [] });
    expect(await nextFreeOrderNo(ORG, 'ORD-261012-00003')).toBe('ORD-261012-00004');
  });

  it('makes a non-dated number unique without a lookup', async () => {
    const out = await nextFreeOrderNo(ORG, 'ORD-1760000000000');
    expect(out.startsWith('ORD-1760000000000-')).toBe(true);
    expect(__mock.chains).toHaveLength(0);
  });
});

describe('insertOrderWithFreeNo', () => {
  const row = () => ({ org_id: ORG, order_no: 'ORD-261012-00001', grand_total: 124 });

  it('inserts once when the number is free', async () => {
    __mock.queue('orders', { data: { id: 'o1', order_no: 'ORD-261012-00001' } });
    const { data, error } = await insertOrderWithFreeNo(row(), ORG);
    expect(error).toBeNull();
    expect((data as any).id).toBe('o1');
    expect(insertedNos()).toEqual(['ORD-261012-00001']);
  });

  it('steps over a taken number and saves the order under the next one', async () => {
    __mock.queue('orders', { error: NO_CLASH });
    __mock.queue('orders', { data: [{ order_no: 'ORD-261012-00001' }] });
    __mock.queue('orders', { data: { id: 'o2', order_no: 'ORD-261012-00002' } });

    const { data, error } = await insertOrderWithFreeNo(row(), ORG);

    expect(error).toBeNull();
    expect((data as any).id).toBe('o2');
    expect(insertedNos()).toEqual(['ORD-261012-00001', 'ORD-261012-00002']);
  });

  it('does not retry a repeat of the same request (idempotency key), it stays a duplicate', async () => {
    __mock.queue('orders', { error: IDEM_CLASH });
    const { error } = await insertOrderWithFreeNo(row(), ORG);
    expect(error?.code).toBe('23505');
    expect(insertedNos()).toHaveLength(1);
  });

  it('does not retry other errors', async () => {
    __mock.queue('orders', { error: { code: '23503', message: 'insert or update violates foreign key constraint' } });
    const { error } = await insertOrderWithFreeNo(row(), ORG);
    expect(error?.code).toBe('23503');
    expect(insertedNos()).toHaveLength(1);
  });

  it('gives up with the clash error after a bounded number of attempts', async () => {
    __mock.setDefault('orders', (chain) => {
      const isInsert = chain.ops.some((o) => o.method === 'insert');
      return isInsert ? { error: NO_CLASH } : { data: [{ order_no: 'ORD-261012-00001' }] };
    });
    const { error } = await insertOrderWithFreeNo(row(), ORG);
    expect(error?.code).toBe('23505');
    expect(insertedNos().length).toBe(6);
  });
});
