jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

jest.mock('../src/services/finance/masters.service', () => ({
  getSettings: jest.fn(async () => ({ state_code: '27', default_payment_terms_days: 0, default_notes: null, default_terms: null })),
  getCustomer: jest.fn(async () => ({
    id: 'cust-1', display_name: 'Aadinath', place_of_supply: '27', tax_preference: 'taxable',
    payment_terms_days: 0, billing_address: {}, shipping_address: {}, gstin: null, gst_treatment: null, pan: null,
    company_name: null, email: null, mobile: null, work_phone: null,
  })),
  pageParams: jest.fn(),
  safeSearch: jest.fn(),
}));

const mockFindClient = jest.fn();
const mockListPending = jest.fn();
const mockApply = jest.fn();
jest.mock('../src/services/clientBilling.service', () => ({
  findClientByFinanceCustomer: (...args: unknown[]) => mockFindClient(...args),
  listPendingSeatCharges: (...args: unknown[]) => mockListPending(...args),
  applySeatChargesToInvoice: (...args: unknown[]) => mockApply(...args),
}));

import { createDocument } from '../src/services/finance/documents.service';
import type { FinanceScope } from '../src/services/finance/scope';
import type { DocumentInput } from '../src/services/finance/documents.service';

const supa = () => (global as any).__supa;
const scope: FinanceScope = { org_id: 'org-1', client_id: null, user_id: 'admin-1', actor: 'admin@kinematicapp.com' };

const input: DocumentInput = {
  customer_id: 'cust-1',
  items: [{ name: 'Field Force + Lead Management', quantity: 11, rate: 500 }],
};

function stubDocumentPipeline() {
  // The mock's query builder doesn't model RPCs — nextNumber() calls supabaseAdmin.rpc() directly.
  (supa().client as any).rpc = jest.fn(async () => ({ data: 'INV-000012', error: null }));
  supa().setDefault('finance_items', { data: [] }); // no item_ids on our line, so the exemption lookup is a no-op
  supa().queue('finance_documents', { data: { id: 'doc-1', customer_id: 'cust-1' } }); // insert
  supa().setDefault('finance_document_items', { data: [] }); // items insert, then getDocument's loadItems
  supa().setDefault('finance_document_events', { data: [] });
  supa().setDefault('finance_payment_allocations', { data: [] });
  // getDocument's own loadRow (select '*') — second read against finance_documents.
  supa().queue('finance_documents', { data: { id: 'doc-1', doc_type: 'invoice', status: 'draft', customer_id: 'cust-1', balance: 0 } });
}

beforeEach(() => {
  supa().reset();
  mockFindClient.mockReset();
  mockListPending.mockReset();
  mockApply.mockReset();
  stubDocumentPipeline();
});

describe('createDocument — auto-apply pending seat charges', () => {
  it('applies pending charges when the customer is a linked client with some queued', async () => {
    mockFindClient.mockResolvedValue({ id: 'client-1' });
    mockListPending.mockResolvedValue([{ id: 'sc1' }]);
    mockApply.mockResolvedValue({ applied: 1, total: 250, invoice_id: 'doc-1' });

    await createDocument(scope, 'invoice', input);

    expect(mockFindClient).toHaveBeenCalledWith('org-1', 'cust-1');
    expect(mockListPending).toHaveBeenCalledWith('client-1');
    expect(mockApply).toHaveBeenCalledWith(scope, 'client-1', 'doc-1');
  });

  it('does not apply when the customer has no pending charges', async () => {
    mockFindClient.mockResolvedValue({ id: 'client-1' });
    mockListPending.mockResolvedValue([]);

    await createDocument(scope, 'invoice', input);

    expect(mockApply).not.toHaveBeenCalled();
  });

  it('does not apply when the customer is not a linked Client Management client', async () => {
    mockFindClient.mockResolvedValue(null);

    await createDocument(scope, 'invoice', input);

    expect(mockListPending).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('never applies to a historical import (opts.number set), even with pending charges', async () => {
    mockFindClient.mockResolvedValue({ id: 'client-1' });
    mockListPending.mockResolvedValue([{ id: 'sc1' }]);

    await createDocument(scope, 'invoice', input, {}, { number: 'INV-OLD-001' });

    expect(mockFindClient).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('never applies to a quote', async () => {
    mockFindClient.mockResolvedValue({ id: 'client-1' });
    mockListPending.mockResolvedValue([{ id: 'sc1' }]);

    await createDocument(scope, 'quote', input);

    expect(mockFindClient).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('does not fail the invoice when applying pending charges throws', async () => {
    mockFindClient.mockResolvedValue({ id: 'client-1' });
    mockListPending.mockResolvedValue([{ id: 'sc1' }]);
    mockApply.mockRejectedValue(new Error('boom'));

    await expect(createDocument(scope, 'invoice', input)).resolves.toBeDefined();
  });
});
