/**
 * The manager views of expense claims (all-claims list, summary, CSV) build one filtered
 * PostgREST query and then add ordering / paging to it. A query builder is awaitable
 * ("thenable"), so a helper that is `async` and returns the builder hands back the RESULT of
 * the query instead of the builder — and the next `.order(...)` throws
 * "q.order is not a function" (HTTP 500 in production). These tests drive the real service
 * against a thenable Supabase double so that can't come back.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({
  AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as reports from '../src/services/expenses/claimReports.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const ADMIN = { id: '33333333-3333-3333-3333-333333333333', org_id: ORG, role: 'admin' };
const claim = (o: any = {}) => ({
  id: '44444444-4444-4444-4444-444444444444', org_id: ORG, user_id: '11111111-1111-1111-1111-111111111111',
  claim_no: 'EXP-1', status: 'submitted', total_amount: 250, submitted_at: '2026-10-06T10:00:00Z', ...o,
});

beforeEach(() => {
  __mock.reset();
  __mock.setDefault('expense_claims', { data: [claim(), claim({ id: '55555555-5555-5555-5555-555555555555', claim_no: 'EXP-2', total_amount: 100 })], count: 2 });
  __mock.setDefault('users', { data: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Asha', employee_id: 'E1' }] });
  __mock.setDefault('expense_claim_items', { data: [] });
  __mock.setDefault('expense_approvals', { data: [] });
});

describe('manager claim reports', () => {
  it('listAllClaims returns the page instead of throwing "q.order is not a function"', async () => {
    const out = await reports.listAllClaims(ADMIN, { page: 1, limit: 25 });
    expect(out.rows.map((r: any) => r.claim_no)).toEqual(['EXP-1', 'EXP-2']);
    expect(out.total).toBe(2);
    // ordering and paging were applied to the claims query, scoped to the caller's org
    const chain = __mock.chainsFor('expense_claims')[0];
    expect(chain.eqs.org_id).toBe(ORG);
    expect(chain.ops.map((o) => o.method)).toEqual(expect.arrayContaining(['order', 'range']));
  });

  it('claimsSummary totals the claims without throwing', async () => {
    const s: any = await reports.claimsSummary(ADMIN, {});
    expect(JSON.stringify(s)).toContain('submitted');
  });

  it('claimsCsv builds the export without throwing', async () => {
    const csv = await reports.claimsCsv(ADMIN, {});
    expect(csv.split('\n')[0]).toContain('Claim no');
  });

  it('a filter that can match nothing returns an empty page', async () => {
    __mock.setDefault('expense_claim_items', { data: [] }); // the category lookup finds no claims
    const out = await reports.listAllClaims(ADMIN, { category: 'food' });
    expect(out).toMatchObject({ rows: [], total: 0 });
  });
});
