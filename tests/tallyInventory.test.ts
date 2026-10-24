jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import {
  buildInventoryLines, buildDistributorLedger, buildStockItem, unresolvedLines,
} from '../src/services/distribution/integrations/tally.inventory';
import { renderInvoice, renderOrder, renderMasterLedger, renderMasterStockItem, renderTallyXml } from '../src/services/distribution/integrations/tally.mapper';

const supa = () => (global as any).__supa;
const INT = { id: '55555555-5555-4555-8555-555555555555', org_id: '11111111-1111-4111-8111-111111111111', config: { company_name: 'Gomant Traders' } };
const names = new Map([
  ['s1', { name: 'TMT Bar 12mm', unit: 'Kgs' }],
  ['s2', { name: 'Cement "OPC" & Co', unit: 'Bag' }],
]);

describe('buildInventoryLines', () => {
  const items = [
    { sku_id: 's1', qty: 100, taxable_value: 5000 },
    { sku_id: 's2', qty: 10, taxable_value: 3500 },
  ];
  it('builds one inventory entry per line with the sales allocation and escaped names', () => {
    const r = buildInventoryLines(items, names, 'Sales Account', 8500)!;
    expect(r.total).toBe(8500);
    expect(r.xml.match(/<ALLINVENTORYENTRIES.LIST>/g)).toHaveLength(2);
    expect(r.xml).toContain('<STOCKITEMNAME>TMT Bar 12mm</STOCKITEMNAME>');
    expect(r.xml).toContain('Cement &quot;OPC&quot; &amp; Co');
    expect(r.xml).toContain('<RATE>50/Kgs</RATE>');
    expect(r.xml).toContain('<BILLEDQTY> 100 Kgs</BILLEDQTY>');
    expect(r.xml).toContain('<LEDGERNAME>Sales Account</LEDGERNAME>');
  });
  it('returns null (ledger-only fallback) if any line is unlinked, unit-less, or the totals disagree', () => {
    expect(buildInventoryLines([...items, { sku_id: 'zz', qty: 1, taxable_value: 1 }], names, 'S', 8501)).toBeNull();
    expect(buildInventoryLines(items, new Map([['s1', { name: 'x', unit: '' }], ['s2', names.get('s2')!]]), 'S', 8500)).toBeNull();
    expect(buildInventoryLines(items, names, 'S', 9000)).toBeNull();
    expect(buildInventoryLines([], names, 'S', 0)).toBeNull();
    expect(buildInventoryLines([{ sku_id: 's1', qty: 0, taxable_value: 0 }], names, 'S', 0)).toBeNull();
  });
  it('tolerates paise rounding (<= 5 paise) and zeroes free goods', () => {
    expect(buildInventoryLines(items, names, 'S', 8500.04)).not.toBeNull();
    const free = buildInventoryLines([{ sku_id: 's1', qty: 5, taxable_value: 999, is_free_good: true }, ...items], names, 'S', 8500)!;
    expect(free.total).toBe(8500);
  });
  it('names the unlinked products for the error message', () => {
    expect(unresolvedLines([{ sku_id: 's1', qty: 1, sku_name: 'A' }, { sku_id: 'q', qty: 1, sku_name: 'Widget' }], names)).toEqual(['Widget']);
  });
});

describe('master builders', () => {
  it('dealer ledger: registered dealer gets GSTIN + state name; unregistered is flagged; values are escaped', () => {
    const reg = buildDistributorLedger({ name: 'x', gstin: '27ABCDE1234F1Z5', state_code: '27', address: { line1: '12 <Market> Rd', city: 'Pune', pincode: '411001' }, credit_limit: 50000, payment_terms_days: 30, email: 'a@b.com' }, 'Sharma & Sons');
    expect(reg).toContain('NAME="Sharma &amp; Sons"');
    expect(reg).toContain('<PARENT>Sundry Debtors</PARENT>');
    expect(reg).toContain('<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>');
    expect(reg).toContain('<PARTYGSTIN>27ABCDE1234F1Z5</PARTYGSTIN>');
    expect(reg).toContain('<LEDSTATENAME>Maharashtra</LEDSTATENAME>');
    expect(reg).toContain('12 &lt;Market&gt; Rd');
    expect(reg).toContain('<CREDITLIMIT>50000.00</CREDITLIMIT>');
    expect(reg).toContain('<BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>');
    const unreg = buildDistributorLedger({ name: 'y' }, 'Y Traders');
    expect(unreg).toContain('Unregistered');
    expect(unreg).not.toContain('PARTYGSTIN');
    expect(unreg).not.toContain('CREDITLIMIT');
  });
  it('stock item: creates its unit too, defaults the unit, never sets a parent group', () => {
    const x = buildStockItem({ name: 'n', sku_code: 'TMT12', unit: 'Kgs', category: 'Steel' }, 'TMT Bar');
    expect(x).toContain('<UNIT NAME="Kgs" ACTION="Create">');
    expect(x).toContain('<PARTNUMBER>TMT12</PARTNUMBER>');
    expect(x).toContain('<BASEUNITS>Kgs</BASEUNITS>');
    expect(x).not.toContain('<PARENT>');
    expect(buildStockItem({ name: 'n' }, 'n')).toContain('<BASEUNITS>Nos</BASEUNITS>');
  });
});

function seedInvoice(opts: { linked: boolean }) {
  const s = supa(); s.reset();
  s.setDefault('invoices', { data: { id: 'inv1', invoice_no: 'INV-1', distributor_id: 'd1', issued_at: '2026-10-01T00:00:00Z', irn: null, eway_bill_no: null, taxable_value: 8500, cgst: 765, sgst: 765, igst: 0, cess: 0, round_off: 0, grand_total: 10030 }, error: null });
  s.setDefault('distribution_external_party_map', { data: null, error: null });
  s.setDefault('distributors', { data: { name: 'Sharma', legal_name: 'Sharma Traders', tally_ledger_name: null }, error: null });
  s.setDefault('invoice_items', { data: [{ sku_id: 's1', qty: 100, taxable_value: 5000 }, { sku_id: 's2', qty: 10, taxable_value: 3500 }], error: null });
  s.setDefault('distribution_tally_masters', (c: any) => {
    if (c.eqs.kind === 'party') return { data: null, error: null };
    return { data: opts.linked ? [
      { name: 'TMT Bar 12mm', data: { unit: 'Kgs' }, matched_ref_id: 's1' },
      { name: 'Cement OPC', data: { unit: 'Bag' }, matched_ref_id: 's2' },
    ] : [], error: null };
  });
}

describe('renderInvoice', () => {
  it('item mode when every line is linked: inventory lines, ISINVOICE, sales rides on the allocations (not a separate entry)', async () => {
    seedInvoice({ linked: true });
    const xml = await renderInvoice(INT, 'inv1');
    expect(xml).toContain('<ISINVOICE>Yes</ISINVOICE>');
    expect(xml.match(/<STOCKITEMNAME>/g)).toHaveLength(2);
    // the sales ledger appears only inside the two accounting allocations
    expect(xml.match(/<LEDGERNAME>Sales Account<\/LEDGERNAME>/g)).toHaveLength(2);
    expect(xml).toContain('<LEDGERNAME>Sharma Traders</LEDGERNAME>');
    expect(xml).toContain('<AMOUNT>-10030.00</AMOUNT>');
  });
  it('unchanged ledger-only voucher when items are not linked', async () => {
    seedInvoice({ linked: false });
    const xml = await renderInvoice(INT, 'inv1');
    expect(xml).not.toContain('ALLINVENTORYENTRIES');
    expect(xml).not.toContain('ISINVOICE');
    expect(xml.match(/<LEDGERNAME>Sales Account<\/LEDGERNAME>/g)).toHaveLength(1);
  });
});

describe('renderOrder / master renderers / dispatcher', () => {
  function seedOrder(linked: boolean) {
    const s = supa(); s.reset();
    s.setDefault('orders', { data: { id: 'o1', order_no: 'ORD-9', distributor_id: 'd1', placed_at: '2026-10-02T00:00:00Z', taxable_value: 8500, notes: null }, error: null });
    s.setDefault('order_items', { data: [{ sku_id: 's1', sku_name: 'TMT', qty: 100, taxable_value: 5000 }, { sku_id: 's2', sku_name: 'Cement', qty: 10, taxable_value: 3500 }], error: null });
    s.setDefault('distribution_external_party_map', { data: null, error: null });
    s.setDefault('distributors', { data: { name: 'Sharma', legal_name: 'Sharma Traders' }, error: null });
    s.setDefault('distribution_tally_masters', (c: any) => c.eqs.kind === 'party' ? { data: null, error: null }
      : { data: linked ? [{ name: 'TMT Bar 12mm', data: { unit: 'Kgs' }, matched_ref_id: 's1' }, { name: 'Cement OPC', data: { unit: 'Bag' }, matched_ref_id: 's2' }]
                       : [{ name: 'TMT Bar 12mm', data: { unit: 'Kgs' }, matched_ref_id: 's1' }], error: null });
  }
  it('Sales Order carries the order number, due date and party amount (no taxes)', async () => {
    seedOrder(true);
    const xml = await renderTallyXml(INT, 'order', 'o1');
    expect(xml).toContain('VCHTYPE="Sales Order"');
    expect(xml).toContain('<ORDERNO>ORD-9</ORDERNO>');
    expect(xml).toContain('<ORDERDUEDATE>20261002</ORDERDUEDATE>');
    expect(xml).toContain('<AMOUNT>-8500.00</AMOUNT>');
  });
  it('refuses an order with unlinked products and names them', async () => {
    seedOrder(false);
    await expect(renderOrder(INT, 'o1')).rejects.toThrow(/not linked to Tally stock items: Cement/);
  });
  it('master renderers use the All Masters envelope and the voucher-consistent ledger name', async () => {
    const s = supa(); s.reset();
    s.setDefault('distribution_external_party_map', { data: null, error: null });
    s.setDefault('distribution_tally_masters', { data: null, error: null });
    s.setDefault('distributors', { data: { name: 'Sharma', legal_name: 'Sharma Traders', gstin: null, state_code: '27', address: {}, credit_limit: 0, payment_terms_days: 0 }, error: null });
    const l = await renderMasterLedger(INT, 'd1');
    expect(l).toContain('<REPORTNAME>All Masters</REPORTNAME>');
    expect(l).toContain('NAME="Sharma Traders"');
    s.setDefault('skus', { data: { name: 'TMT Bar', sku_code: 'T1', category: 'Steel', unit: 'Kgs', tally_stock_item_name: 'TMT Bar 12mm' }, error: null });
    const k = await renderMasterStockItem(INT, 'k1');
    expect(k).toContain('STOCKITEM NAME="TMT Bar 12mm"');
  });
});
