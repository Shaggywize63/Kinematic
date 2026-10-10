/**
 * Tally Receipt voucher: bill allocations must never be empty / nameless. Rows written before invoice_no was
 * persisted on `applied_to_invoices` entries (and rows from clients that only send invoice_id) have to resolve
 * the bill name from invoices by invoice_id; whatever can't be tied to a bill goes On Account.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { buildPaymentBillAllocations, renderPayment } from '../src/services/distribution/integrations/tally.mapper';

const supa = () => (global as any).__supa;
beforeEach(() => supa().reset());

const names = (xml: string) => [...xml.matchAll(/<NAME>([^<]*)<\/NAME>/g)].map((m) => m[1]);
const types = (xml: string) => [...xml.matchAll(/<BILLTYPE>([^<]*)<\/BILLTYPE>/g)].map((m) => m[1]);
const amounts = (xml: string) => [...xml.matchAll(/<AMOUNT>([^<]*)<\/AMOUNT>/g)].map((m) => m[1]);

describe('buildPaymentBillAllocations (pure)', () => {
  it('no entries => a single On Account row for the full amount (legacy behaviour)', () => {
    const x = buildPaymentBillAllocations([], 500);
    expect(names(x)).toEqual(['On Account']);
    expect(types(x)).toEqual(['On Account']);
    expect(amounts(x)).toEqual(['500.00']);
  });

  it('uses the entry\'s own invoice_no when present', () => {
    const x = buildPaymentBillAllocations([{ invoice_id: 'i1', invoice_no: 'INV-1', amount: 500 }], 500);
    expect(names(x)).toEqual(['INV-1']);
    expect(types(x)).toEqual(['Agst Ref']);
  });

  it('resolves a missing invoice_no from invoice_id', () => {
    const x = buildPaymentBillAllocations(
      [{ invoice_id: 'i1', amount: 300 }, { invoice_id: 'i2', invoice_no: '', amount: 200 }],
      500,
      new Map([['i1', 'INV-1'], ['i2', 'INV-2']]),
    );
    expect(names(x)).toEqual(['INV-1', 'INV-2']);
    expect(amounts(x)).toEqual(['300.00', '200.00']);
  });

  it('never emits an empty <NAME>: an unresolvable entry falls into On Account', () => {
    const x = buildPaymentBillAllocations(
      [{ invoice_id: 'gone', amount: 120 }, { invoice_id: 'i1', amount: 80 }],
      200,
      new Map([['i1', 'INV-1']]),
    );
    expect(names(x)).toEqual(['INV-1', 'On Account']);
    expect(amounts(x)).toEqual(['80.00', '120.00']);
    expect(x).not.toContain('<NAME></NAME>');
  });

  it('adds an On Account row for the unallocated remainder so rows add up to the voucher amount', () => {
    const x = buildPaymentBillAllocations([{ invoice_id: 'i1', invoice_no: 'INV-1', amount: 300 }], 500);
    expect(names(x)).toEqual(['INV-1', 'On Account']);
    expect(amounts(x)).toEqual(['300.00', '200.00']);
  });

  it('adds no remainder row when fully allocated', () => {
    const x = buildPaymentBillAllocations([{ invoice_id: 'i1', invoice_no: 'INV-1', amount: 300 }, { invoice_id: 'i2', invoice_no: 'INV-2', amount: 200 }], 500);
    expect(names(x)).toEqual(['INV-1', 'INV-2']);
  });

  it('XML-escapes bill names', () => {
    const x = buildPaymentBillAllocations([{ invoice_id: 'i1', invoice_no: 'A&B <1>', amount: 5 }], 5);
    expect(x).toContain('<NAME>A&amp;B &lt;1&gt;</NAME>');
  });
});

describe('renderPayment (resolves invoice_no from invoice_id)', () => {
  const integration = { id: 'int-1', org_id: 'org-1', config: { company_name: 'Gomant Co' } };

  const seed = (applied: unknown) => {
    supa().queue('payments', {
      data: {
        id: 'pay-1', payment_no: 'PAY-261010-00001', distributor_id: 'dist-1', mode: 'cash', amount: 1000,
        reference: null, received_at: '2026-10-10T05:00:00Z', applied_to_invoices: applied,
      },
    });
    supa().setDefault('distribution_external_party_map', { data: null });
    supa().setDefault('distributors', { data: { tally_ledger_name: 'Gomant Distributors' } });
  };

  it('looks the invoice numbers up (org scoped) when entries carry only invoice_id', async () => {
    seed([{ invoice_id: 'i1', amount: 600 }, { invoice_id: 'i2', amount: 400 }]);
    supa().setDefault('invoices', { data: [{ id: 'i1', invoice_no: '101026-GOM-00001' }, { id: 'i2', invoice_no: '101026-GOM-00002' }] });

    const xml = await renderPayment(integration as any, 'pay-1');

    expect(names(xml)).toEqual(['101026-GOM-00001', '101026-GOM-00002']);
    expect(types(xml)).toEqual(['Agst Ref', 'Agst Ref']);
    const invChain = supa().chainsFor('invoices')[0];
    expect(invChain.eqs).toMatchObject({ org_id: 'org-1' });
    expect(invChain.ops.find((o: any) => o.method === 'in').args).toEqual(['id', ['i1', 'i2']]);
  });

  it('does not query invoices when every entry already has an invoice_no (new rows)', async () => {
    seed([{ invoice_id: 'i1', invoice_no: 'INV-1', amount: 1000 }]);
    const xml = await renderPayment(integration as any, 'pay-1');
    expect(names(xml)).toEqual(['INV-1']);
    expect(supa().chainsFor('invoices')).toHaveLength(0);
  });

  it('an empty allocation list still renders the legacy On Account voucher', async () => {
    seed([]);
    const xml = await renderPayment(integration as any, 'pay-1');
    expect(names(xml)).toEqual(['On Account']);
    expect(xml).toContain('VCHTYPE="Receipt"');
  });

  it('survives a null / non-array applied_to_invoices', async () => {
    seed(null);
    expect(names(await renderPayment(integration as any, 'pay-1'))).toEqual(['On Account']);
  });
});
