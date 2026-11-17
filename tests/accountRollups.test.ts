/**
 * Accounts-list rollups: open / won deal count and value, and contact count, per account. The fold is pure; the stamp
 * queries crm_deals and crm_contacts by the page's account ids (org-scoped, non-deleted, chunked) and never throws.
 */
const calls: Array<{ table: string; cols: string; org: unknown; ids: string[] }> = [];
let deals: Record<string, unknown>[] = [];
let contacts: Record<string, unknown>[] = [];
let failTable: string | null = null;

jest.mock('../src/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (_col: string, org: unknown) => ({
          in: (_c: string, ids: string[]) => ({
            is: async () => {
              calls.push({ table, cols, org, ids });
              if (failTable === table) return { data: null, error: { message: 'boom' } };
              const src = table === 'crm_deals' ? deals : contacts;
              return { data: src.filter((r) => ids.includes(String(r.account_id))), error: null };
            },
          }),
        }),
      }),
    }),
  },
}));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { foldRollups, stampAccountRollups } from '../src/services/crm/accountRollups.service';

beforeEach(() => { calls.length = 0; deals = []; contacts = []; failTable = null; });

describe('foldRollups', () => {
  it('counts open and won deals with their value, skips lost, and counts contacts', () => {
    const m = foldRollups(['a1', 'a2'], [
      { account_id: 'a1', status: 'open', amount: '1000.4' },
      { account_id: 'a1', status: 'open', amount: 2000 },
      { account_id: 'a1', status: 'won', amount: 500 },
      { account_id: 'a1', status: 'lost', amount: 9999 },
      { account_id: 'zz', status: 'open', amount: 1 },           // not on this page: ignored
      { account_id: 'a2', status: 'open', amount: null },
    ], [{ account_id: 'a1' }, { account_id: 'a1' }, { account_id: 'a2' }]);
    expect(m.get('a1')).toEqual({ open_deals_count: 2, open_deals_value: 3000, won_deals_count: 1, won_deals_value: 500, contacts_count: 2 });
    expect(m.get('a2')).toEqual({ open_deals_count: 1, open_deals_value: 0, won_deals_count: 0, won_deals_value: 0, contacts_count: 1 });
  });
});

describe('stampAccountRollups', () => {
  it('stamps every row, scoped to the org and the page ids', async () => {
    deals = [{ account_id: 'a1', status: 'open', amount: 100 }, { account_id: 'a2', status: 'won', amount: 300 }];
    contacts = [{ account_id: 'a2' }];
    const out = await stampAccountRollups('org-1', [{ id: 'a1', name: 'One' }, { id: 'a2', name: 'Two' }]);
    expect(out[0]).toMatchObject({ id: 'a1', name: 'One', open_deals_count: 1, open_deals_value: 100, contacts_count: 0 });
    expect(out[1]).toMatchObject({ id: 'a2', won_deals_count: 1, won_deals_value: 300, contacts_count: 1 });
    expect(calls.map((c) => c.table).sort()).toEqual(['crm_contacts', 'crm_deals']);
    expect(calls.every((c) => c.org === 'org-1')).toBe(true);
  });

  it('chunks a large page so no single lookup carries more than 100 ids', async () => {
    const rows = Array.from({ length: 230 }, (_, i) => ({ id: `a${i}` }));
    await stampAccountRollups('org-1', rows);
    const dealCalls = calls.filter((c) => c.table === 'crm_deals');
    expect(dealCalls.map((c) => c.ids.length)).toEqual([100, 100, 30]);
  });

  it('a failed lookup leaves zeros and still returns the rows', async () => {
    failTable = 'crm_deals';
    const out = await stampAccountRollups('org-1', [{ id: 'a1' }]);
    expect(out).toEqual([{ id: 'a1', open_deals_count: 0, open_deals_value: 0, won_deals_count: 0, won_deals_value: 0, contacts_count: 0 }]);
  });

  it('does not query for an empty page', async () => {
    expect(await stampAccountRollups('org-1', [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
