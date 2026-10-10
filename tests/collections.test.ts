/**
 * Collections / outstanding logic (Gomant C2): the DERIVED "paid" amount, FIFO auto-allocation, manual
 * allocation validation and the outlet balance resolution. No schema change and no invoice mutation, so
 * everything here is a pure function of (invoices, payments) plus thin Supabase readers.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import {
  paidByInvoice, buildInvoiceBalances, openInvoices, allocateFifo, validateManualAllocations,
  resolveOutstandingBalance, loadOutletInvoiceBalances, loadLedgerBalance, istDateOf, addDaysToDate,
} from '../src/services/distribution/collections.service';

const supa = () => (global as any).__supa;
beforeEach(() => supa().reset());

const inv = (id: string, no: string, total: number, issued_at: string, o: Record<string, unknown> = {}) => ({
  id, invoice_no: no, outlet_id: 'o1', distributor_id: 'd1', grand_total: total, issued_at, status: 'issued', ...o,
});
const pay = (status: string, apps: Array<{ invoice_id: string; amount: number }>) => ({ status, applied_to_invoices: apps });

describe('paidByInvoice (derived paid)', () => {
  it('sums cleared and pending allocations per invoice', () => {
    const paid = paidByInvoice([
      pay('cleared', [{ invoice_id: 'a', amount: 100 }, { invoice_id: 'b', amount: 40 }]),
      pay('pending', [{ invoice_id: 'a', amount: 50.5 }]),
    ]);
    expect(paid.get('a')).toBe(150.5);
    expect(paid.get('b')).toBe(40);
  });

  it('ignores bounced and cancelled payments (and any unknown status)', () => {
    const paid = paidByInvoice([
      pay('bounced', [{ invoice_id: 'a', amount: 100 }]),
      pay('cancelled', [{ invoice_id: 'a', amount: 70 }]),
      pay('failed', [{ invoice_id: 'a', amount: 5 }]),
      pay('cleared', [{ invoice_id: 'a', amount: 30 }]),
    ]);
    expect(paid.get('a')).toBe(30);
  });

  it('tolerates legacy / malformed rows without throwing', () => {
    const paid = paidByInvoice([
      { status: 'cleared', applied_to_invoices: null },
      { status: 'cleared', applied_to_invoices: {} },
      { status: 'cleared', applied_to_invoices: [null, 'x', { amount: 5 }, { invoice_id: 'a', amount: -3 }, { invoice_id: 'a', amount: 'abc' }] },
      { status: 'CLEARED', applied_to_invoices: [{ invoice_id: 'a', amount: 7 }] },
    ] as any);
    expect(paid.get('a')).toBe(7);
    expect(paid.size).toBe(1);
  });
});

describe('buildInvoiceBalances / openInvoices', () => {
  const invoices = [
    inv('c', 'INV-3', 300, '2026-09-20T05:00:00Z'),
    inv('a', 'INV-1', 1000, '2026-09-01T05:00:00Z'),
    inv('b', 'INV-2', 500, '2026-09-10T05:00:00Z'),
    inv('x', 'INV-X', 999, '2026-09-05T05:00:00Z', { status: 'cancelled' }),
  ];

  it('orders oldest first, drops cancelled invoices and derives paid/balance', () => {
    const rows = buildInvoiceBalances(invoices, [
      pay('cleared', [{ invoice_id: 'a', amount: 400 }]),
      pay('bounced', [{ invoice_id: 'b', amount: 500 }]), // bounced => b stays fully open
    ]);
    expect(rows.map((r) => r.invoice_id)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).toMatchObject({ invoice_no: 'INV-1', total: 1000, paid: 400, balance: 600 });
    expect(rows[1]).toMatchObject({ paid: 0, balance: 500 });
  });

  it('openInvoices keeps only balance > 0', () => {
    const rows = buildInvoiceBalances(invoices, [pay('cleared', [{ invoice_id: 'b', amount: 500 }])]);
    expect(rows.find((r) => r.invoice_id === 'b')!.balance).toBe(0);
    expect(openInvoices(rows).map((r) => r.invoice_id)).toEqual(['a', 'c']);
  });

  it('a pending cheque counts as paid until it bounces', () => {
    const pending = buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-01T05:00:00Z')], [pay('pending', [{ invoice_id: 'a', amount: 100 }])]);
    expect(openInvoices(pending)).toHaveLength(0);
    const bounced = buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-01T05:00:00Z')], [pay('bounced', [{ invoice_id: 'a', amount: 100 }])]);
    expect(openInvoices(bounced)).toHaveLength(1);
  });

  it('derives invoice_date in IST and due_date from the distributor payment terms (null when none)', () => {
    // 2026-09-30T20:00Z is 2026-10-01 01:30 IST.
    const rows = buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-30T20:00:00Z')], [], new Map([['d1', 30]]));
    expect(rows[0].invoice_date).toBe('2026-10-01');
    expect(rows[0].due_date).toBe('2026-10-31');
    expect(buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-30T20:00:00Z')], [], new Map([['d1', 0]]))[0].due_date).toBeNull();
    expect(buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-30T20:00:00Z')], [])[0].due_date).toBeNull();
  });

  it('date helpers', () => {
    expect(istDateOf('2026-01-01T19:00:00Z')).toBe('2026-01-02');
    expect(istDateOf('garbage')).toBe('');
    expect(addDaysToDate('2026-02-27', 3)).toBe('2026-03-02');
  });
});

describe('allocateFifo', () => {
  const open = buildInvoiceBalances([
    inv('a', 'INV-1', 1000, '2026-09-01T05:00:00Z'),
    inv('b', 'INV-2', 500, '2026-09-10T05:00:00Z'),
    inv('c', 'INV-3', 300, '2026-09-20T05:00:00Z'),
  ], [pay('cleared', [{ invoice_id: 'a', amount: 200 }])]);

  it('fills the oldest invoice first, spilling into the next', () => {
    const r = allocateFifo(open, 1000);
    expect(r.allocations).toEqual([
      { invoice_id: 'a', invoice_no: 'INV-1', amount: 800 },
      { invoice_id: 'b', invoice_no: 'INV-2', amount: 200 },
    ]);
    expect(r.allocated).toBe(1000);
    expect(r.unallocated).toBe(0);
  });

  it('stops mid-invoice when the amount runs out', () => {
    const r = allocateFifo(open, 300);
    expect(r.allocations).toEqual([{ invoice_id: 'a', invoice_no: 'INV-1', amount: 300 }]);
  });

  it('leaves the remainder on account when the payment exceeds all open balances', () => {
    const r = allocateFifo(open, 2000); // open total = 800 + 500 + 300 = 1600
    expect(r.allocations.map((a) => a.amount)).toEqual([800, 500, 300]);
    expect(r.allocated).toBe(1600);
    expect(r.unallocated).toBe(400);
  });

  it('allocates nothing (all on account) when there are no open invoices', () => {
    const r = allocateFifo([], 250);
    expect(r.allocations).toEqual([]);
    expect(r.unallocated).toBe(250);
  });

  it('is exact to the paisa (no float drift)', () => {
    const o = buildInvoiceBalances([inv('a', 'INV-1', 0.3, '2026-09-01T05:00:00Z'), inv('b', 'INV-2', 0.3, '2026-09-02T05:00:00Z')], []);
    const r = allocateFifo(o, 0.5);
    expect(r.allocations.map((a) => a.amount)).toEqual([0.3, 0.2]);
    expect(r.unallocated).toBe(0);
  });

  it('never exceeds an invoice balance and skips fully paid ones', () => {
    const rows = buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-01T05:00:00Z'), inv('b', 'INV-2', 100, '2026-09-02T05:00:00Z')], [pay('cleared', [{ invoice_id: 'a', amount: 100 }])]);
    const r = allocateFifo(rows, 150); // not pre-filtered: a is fully paid
    expect(r.allocations).toEqual([{ invoice_id: 'b', invoice_no: 'INV-2', amount: 100 }]);
    expect(r.unallocated).toBe(50);
  });
});

describe('validateManualAllocations', () => {
  const balances = buildInvoiceBalances([
    inv('a', 'INV-1', 1000, '2026-09-01T05:00:00Z'),
    inv('b', 'INV-2', 500, '2026-09-10T05:00:00Z'),
  ], [pay('cleared', [{ invoice_id: 'a', amount: 400 }])]);

  it('accepts allocations within balance and stamps the SERVER invoice_no (ignores a client-sent one)', () => {
    const v = validateManualAllocations([
      { invoice_id: 'a', amount: 600, invoice_no: 'TAMPERED' },
      { invoice_id: 'b', amount: 100 },
    ], balances, 700);
    expect(v.ok).toBe(true);
    expect(v.allocations).toEqual([
      { invoice_id: 'a', invoice_no: 'INV-1', amount: 600 },
      { invoice_id: 'b', invoice_no: 'INV-2', amount: 100 },
    ]);
  });

  it('rejects an invoice that is not this outlet\'s (wrong outlet / org / cancelled / nonexistent)', () => {
    const v = validateManualAllocations([{ invoice_id: 'zzz', amount: 10 }], balances, 100);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/do not belong to this outlet/);
    expect(v.invoice_ids).toEqual(['zzz']);
  });

  it('rejects an amount above the invoice balance (balance is net of earlier payments)', () => {
    const v = validateManualAllocations([{ invoice_id: 'a', amount: 600.01 }], balances, 1000);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/exceeds the outstanding balance/);
    expect(v.invoice_ids).toEqual(['a']);
  });

  it('rejects when the same invoice is listed twice and the merged amount is over balance', () => {
    const v = validateManualAllocations([{ invoice_id: 'b', amount: 300 }, { invoice_id: 'b', amount: 300 }], balances, 1000);
    expect(v.ok).toBe(false);
  });

  it('merges duplicate entries within balance into one entry', () => {
    const v = validateManualAllocations([{ invoice_id: 'b', amount: 100 }, { invoice_id: 'b', amount: 150 }], balances, 1000);
    expect(v.ok).toBe(true);
    expect(v.allocations).toEqual([{ invoice_id: 'b', invoice_no: 'INV-2', amount: 250 }]);
  });

  it('rejects when allocations add up to more than the payment amount', () => {
    const v = validateManualAllocations([{ invoice_id: 'a', amount: 600 }, { invoice_id: 'b', amount: 500 }], balances, 1000);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/exceeds the payment amount/);
  });

  it('rejects an allocation to an already fully paid invoice', () => {
    const paid = buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-01T05:00:00Z')], [pay('cleared', [{ invoice_id: 'a', amount: 100 }])]);
    expect(validateManualAllocations([{ invoice_id: 'a', amount: 1 }], paid, 1).ok).toBe(false);
  });

  it('a bounced payment frees the balance again', () => {
    const b = buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-01T05:00:00Z')], [pay('bounced', [{ invoice_id: 'a', amount: 100 }])]);
    expect(validateManualAllocations([{ invoice_id: 'a', amount: 100 }], b, 100).ok).toBe(true);
  });
});

describe('resolveOutstandingBalance', () => {
  const open = buildInvoiceBalances([inv('a', 'INV-1', 100, '2026-09-01T05:00:00Z'), inv('b', 'INV-2', 50.25, '2026-09-02T05:00:00Z')], []);
  it('prefers the ledger running balance when the outlet has ledger rows (even 0 or negative)', () => {
    expect(resolveOutstandingBalance(1234.5, open)).toBe(1234.5);
    expect(resolveOutstandingBalance(0, open)).toBe(0);
    expect(resolveOutstandingBalance(-20, open)).toBe(-20);
  });
  it('falls back to the sum of open invoice balances without ledger rows', () => {
    expect(resolveOutstandingBalance(null, open)).toBe(150.25);
    expect(resolveOutstandingBalance(null, [])).toBe(0);
  });
});

describe('Supabase readers (tenant scoping)', () => {
  it('loadOutletInvoiceBalances scopes invoices and payments by org + outlet and only reads issued / cleared+pending', async () => {
    supa().setDefault('invoices', { data: [inv('a', 'INV-1', 100, '2026-09-01T05:00:00Z')] });
    supa().setDefault('payments', { data: [pay('cleared', [{ invoice_id: 'a', amount: 40 }])] });
    supa().setDefault('distributors', { data: [{ id: 'd1', payment_terms_days: 15 }] });

    const rows = await loadOutletInvoiceBalances('org-1', 'out-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paid: 40, balance: 60, due_date: '2026-09-16' });

    const invChain = supa().chainsFor('invoices')[0];
    expect(invChain.eqs).toMatchObject({ org_id: 'org-1', outlet_id: 'out-1', status: 'issued' });
    const payChain = supa().chainsFor('payments')[0];
    expect(payChain.eqs).toMatchObject({ org_id: 'org-1', outlet_id: 'out-1' });
    expect(payChain.ops.find((o: any) => o.method === 'in').args).toEqual(['status', ['cleared', 'pending']]);
    expect(supa().chainsFor('distributors')[0].eqs).toMatchObject({ org_id: 'org-1' });
  });

  it('does not read payments or distributors when the outlet has no invoices', async () => {
    supa().setDefault('invoices', { data: [] });
    expect(await loadOutletInvoiceBalances('org-1', 'out-1')).toEqual([]);
    expect(supa().chainsFor('payments')).toHaveLength(0);
  });

  it('surfaces a DB error instead of silently treating it as "nothing outstanding"', async () => {
    supa().setDefault('invoices', { data: null, error: { message: 'boom' } });
    await expect(loadOutletInvoiceBalances('org-1', 'out-1')).rejects.toThrow('boom');
  });

  it('loadLedgerBalance reads the latest row for the org + outlet (null when none)', async () => {
    supa().queue('ledger_entries', { data: [{ running_balance: '2500.50' }] });
    expect(await loadLedgerBalance('org-1', 'out-1')).toBe(2500.5);
    expect(supa().chainsFor('ledger_entries')[0].eqs).toMatchObject({ org_id: 'org-1', outlet_id: 'out-1' });
    supa().queue('ledger_entries', { data: [] });
    expect(await loadLedgerBalance('org-1', 'out-1')).toBeNull();
  });
});
