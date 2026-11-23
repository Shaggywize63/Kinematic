jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

const mockGetDocument = jest.fn();
const mockUpdateDocument = jest.fn();
jest.mock('../src/services/finance/documents.service', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  inputFromDocument: (doc: Record<string, unknown>) => ({
    customer_id: doc.customer_id,
    reference_number: doc.reference_number ?? null,
    subject: doc.subject ?? null,
    items: (doc.items as unknown[]) ?? [],
    notes: doc.notes ?? null,
    terms: doc.terms ?? null,
  }),
}));

import {
  priceOf, currentCycleFor, queueSeatCharge, listPendingSeatCharges, setSeatPrice, applySeatChargesToInvoice,
  nextPaymentFor, nextPaymentsFor, detectSeatPriceFromInvoice, detectedSeatPrice, findClientByFinanceCustomer,
  renewalInfoFor, renewalInfoByCustomer, overdueInfoFrom, type NextPayment,
} from '../src/services/clientBilling.service';

const supa = () => (global as any).__supa;

beforeEach(() => {
  supa().reset();
  mockGetDocument.mockReset();
  mockUpdateDocument.mockReset();
});

describe('priceOf', () => {
  it('reads a positive price from clients.settings.billing.price_per_user', () => {
    expect(priceOf({ settings: { billing: { price_per_user: 500 } } })).toBe(500);
  });
  it('is null when unset, non-numeric, zero, or negative', () => {
    expect(priceOf({ settings: {} })).toBeNull();
    expect(priceOf({ settings: { billing: {} } })).toBeNull();
    expect(priceOf({ settings: { billing: { price_per_user: 0 } } })).toBeNull();
    expect(priceOf({ settings: { billing: { price_per_user: -5 } } })).toBeNull();
    expect(priceOf(null)).toBeNull();
  });
});

describe('currentCycleFor', () => {
  it('derives the cycle window from a monthly recurring invoice', async () => {
    supa().setDefault('finance_documents', {
      data: { next_invoice_date: '2026-12-01', recurrence_interval: 'monthly', recurrence_custom_every: null, recurrence_custom_unit: null },
    });
    const cycle = await currentCycleFor('org-1', 'cust-1');
    expect(cycle).toEqual({ cycle_start: '2026-11-01', cycle_end: '2026-12-01', cycle_days: 30 });
  });

  it('derives the cycle window from a custom "every N days" cadence', async () => {
    supa().setDefault('finance_documents', {
      data: { next_invoice_date: '2026-11-21', recurrence_interval: 'custom', recurrence_custom_every: 14, recurrence_custom_unit: 'day' },
    });
    const cycle = await currentCycleFor('org-1', 'cust-1');
    expect(cycle).toEqual({ cycle_start: '2026-11-07', cycle_end: '2026-11-21', cycle_days: 14 });
  });

  it('is null when no recurring invoice is found', async () => {
    supa().setDefault('finance_documents', { data: null });
    expect(await currentCycleFor('org-1', 'cust-1')).toBeNull();
  });

  it('is null when org/customer are missing', async () => {
    expect(await currentCycleFor('', 'cust-1')).toBeNull();
    expect(await currentCycleFor('org-1', '')).toBeNull();
  });
});

describe('queueSeatCharge', () => {
  it('is a no-op when the client has no per-seat price set', async () => {
    supa().setDefault('clients', { data: { id: 'c1', org_id: 'org-1', settings: {} } });
    await queueSeatCharge('c1', 'u1', 'Ravi');
    expect(supa().chainsFor('client_seat_charges').length).toBe(0);
  });

  it('is a no-op when clientId is null/undefined', async () => {
    await queueSeatCharge(null, 'u1', 'Ravi');
    await queueSeatCharge(undefined, 'u1', 'Ravi');
    expect(supa().chainsFor('clients').length).toBe(0);
  });

  it('charges the full price when no finance customer / cycle is linked', async () => {
    supa().setDefault('clients', { data: { id: 'c1', org_id: 'org-1', settings: { billing: { price_per_user: 1000 } } } });
    await queueSeatCharge('c1', 'u1', 'Ravi Sharma');
    const insert = supa().chainsFor('client_seat_charges')[0];
    const row = insert.ops.find((o: any) => o.method === 'insert')!.args[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      client_id: 'c1', user_id: 'u1', user_label: 'Ravi Sharma',
      price_per_user: 1000, prorated_amount: 1000, status: 'pending',
      cycle_start: null, cycle_end: null, cycle_days: null, days_charged: null,
    });
  });

  it('prorates against the linked recurring invoice cycle', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-10T00:00:00Z'));
    try {
      supa().setDefault('clients', {
        data: { id: 'c1', org_id: 'org-1', settings: { billing: { price_per_user: 3000, finance_customer_id: 'fc-1' } } },
      });
      // A 30-day custom cycle ending 2026-11-20 — "today" (2026-11-10) is 10 days before that.
      supa().setDefault('finance_documents', {
        data: { next_invoice_date: '2026-11-20', recurrence_interval: 'custom', recurrence_custom_every: 30, recurrence_custom_unit: 'day' },
      });
      await queueSeatCharge('c1', 'u2', 'Asha Rao');
      const insert = supa().chainsFor('client_seat_charges')[0];
      const row = insert.ops.find((o: any) => o.method === 'insert')!.args[0] as Record<string, unknown>;
      expect(row.cycle_days).toBe(30);
      expect(row.days_charged).toBe(10);
      expect(row.prorated_amount).toBeCloseTo(1000, 2); // 3000 * 10/30
      expect(row.added_on).toBe('2026-11-10');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never throws — a DB error is swallowed and logged', async () => {
    supa().setDefault('clients', { data: null, error: { message: 'boom' } });
    await expect(queueSeatCharge('c1', 'u1', 'Ravi')).resolves.toBeUndefined();
  });
});

describe('listPendingSeatCharges', () => {
  it('returns only pending charges for the client, oldest first', async () => {
    const rows = [{ id: 's1', status: 'pending' }];
    supa().setDefault('client_seat_charges', { data: rows });
    const out = await listPendingSeatCharges('c1');
    expect(out).toEqual(rows);
    const chain = supa().chainsFor('client_seat_charges')[0];
    expect(chain.eqs).toMatchObject({ client_id: 'c1', status: 'pending' });
  });
});

describe('setSeatPrice', () => {
  it('merges price_per_user into settings.billing without clobbering finance_customer_id', async () => {
    supa().setDefault('clients', {
      data: { settings: { billing: { finance_customer_id: 'fc-1' }, trial: { days: 14 } } },
    });
    await setSeatPrice('c1', 1500);
    const update = supa().chainsFor('clients').find((c: any) => c.ops.some((o: any) => o.method === 'update'));
    const payload = update!.ops.find((o: any) => o.method === 'update')!.args[0] as any;
    expect(payload.settings).toEqual({ trial: { days: 14 }, billing: { finance_customer_id: 'fc-1', price_per_user: 1500 } });
  });

  it('can clear the price with null', async () => {
    supa().setDefault('clients', { data: { settings: { billing: { price_per_user: 1000 } } } });
    await setSeatPrice('c1', null);
    const update = supa().chainsFor('clients').find((c: any) => c.ops.some((o: any) => o.method === 'update'));
    const payload = update!.ops.find((o: any) => o.method === 'update')!.args[0] as any;
    expect(payload.settings.billing.price_per_user).toBeNull();
  });
});

describe('applySeatChargesToInvoice', () => {
  const scope = { org_id: 'org-1', client_id: null, user_id: 'admin-1', actor: 'admin@kinematicapp.com' };

  it('appends pending charges as line items and preserves the invoice recurrence schedule', async () => {
    supa().setDefault('client_seat_charges', { data: [
      { id: 'sc1', user_label: 'Ravi Sharma', added_on: '2026-11-10', cycle_days: 30, days_charged: 10, prorated_amount: 1000 },
      { id: 'sc2', user_label: 'Asha Rao', added_on: '2026-11-15', cycle_days: null, days_charged: null, prorated_amount: 3000 },
    ] });
    mockGetDocument.mockResolvedValue({
      id: 'inv-1', customer_id: 'cust-1', items: [{ name: 'Base plan', quantity: 1, rate: 5000 }],
      recurrence_enabled: true, recurrence_interval: 'monthly', recurrence_custom_every: null,
      recurrence_custom_unit: null, recurrence_start: '2026-01-01', recurrence_reminder_email: true,
    });
    mockUpdateDocument.mockResolvedValue({ id: 'inv-1' });

    const result = await applySeatChargesToInvoice(scope, 'c1', 'inv-1');

    expect(result).toEqual({ applied: 2, total: 4000, invoice_id: 'inv-1' });
    expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
    const [, , , input] = mockUpdateDocument.mock.calls[0];
    expect(input.items).toHaveLength(3);
    expect(input.items[1]).toMatchObject({ name: 'Pro-rated seat — Ravi Sharma', quantity: 1, rate: 1000 });
    expect(input.items[2]).toMatchObject({ name: 'Pro-rated seat — Asha Rao', quantity: 1, rate: 3000 });
    // Recurrence must be carried through explicitly, not left to default off.
    expect(input.recurrence_enabled).toBe(true);
    expect(input.recurrence_interval).toBe('monthly');

    const markInvoiced = supa().chainsFor('client_seat_charges').find((c: any) => c.ops.some((o: any) => o.method === 'update'));
    expect(markInvoiced).toBeDefined();
    const payload = markInvoiced!.ops.find((o: any) => o.method === 'update')!.args[0] as any;
    expect(payload).toMatchObject({ status: 'invoiced', invoice_document_id: 'inv-1' });
  });

  it('throws when there are no pending charges', async () => {
    supa().setDefault('client_seat_charges', { data: [] });
    await expect(applySeatChargesToInvoice(scope, 'c1', 'inv-1')).rejects.toThrow('No pending seat charges');
    expect(mockGetDocument).not.toHaveBeenCalled();
  });
});

describe('nextPaymentFor / nextPaymentsFor — scheduled fallback', () => {
  it('returns the real unpaid invoice, marked not scheduled, when one exists', async () => {
    supa().setDefault('finance_documents', { data: [{ id: 'inv-1', number: 'INV-1', due_date: '2026-11-25', total: 7080, balance: 7080, status: 'sent', share_token: 'tok' }] });
    const np = await nextPaymentFor('org-1', 'cust-1');
    expect(np).toMatchObject({ invoice_id: 'inv-1', due_date: '2026-11-25', scheduled: false });
  });

  it('falls back to the recurring invoice\'s next_invoice_date when nothing is unpaid', async () => {
    supa().setDefault('finance_documents', (chain: any) => {
      // First query (nextUnpaidInvoice): filters on status/balance — nothing outstanding.
      if (chain.eqs.customer_id === 'cust-1' && 'recurrence_enabled' in chain.eqs) {
        return { data: { next_invoice_date: '2026-12-01', recurrence_interval: 'monthly', recurrence_custom_every: null, recurrence_custom_unit: null } };
      }
      return { data: [] };
    });
    const np = await nextPaymentFor('org-1', 'cust-1');
    expect(np).toEqual({ invoice_id: null, number: null, due_date: '2026-12-01', total: null, balance: null, status: 'scheduled', share_token: null, scheduled: true });
  });

  it('is null when there is no unpaid invoice and no recurring invoice either', async () => {
    supa().setDefault('finance_documents', { data: [] });
    expect(await nextPaymentFor('org-1', 'cust-1')).toBeNull();
  });

  it('batched form merges real + scheduled per customer', async () => {
    supa().setDefault('finance_documents', (chain: any) => {
      if (chain.ops.some((o: any) => o.method === 'in') && !('recurrence_enabled' in chain.eqs)) {
        // nextUnpaidInvoicesByCustomer's batched query — only cust-1 has a real unpaid invoice.
        return { data: [{ id: 'inv-1', number: 'INV-1', due_date: '2026-11-25', total: 7080, balance: 7080, status: 'sent', share_token: 'tok', customer_id: 'cust-1' }] };
      }
      // scheduledNextInvoicesByCustomer's batched query — only cust-2 has a recurring template.
      return { data: [{ customer_id: 'cust-2', next_invoice_date: '2026-12-05' }] };
    });
    const out = await nextPaymentsFor('org-1', ['cust-1', 'cust-2', 'cust-3']);
    expect(out['cust-1']).toMatchObject({ due_date: '2026-11-25', scheduled: false });
    expect(out['cust-2']).toMatchObject({ due_date: '2026-12-05', scheduled: true });
    expect(out['cust-3']).toBeUndefined();
  });
});

describe('detectSeatPriceFromInvoice / detectedSeatPrice', () => {
  it('reads the rate off the line item whose quantity matches active users', async () => {
    supa().setDefault('finance_documents', { data: { id: 'inv-1' } });
    supa().setDefault('finance_document_items', { data: [{ quantity: 11, rate: 500 }] });
    expect(await detectSeatPriceFromInvoice('org-1', 'cust-1', 11)).toBe(500);
  });

  it('falls back to the highest-quantity line when none matches exactly', async () => {
    supa().setDefault('finance_documents', { data: { id: 'inv-1' } });
    supa().setDefault('finance_document_items', { data: [{ quantity: 1, rate: 1000 }, { quantity: 12, rate: 500 }] });
    expect(await detectSeatPriceFromInvoice('org-1', 'cust-1', 10)).toBe(500);
  });

  it('is null when the only line has quantity 1 (nothing looks per-seat)', async () => {
    supa().setDefault('finance_documents', { data: { id: 'inv-1' } });
    supa().setDefault('finance_document_items', { data: [{ quantity: 1, rate: 1000 }] });
    expect(await detectSeatPriceFromInvoice('org-1', 'cust-1', 10)).toBeNull();
  });

  it('is null with no invoice, or no org/customer', async () => {
    supa().setDefault('finance_documents', { data: null });
    expect(await detectSeatPriceFromInvoice('org-1', 'cust-1', 10)).toBeNull();
    expect(await detectSeatPriceFromInvoice('', 'cust-1', 10)).toBeNull();
  });

  it('detectedSeatPrice resolves org/customer/active-count from the client row', async () => {
    supa().setDefault('users', { data: [{ id: 'u1', email: 'ravi@aadinath.com' }] });
    supa().setDefault('finance_documents', { data: { id: 'inv-1' } });
    supa().setDefault('finance_document_items', { data: [{ quantity: 1, rate: 500 }] });
    const price = await detectedSeatPrice({ org_id: 'org-1', settings: { billing: { finance_customer_id: 'cust-1' } } });
    expect(price).toBe(500); // quantity (1) matches the active count (1) we stubbed
  });

  it('detectedSeatPrice is null with no linked finance customer', async () => {
    expect(await detectedSeatPrice({ org_id: 'org-1', settings: {} })).toBeNull();
    expect(await detectedSeatPrice(null)).toBeNull();
  });
});

describe('queueSeatCharge — falls back to the detected price', () => {
  it('uses the detected per-seat price when no explicit price is set', async () => {
    supa().setDefault('clients', { data: { id: 'c1', org_id: 'org-1', settings: { billing: { finance_customer_id: 'cust-1' } } } });
    supa().setDefault('users', { data: [] }); // active-user count for detection = 0
    supa().setDefault('finance_documents', { data: { id: 'inv-1' } });
    supa().setDefault('finance_document_items', { data: [{ quantity: 5, rate: 500 }] });
    await queueSeatCharge('c1', 'u1', 'Ravi');
    const insert = supa().chainsFor('client_seat_charges')[0];
    const row = insert.ops.find((o: any) => o.method === 'insert')!.args[0] as Record<string, unknown>;
    expect(row.price_per_user).toBe(500);
  });

  it('is still a no-op when neither an explicit nor a detected price exists', async () => {
    supa().setDefault('clients', { data: { id: 'c1', org_id: 'org-1', settings: { billing: { finance_customer_id: 'cust-1' } } } });
    supa().setDefault('users', { data: [] });
    supa().setDefault('finance_documents', { data: null });
    await queueSeatCharge('c1', 'u1', 'Ravi');
    expect(supa().chainsFor('client_seat_charges').length).toBe(0);
  });
});

describe('renewalInfoFor — days left + percent consumed', () => {
  it('derives days_left and percent_consumed from the recurring cycle', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-21T00:00:00Z'));
    try {
      // Cycle 2026-11-01 → 2026-12-01 (30 days). Today is day 20, so 10 days left, 67% consumed.
      supa().setDefault('finance_documents', {
        data: { next_invoice_date: '2026-12-01', recurrence_interval: 'monthly', recurrence_custom_every: null, recurrence_custom_unit: null },
      });
      const r = await renewalInfoFor('org-1', 'cust-1');
      expect(r).toEqual({ cycle_start: '2026-11-01', cycle_end: '2026-12-01', cycle_days: 30, days_left: 10, percent_consumed: 67 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports 90%+ consumed as the cycle nears its end (the red-highlight threshold)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-29T00:00:00Z'));
    try {
      supa().setDefault('finance_documents', {
        data: { next_invoice_date: '2026-12-01', recurrence_interval: 'monthly', recurrence_custom_every: null, recurrence_custom_unit: null },
      });
      const r = await renewalInfoFor('org-1', 'cust-1');
      expect(r!.days_left).toBe(2);
      expect(r!.percent_consumed).toBeGreaterThanOrEqual(90); // 28/30 ≈ 93%
    } finally {
      jest.useRealTimers();
    }
  });

  it('clamps percent_consumed to 100 and lets days_left go negative once the cycle has ended', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-12-05T00:00:00Z'));
    try {
      supa().setDefault('finance_documents', {
        data: { next_invoice_date: '2026-12-01', recurrence_interval: 'monthly', recurrence_custom_every: null, recurrence_custom_unit: null },
      });
      const r = await renewalInfoFor('org-1', 'cust-1');
      expect(r!.days_left).toBe(-4);
      expect(r!.percent_consumed).toBe(100);
    } finally {
      jest.useRealTimers();
    }
  });

  it('is null when the client has no recurring invoice', async () => {
    supa().setDefault('finance_documents', { data: null });
    expect(await renewalInfoFor('org-1', 'cust-1')).toBeNull();
  });
});

describe('renewalInfoByCustomer — batched', () => {
  it('derives a renewal window per customer, first (soonest-due) invoice winning', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-21T00:00:00Z'));
    try {
      supa().setDefault('finance_documents', { data: [
        { customer_id: 'cust-1', next_invoice_date: '2026-12-01', recurrence_interval: 'monthly', recurrence_custom_every: null, recurrence_custom_unit: null },
        { customer_id: 'cust-1', next_invoice_date: '2027-01-01', recurrence_interval: 'monthly', recurrence_custom_every: null, recurrence_custom_unit: null },
        { customer_id: 'cust-2', next_invoice_date: '2026-11-28', recurrence_interval: 'custom', recurrence_custom_every: 14, recurrence_custom_unit: 'day' },
      ] });
      const out = await renewalInfoByCustomer('org-1', ['cust-1', 'cust-2', 'cust-3']);
      expect(out['cust-1']).toMatchObject({ cycle_end: '2026-12-01', days_left: 10 });
      expect(out['cust-2']).toMatchObject({ cycle_start: '2026-11-14', cycle_end: '2026-11-28', cycle_days: 14 });
      expect(out['cust-3']).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('is empty with no org or no customers', async () => {
    expect(await renewalInfoByCustomer('', ['cust-1'])).toEqual({});
    expect(await renewalInfoByCustomer('org-1', [])).toEqual({});
  });
});

describe('overdueInfoFrom — derived from an already-fetched NextPayment', () => {
  const real = (overrides: Partial<NextPayment> = {}): NextPayment => ({
    invoice_id: 'inv-1', number: 'INV-1', due_date: '2026-11-01', total: 7080, balance: 7080,
    status: 'sent', share_token: 'tok', scheduled: false, ...overrides,
  });

  it('reports days overdue for a real unpaid invoice whose due date has passed', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-21T00:00:00Z'));
    try {
      expect(overdueInfoFrom(real({ due_date: '2026-11-01' }))).toEqual({
        invoice_id: 'inv-1', number: 'INV-1', due_date: '2026-11-01', balance: 7080, days_overdue: 20,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('is null for a scheduled projection (nothing actually billed yet)', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-21T00:00:00Z'));
    try {
      const scheduled: NextPayment = { invoice_id: null, number: null, due_date: '2026-10-01', total: null, balance: null, status: 'scheduled', share_token: null, scheduled: true };
      expect(overdueInfoFrom(scheduled)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('is null when the due date is today or in the future, and when there is no payment', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-21T00:00:00Z'));
    try {
      expect(overdueInfoFrom(real({ due_date: '2026-11-21' }))).toBeNull();
      expect(overdueInfoFrom(real({ due_date: '2026-12-01' }))).toBeNull();
      expect(overdueInfoFrom(null)).toBeNull();
      expect(overdueInfoFrom(undefined)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('findClientByFinanceCustomer', () => {
  it('finds the client whose billing.finance_customer_id matches', async () => {
    supa().setDefault('clients', { data: [
      { id: 'c1', settings: { billing: { finance_customer_id: 'cust-x' } } },
      { id: 'c2', settings: { billing: { finance_customer_id: 'cust-1' } } },
    ] });
    expect(await findClientByFinanceCustomer('org-1', 'cust-1')).toEqual({ id: 'c2' });
  });

  it('is null when no client matches, or org/customer are missing', async () => {
    supa().setDefault('clients', { data: [{ id: 'c1', settings: {} }] });
    expect(await findClientByFinanceCustomer('org-1', 'cust-1')).toBeNull();
    expect(await findClientByFinanceCustomer('', 'cust-1')).toBeNull();
  });
});
