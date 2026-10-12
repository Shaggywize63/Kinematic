/**
 * Employee-wise monthly ₹ collection targets — pure rules + the report/upsert/delete controllers. Actual collection
 * for a user = sum of that user's cleared/pending payments received in the month; % and band are derived; a cancelled
 * payment or a non-target role never counts.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn(async () => undefined) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import {
  monthStart, monthRangeUtc, achievementPct, achievementBand, cleanAmount, isTargetRole, buildReport,
} from '../src/services/distribution/collectionTargets.service';
import { list, upsert, remove } from '../src/controllers/distribution/collectionTargets.controller';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const REP1 = '11111111-1111-4111-8111-111111111111';
const REP2 = '22222222-2222-4222-8222-222222222222';
const SUP = '33333333-3333-4333-8333-333333333333';
const ADMIN = { id: '99999999-9999-4999-8999-999999999999', org_id: ORG, client_id: null, role: 'admin' };

function call(handler: any, req: Record<string, unknown>) {
  return new Promise<{ res: any; body: any }>((resolve, reject) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn((b) => resolve({ res, body: b })) };
    handler({ user: ADMIN, query: {}, params: {}, body: {}, headers: {}, ...req }, res, (e: unknown) => reject(e ?? new Error('next()')));
  });
}

beforeEach(() => __mock.reset());

describe('collection-target pure rules', () => {
  it('monthStart normalises YYYY-MM / YYYY-MM-DD, rejects junk', () => {
    expect(monthStart('2026-10')).toBe('2026-10-01');
    expect(monthStart('2026-10-15')).toBe('2026-10-01');
    expect(monthStart('2026-13')).toBeNull();
    expect(monthStart('nope')).toBeNull();
    expect(monthStart('')).toBeNull();
  });
  it('monthRangeUtc spans the IST month in UTC (first IST midnight = prev-day 18:30 UTC)', () => {
    const { startUtc, endUtc } = monthRangeUtc('2026-10-01');
    expect(startUtc).toBe('2026-09-30T18:30:00.000Z');
    expect(endUtc).toBe('2026-10-31T18:30:00.000Z');
  });
  it('achievementPct rounds and never divides by zero', () => {
    expect(achievementPct(5000, 10000)).toBe(50);
    expect(achievementPct(10000, 0)).toBe(0);
    expect(achievementPct(3333, 10000)).toBe(33.33);
  });
  it('achievementBand', () => {
    expect(achievementBand(0, 10000)).toBe('none');
    expect(achievementBand(12000, 10000)).toBe('exceeded');
    expect(achievementBand(7000, 10000)).toBe('on_track');
    expect(achievementBand(1000, 10000)).toBe('behind');
  });
  it('cleanAmount strips ₹/commas, keeps non-negative', () => {
    expect(cleanAmount('₹1,20,000')).toBe(120000);
    expect(cleanAmount(5000)).toBe(5000);
    expect(cleanAmount('')).toBeNull();
    expect(cleanAmount(-1)).toBeNull();
  });
  it('isTargetRole covers reps + supervisors, not admins/other', () => {
    expect(isTargetRole('field_executive')).toBe(true);
    expect(isTargetRole('city_manager')).toBe(true);
    expect(isTargetRole('executive')).toBe(true);
    expect(isTargetRole('admin')).toBe(false);
    expect(isTargetRole(null)).toBe(false);
  });
  it('buildReport lists only target-role users, with target/actual/%/band', () => {
    const rows = buildReport(
      [{ id: REP1, name: 'Rep One', role: 'field_executive' }, { id: SUP, name: 'Sup', role: 'city_manager' }, { id: 'a', name: 'Admin', role: 'admin' }],
      [{ id: 't1', user_id: REP1, target_amount: 10000 }],
      [{ user_id: REP1, actual: 6000 }],
    );
    expect(rows).toHaveLength(2); // admin excluded
    const r1 = rows.find((r) => r.user_id === REP1)!;
    expect(r1).toMatchObject({ target_amount: 10000, actual: 6000, balance: 4000, achievement_pct: 60, band: 'on_track' });
    const sup = rows.find((r) => r.user_id === SUP)!;
    expect(sup).toMatchObject({ target_amount: 0, actual: 0, band: 'none' });
  });
});

describe('GET report', () => {
  it('sums only cleared/pending payments per user and attaches targets', async () => {
    __mock.queue('users', { data: [{ id: REP1, name: 'Rep One', role: 'field_executive', employee_id: 'E1' }, { id: REP2, name: 'Rep Two', role: 'executive', employee_id: 'E2' }] });
    __mock.queue('distribution_collection_targets', { data: [{ id: 't1', user_id: REP1, target_amount: 10000, note: null }] });
    __mock.queue('payments', { data: [
      { salesman_id: REP1, amount: 4000, status: 'cleared', received_at: '2026-10-05T06:00:00Z' },
      { salesman_id: REP1, amount: 2000, status: 'pending', received_at: '2026-10-06T06:00:00Z' },
      { salesman_id: REP1, amount: 9999, status: 'cancelled', received_at: '2026-10-06T06:00:00Z' },
      { salesman_id: REP2, amount: 1500, status: 'cleared', received_at: '2026-10-07T06:00:00Z' },
    ] });

    const { res, body } = await call(list, { query: { month: '2026-10' } });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.data.month).toBe('2026-10-01');
    const r1 = body.data.rows.find((r: any) => r.user_id === REP1);
    expect(r1).toMatchObject({ target_amount: 10000, actual: 6000, achievement_pct: 60 }); // cancelled 9999 excluded
    const r2 = body.data.rows.find((r: any) => r.user_id === REP2);
    expect(r2).toMatchObject({ target_amount: 0, actual: 1500 });
    expect(body.data.summary).toMatchObject({ users: 2, with_target: 1, total_target: 10000, total_actual: 7500 });
  });
  it('400s a bad month', async () => {
    const { res } = await call(list, { query: { month: 'xx' } });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST upsert', () => {
  it('saves a target for a rep in the caller org', async () => {
    __mock.queue('users', { data: { id: REP1, role: 'field_executive', org_id: ORG } });
    __mock.queue('distribution_collection_targets', { data: { id: 't1', user_id: REP1, target_amount: 12000 } });
    const { res, body } = await call(upsert, { body: { user_id: REP1, month: '2026-10', target_amount: '12000' } });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(body.data.target_amount).toBe(12000);
  });
  it('rejects a user from another org', async () => {
    __mock.queue('users', { data: { id: REP1, role: 'field_executive', org_id: 'other' } });
    const { res } = await call(upsert, { body: { user_id: REP1, month: '2026-10', target_amount: 1000 } });
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it('rejects a non-target role', async () => {
    __mock.queue('users', { data: { id: ADMIN.id, role: 'admin', org_id: ORG } });
    const { res } = await call(upsert, { body: { user_id: ADMIN.id, month: '2026-10', target_amount: 1000 } });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('DELETE', () => {
  it('removes an org-scoped target', async () => {
    __mock.queue('distribution_collection_targets', { data: { id: 't1' } });
    __mock.queue('distribution_collection_targets', { data: null });
    const { res } = await call(remove, { params: { id: 't1' } });
    expect(res.status).toHaveBeenCalledWith(200);
  });
  it('404s an unknown target', async () => {
    __mock.queue('distribution_collection_targets', { data: null });
    const { res } = await call(remove, { params: { id: 'zzz' } });
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
