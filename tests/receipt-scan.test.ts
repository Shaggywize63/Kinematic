import { parseReceiptText, usableGstin, scanReceipt } from '../src/services/expenses/receiptScan.service';

jest.mock('../src/services/ai.service', () => ({ AIService: { getFunctionalKey: async () => 'test-key' } }));

describe('receipt scan · parsing', () => {
  const google = JSON.stringify({
    merchant: 'Google India Private Limited', txn_date: '2026-10-31', amount: 34078.4, currency: 'inr', tax_amount: 5198.4,
    category: 'marketing', supplier_gstin: '06AACCG0527D1Z8', invoice_number: '5736909862', gst_rate: 18,
  });

  it('reads a tax invoice: seller, GSTIN, invoice number, GST rate and amount', () => {
    expect(parseReceiptText(google, 'finance')).toEqual({
      merchant: 'Google India Private Limited', txn_date: '2026-10-31', amount: 34078.4, currency: 'INR', tax_amount: 5198.4,
      category: 'marketing', supplier_gstin: '06AACCG0527D1Z8', invoice_number: '5736909862', gst_rate: 18,
    });
  });
  it('keeps claim categories for field claims and widens them for Finance', () => {
    expect(parseReceiptText(google, 'claim').category).toBeNull();           // "marketing" is not a claim category
    expect(parseReceiptText('{"category":"Food"}', 'claim').category).toBe('food');
    expect(parseReceiptText('{"category":"professional fees"}', 'finance').category).toBe('professional_fees');
  });
  it('drops a foreign supplier tax number that is not a GSTIN, and zero tax stays zero', () => {
    const r = parseReceiptText('{"merchant":"Anthropic, PBC","amount":10168.64,"tax_amount":0,"gst_rate":0,"supplier_gstin":"9924USA29003OSI"}', 'finance');
    expect(r.supplier_gstin).toBeNull();
    expect(r).toMatchObject({ amount: 10168.64, tax_amount: 0, gst_rate: 0 });
    expect(usableGstin(' 06aaccg0527d1z8 ')).toBe('06AACCG0527D1Z8');
  });
  it('degrades to empty fields instead of throwing on junk', () => {
    expect(parseReceiptText('sorry, I cannot read this').amount).toBeNull();
    expect(parseReceiptText('{"amount": "abc", "txn_date": "yesterday", "gst_rate": 900}')).toMatchObject({ amount: null, txn_date: null, gst_rate: null });
  });
});

describe('receipt scan · request', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const reply = (text: string) => ({ ok: true, json: async () => ({ content: [{ text }] }) }) as unknown as Response;

  it('sends a PDF as a document block (so invoices are read) and a photo as an image block', async () => {
    const calls: any[] = [];
    global.fetch = (async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return reply('{"amount": 100}'); }) as any;
    await scanReceipt('QUJD', 'application/pdf', 'finance');
    await scanReceipt('QUJD', 'image/png', 'claim');
    expect(calls[0].messages[0].content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } });
    expect(calls[1].messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    expect(calls[0].system).toMatch(/marketing/);                // finance categories
    expect(calls[1].system).not.toMatch(/marketing/);            // claim categories
  });
});
