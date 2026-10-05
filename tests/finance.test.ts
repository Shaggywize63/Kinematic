import { computeDocument, amountInWords, round2, durationLabel, durationOf } from '../src/services/finance/money';
import { displayStatus } from '../src/services/finance/documents.service';
import { reportToCsv } from '../src/services/finance/reports.service';
import { isMasterCaller, requireFinanceAccess } from '../src/middleware/financeAccess';

const line = (o: Record<string, unknown> = {}) => ({ name: 'Widget', quantity: 2, rate: 1000, gst_rate: 18, ...o }) as never;

describe('finance totals', () => {
  it('splits GST into CGST+SGST for an intra-state supply and rounds to the rupee', () => {
    const { totals, intraState } = computeDocument([line()], { sellerStateCode: '29', placeOfSupply: '29' });
    expect(intraState).toBe(true);
    expect(totals).toMatchObject({ subtotal: 2000, taxable_value: 2000, cgst: 180, sgst: 180, igst: 0, tax_total: 360, total: 2360, round_off: 0 });
  });

  it('charges IGST for an inter-state supply', () => {
    const { totals } = computeDocument([line()], { sellerStateCode: '29', placeOfSupply: '27' });
    expect(totals).toMatchObject({ cgst: 0, sgst: 0, igst: 360, total: 2360 });
  });

  it('applies line discount before tax and stores the round-off separately', () => {
    const { totals, lines } = computeDocument([line({ quantity: 3, rate: 333.33, discount_pct: 10 })], { sellerStateCode: '29', placeOfSupply: '29' });
    expect(lines[0].taxable_value).toBe(899.99);
    expect(totals.discount_total).toBe(100);
    expect(round2(totals.taxable_value + totals.tax_total + totals.round_off)).toBe(totals.total);
    expect(Number.isInteger(totals.total)).toBe(true);
  });

  it('zeroes tax for tax-exempt customers and honours adjustments', () => {
    const { totals } = computeDocument([line()], { sellerStateCode: '29', placeOfSupply: '27', taxExempt: true, adjustment: -50 });
    expect(totals).toMatchObject({ tax_total: 0, adjustment: -50, total: 1950 });
  });

  it('defaults to intra-state when the seller state is unknown', () => {
    expect(computeDocument([line()], {}).intraState).toBe(true);
  });
});

describe('amountInWords', () => {
  it('uses lakh/crore grouping', () => {
    expect(amountInWords(2360)).toBe('Indian Rupee Two Thousand Three Hundred Sixty Only');
    expect(amountInWords(1234567)).toBe('Indian Rupee Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Only');
    expect(amountInWords(25000000.5)).toBe('Indian Rupee Two Crore Fifty Lakh and Fifty Paise Only');
    expect(amountInWords(0)).toBe('Indian Rupee Zero Only');
  });
});

describe('displayStatus', () => {
  const past = '2000-01-01', future = '2999-01-01';
  it('derives overdue only for unpaid, sent invoices past their due date', () => {
    expect(displayStatus({ doc_type: 'invoice', status: 'sent', due_date: past, balance: 10 })).toBe('overdue');
    expect(displayStatus({ doc_type: 'invoice', status: 'partially_paid', due_date: past, balance: 10 })).toBe('overdue');
    expect(displayStatus({ doc_type: 'invoice', status: 'paid', due_date: past, balance: 0 })).toBe('paid');
    expect(displayStatus({ doc_type: 'invoice', status: 'sent', due_date: future, balance: 10 })).toBe('sent');
    expect(displayStatus({ doc_type: 'invoice', status: 'draft', due_date: past, balance: 10 })).toBe('draft');
  });
  it('derives expired quotes', () => {
    expect(displayStatus({ doc_type: 'quote', status: 'sent', expiry_date: past })).toBe('expired');
    expect(displayStatus({ doc_type: 'quote', status: 'accepted', expiry_date: past })).toBe('accepted');
  });
});

describe('reportToCsv', () => {
  it('escapes quotes/commas and neutralises spreadsheet formulas', () => {
    const csv = reportToCsv({
      title: 't', meta: {}, columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', type: 'money' }],
      rows: [{ a: '=HYPERLINK("x")', b: 10 }, { a: 'Acme, Inc', b: -5 }], totals: { a: 'Total', b: 5 },
    });
    expect(csv.split('\n')).toEqual(['A,B', `"'=HYPERLINK(""x"")",10`, '"Acme, Inc",-5', 'Total,5']);
  });
});

describe('finance access gate', () => {
  const run = (user: Record<string, unknown> | undefined) => {
    let err: { statusCode?: number } | undefined;
    requireFinanceAccess({ user } as never, {} as never, ((e?: { statusCode?: number }) => { err = e; }) as never);
    return err?.statusCode ?? 200;
  };
  it('allows the master admin, including while impersonating', () => {
    expect(run({ email: 'S@kinematicapp.com', role: 'super_admin' })).toBe(200);
    expect(run({ email: 'someone@client.com', role: 'client', impersonated_by: { email: 's@kinematicapp.com' } })).toBe(200);
    expect(isMasterCaller({ user: { email: 'x@y.com' } } as never)).toBe(false);
  });
  it('blocks every other super_admin and admin by default', () => {
    expect(run({ email: 'other@kinematicapp.com', role: 'super_admin', enabled_modules: ['finance'] })).toBe(403);
    expect(run({ email: 'a@c.com', role: 'admin', client_id: 'c1', enabled_modules: [] })).toBe(403);
    expect(run({ email: 'a@c.com', role: 'admin', client_id: 'c1', enabled_modules: ['crm'] })).toBe(403);
    expect(run(undefined)).toBe(401);
  });
  it('allows a client admin only when finance was explicitly granted', () => {
    expect(run({ email: 'a@c.com', role: 'admin', client_id: 'c1', enabled_modules: ['finance'] })).toBe(200);
    expect(run({ email: 'a@c.com', role: 'client', client_id: 'c1', enabled_modules: ['finance'] })).toBe(200);
    expect(run({ email: 'f@c.com', role: 'supervisor', client_id: 'c1', enabled_modules: ['finance'] })).toBe(403);
    expect(run({ email: 'a@c.com', role: 'admin', client_id: null, enabled_modules: ['finance'] })).toBe(403);
  });
});

describe('invoice PDF logo', () => {
  // 1x1 PNG
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const base = (settings: Record<string, unknown>) => ({
    doc: { doc_type: 'invoice', number: 'INV-1', status: 'sent', issue_date: '2026-10-01', due_date: '2026-10-10', customer_snapshot: { name: 'C' }, bill_to: {}, ship_to: {},
      subtotal: 100, discount_total: 0, taxable_value: 100, cgst: 9, sgst: 9, igst: 0, tax_total: 18, adjustment: 0, round_off: 0, total: 118, amount_paid: 0, balance: 118 },
    items: [{ name: 'x', quantity: 1, rate: 100, discount_pct: 0, gst_rate: 18, taxable_value: 100, cgst: 9, sgst: 9, igst: 0, total: 118 }],
    settings: { business_name: 'Biz', ...settings },
  });
  const render = async (settings: Record<string, unknown>) => (await import('../src/services/finance/pdf.service')).renderDocumentPdf(base(settings) as never);

  it('embeds an uploaded (data URL) logo without any network fetch', async () => {
    const withLogo = await render({ logo_url: PNG });
    expect(withLogo.subarray(0, 4).toString()).toBe('%PDF');
    expect(withLogo.toString('latin1')).toContain('/Subtype /Image');
    expect((await render({})).toString('latin1')).not.toContain('/Subtype /Image');
  });
  it('honours the show_logo switch and ignores unusable logos instead of failing', async () => {
    expect((await render({ logo_url: PNG, template: { show_logo: false } })).toString('latin1')).not.toContain('/Subtype /Image');
    for (const bad of ['data:image/gif;base64,AAAA', 'data:image/png;base64,', 'not a url', 'http://169.254.169.254/x.png', 'https://localhost/x.png']) {
      const pdf = await render({ logo_url: bad });
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
    }
  });
});

describe('line duration (rate is per month)', () => {
  const opts = { sellerStateCode: '06', placeOfSupply: '20' };
  it('multiplies quantity × rate by the months and taxes the result', () => {
    // 25 users × ₹650/user/month × 3 months (a quarter) = 48,750 + 18% IGST = 57,525 (a real Kinematic invoice)
    const { totals, lines } = computeDocument([{ name: 'Kinematic', quantity: 25, rate: 650, gst_rate: 18, duration_months: 3 }], opts);
    expect(lines[0]).toMatchObject({ gross: 48750, taxable_value: 48750, duration_months: 3 });
    expect(totals).toMatchObject({ subtotal: 48750, taxable_value: 48750, igst: 8775, total: 57525 });
  });
  it('treats a missing or invalid duration as one-time (×1) and applies discount after duration', () => {
    const base = { name: 'x', quantity: 2, rate: 100, gst_rate: 0 };
    for (const d of [undefined, null, 0, -3, 500, NaN]) {
      expect(computeDocument([{ ...base, duration_months: d as number }], opts).totals.total).toBe(200);
    }
    expect(computeDocument([{ ...base, duration_months: 12, discount_pct: 10 }], opts).totals.total).toBe(2160);
  });
  it('labels common durations and falls back to months', () => {
    expect(durationLabel(1)).toBe('1 month (Month)');
    expect(durationLabel(3)).toBe('3 months (Quarter)');
    expect(durationLabel(6)).toBe('6 months (Half-year)');
    expect(durationLabel(12)).toBe('12 months (Year)');
    expect(durationLabel(18)).toBe('18 months');
    expect(durationLabel(null)).toBeNull();
    expect(durationOf('3')).toBe(3);
  });
});
