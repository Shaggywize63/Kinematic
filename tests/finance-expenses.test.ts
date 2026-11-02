import { computeGst, defaultItc, gstinState, isValidGstin, normalizeGstin, ledgerTotals } from '../src/services/finance/expenses.service';

describe('finance expenses · computeGst', () => {
  it('splits a tax-inclusive receipt into taxable + CGST/SGST when supplier is in the same state', () => {
    const g = computeGst({ amount: 1180, gstRate: 18, supplierState: '29', businessState: '29' });
    expect(g).toMatchObject({ taxable_value: 1000, cgst: 90, sgst: 90, igst: 0, total_tax: 180, total: 1180, intra: true });
  });
  it('uses IGST for an inter-state supplier', () => {
    const g = computeGst({ amount: 1180, gstRate: 18, supplierState: '27', businessState: '29' });
    expect(g).toMatchObject({ taxable_value: 1000, cgst: 0, sgst: 0, igst: 180, intra: false });
  });
  it('adds GST on top when the amount is tax-exclusive', () => {
    const g = computeGst({ amount: 1000, taxInclusive: false, gstRate: 12, supplierState: null, businessState: '29' });
    expect(g).toMatchObject({ taxable_value: 1000, total_tax: 120, total: 1120, intra: true });
  });
  it('trusts the tax printed on the bill over the rate', () => {
    const g = computeGst({ amount: 1180, gstRate: 18, gstAmount: 179.99, supplierState: '29', businessState: '29' });
    expect(g.total_tax).toBe(179.99);
    expect(g.taxable_value).toBe(1000.01);
    expect(g.cgst + g.sgst).toBeCloseTo(179.99, 2);
  });
  it('never lets the printed tax exceed an inclusive amount', () => {
    expect(computeGst({ amount: 100, gstRate: 18, gstAmount: 500, supplierState: null, businessState: null }).total_tax).toBe(100);
  });
  it('treats an unknown business state as intra-state and 0% as no tax', () => {
    expect(computeGst({ amount: 500, gstRate: 18, supplierState: '27', businessState: null }).intra).toBe(true);
    expect(computeGst({ amount: 500, gstRate: 0, supplierState: null, businessState: null })).toMatchObject({ total_tax: 0, taxable_value: 500, total: 500 });
  });
  it('keeps CGST + SGST equal to the tax on odd paise', () => {
    const g = computeGst({ amount: 1.01, gstRate: 5, supplierState: '29', businessState: '29' });
    expect(round(g.cgst + g.sgst)).toBe(g.total_tax);
  });
});

describe('finance expenses · input tax credit rules', () => {
  const GSTIN = '29ABCDE1234F1Z5';
  it('validates and normalises GSTINs', () => {
    expect(isValidGstin(GSTIN)).toBe(true);
    expect(isValidGstin('29ABCDE1234F1Z')).toBe(false);
    expect(normalizeGstin(' 29abcde1234f1z5 ')).toBe(GSTIN);
    expect(gstinState(GSTIN)).toBe('29');
    expect(gstinState(null)).toBeNull();
  });
  it('allows credit with a valid GSTIN and a creditable category', () => {
    expect(defaultItc('software', GSTIN, 180)).toEqual({ eligible: true, reason: null });
  });
  it('blocks food, and anything without a valid supplier GSTIN or without tax', () => {
    expect(defaultItc('food', GSTIN, 50).eligible).toBe(false);
    expect(defaultItc('rent', null, 180).reason).toMatch(/GSTIN missing/);
    expect(defaultItc('rent', 'BADGSTIN', 180).reason).toMatch(/invalid/);
    expect(defaultItc('rent', GSTIN, 0).eligible).toBe(false);
  });
});

describe('finance expenses · totals', () => {
  it('sums spend, GST paid, claimable and blocked credit', () => {
    const mk = (tax: number, ok: boolean) => ({ total: 1000 + tax, taxable_value: 1000, total_tax: tax, itc_eligible: ok, itc_total: ok ? tax : 0 } as never);
    expect(ledgerTotals([mk(180, true), mk(90, false)])).toEqual({ count: 2, spend: 2270, taxable: 2000, gst_paid: 270, itc_claimable: 180, itc_blocked: 90 });
  });
});

const round = (n: number) => Math.round(n * 100) / 100;
