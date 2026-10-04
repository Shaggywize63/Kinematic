import * as ExcelJS from 'exceljs';
import {
  parseNumber, parseDate, normaliseStatus, detectColumns, buildInvoices, readTable,
} from '../src/services/finance/import.service';
import { stateCodeFromText } from '../src/services/finance/gstStates';

const ZOHO_HEADERS = [
  'Invoice Date', 'Invoice ID', 'Invoice Number', 'Invoice Status', 'Customer ID', 'Customer Name', 'Due Date', 'Payment Terms', 'Sub Total', 'Total',
  'Balance', 'Adjustment', 'Notes', 'Terms & Conditions', 'Item Name', 'Item Desc', 'Quantity', 'Item Price', 'Item Tax %', 'Item Total',
  'Place of Supply', 'GST Treatment', 'GST Identification Number (GSTIN)', 'HSN/SAC', 'Entity Discount Percent', 'Billing City', 'Billing Code',
];

const csv = (rows: string[][]) => Buffer.from('﻿' + rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'));

describe('value parsing', () => {
  it('parses amounts in the shapes accounting exports use', () => {
    expect(parseNumber('1,23,456.50')).toBe(123456.5);
    expect(parseNumber('₹17,700.00')).toBe(17700);
    expect(parseNumber('Rs. 500')).toBe(500);
    expect(parseNumber('(250.00)')).toBe(-250);
    expect(parseNumber('18%')).toBe(18);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1e5')).toBeNull();
  });
  it('reads dates day-first and rejects impossible ones', () => {
    expect(parseDate('2026-10-02')).toBe('2026-10-02');
    expect(parseDate('02/10/2026')).toBe('2026-10-02');
    expect(parseDate('02-10-2026')).toBe('2026-10-02');
    expect(parseDate('2 Oct 2026')).toBe('2026-10-02');
    expect(parseDate('2026-10-02T08:00:00Z')).toBe('2026-10-02');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('13/13/2026')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
  });
  it('maps statuses; overdue/viewed/unpaid are just sent (overdue is derived from the due date)', () => {
    expect(normaliseStatus('Paid')).toBe('paid');
    expect(normaliseStatus('Partially Paid')).toBe('partially_paid');
    expect(normaliseStatus('Draft')).toBe('draft');
    expect(normaliseStatus('Void')).toBe('void');
    expect(normaliseStatus('Overdue')).toBe('sent');
    expect(normaliseStatus('Viewed')).toBe('sent');
    expect(normaliseStatus('')).toBe('sent');
  });
  it('resolves states from codes, abbreviations and names', () => {
    expect(stateCodeFromText('29')).toBe('29');
    expect(stateCodeFromText('[29] - Karnataka')).toBe('29');
    expect(stateCodeFromText('27-Maharashtra')).toBe('27');
    expect(stateCodeFromText('KA')).toBe('29');
    expect(stateCodeFromText('MH')).toBe('27');
    expect(stateCodeFromText('Tamil Nadu')).toBe('33');
    expect(stateCodeFromText('Jammu and Kashmir')).toBe('01');
    expect(stateCodeFromText('Atlantis')).toBeNull();
    expect(stateCodeFromText('')).toBeNull();
  });
});

describe('column detection', () => {
  it('understands a Zoho Invoice export without any mapping step', () => {
    const { mapping, missing, ignored } = detectColumns(ZOHO_HEADERS);
    expect(missing).toEqual([]);
    expect(mapping).toMatchObject({
      number: 'Invoice Number', issue_date: 'Invoice Date', customer: 'Customer Name', due_date: 'Due Date', status: 'Invoice Status',
      item_name: 'Item Name', qty: 'Quantity', rate: 'Item Price', tax_pct: 'Item Tax %', balance: 'Balance', total: 'Total',
      gstin: 'GST Identification Number (GSTIN)', hsn: 'HSN/SAC', terms: 'Terms & Conditions', place_of_supply: 'Place of Supply',
      disc_pct: 'Entity Discount Percent',
    });
    expect(ignored).toContain('Invoice ID'); // not mistaken for the invoice number
    expect(ignored).toContain('Customer ID');
  });
  it('lists exactly what is missing', () => {
    expect(detectColumns(['Customer Name', 'Total']).missing).toEqual(['Invoice Number', 'Invoice Date']);
    expect(detectColumns(['Invoice Number', 'Invoice Date', 'Customer Name']).missing).toEqual(['Item Name (or a Total column)']);
  });
});

describe('grouping rows into invoices', () => {
  const table = (rows: string[][]) => ({ headers: ZOHO_HEADERS, rows: rows.map((r) => Object.fromEntries(ZOHO_HEADERS.map((h, i) => [h, r[i] ?? '']))) });
  const row = (o: Record<string, string>) => ZOHO_HEADERS.map((h) => o[h] ?? '');
  const { mapping } = detectColumns(ZOHO_HEADERS);

  it('turns line-item rows into one invoice with its header fields and lines', () => {
    const t = table([
      row({ 'Invoice Date': '02/10/2026', 'Invoice Number': 'INV-000006', 'Invoice Status': 'Sent', 'Customer Name': 'BMW Ventures', 'Due Date': '17/10/2026', Total: '17700', Balance: '17700', 'Item Name': 'Seat', Quantity: '1', 'Item Price': '15000', 'Item Tax %': '18', 'Place of Supply': 'KA', 'GST Identification Number (GSTIN)': '29aaacb1234c1z9' }),
      row({ 'Invoice Number': 'INV-000006', 'Invoice Date': '02/10/2026', 'Customer Name': 'BMW Ventures', 'Item Name': 'Training', Quantity: '2', 'Item Price': '500', 'Item Tax %': '0' }),
      row({ 'Invoice Date': '24/09/2026', 'Invoice Number': 'INV-000004', 'Invoice Status': 'Paid', 'Customer Name': 'Byte Back', Total: '2124', 'Item Name': 'Support', Quantity: '1', 'Item Price': '1800', 'Item Tax %': '18' }),
    ]);
    const inv = buildInvoices(t, mapping);
    expect(inv.map((i) => i.number)).toEqual(['INV-000006', 'INV-000004']);
    expect(inv[0]).toMatchObject({ issue_date: '2026-10-02', due_date: '2026-10-17', status: 'sent', file_total: 17700, file_balance: 17700, rows: [2, 3] });
    expect(inv[0].lines).toHaveLength(2);
    expect(inv[0].lines[1]).toMatchObject({ name: 'Training', quantity: 2, rate: 500, gst_rate: 0 });
    expect(inv[0].customer).toMatchObject({ name: 'BMW Ventures', gstin: '29AAACB1234C1Z9', place_of_supply: '29' });
    expect(inv[1].status).toBe('paid');
    expect(inv.every((i) => i.problems.length === 0)).toBe(true);
  });

  it('flags conflicting rows, bad dates, missing customers and bad quantities', () => {
    const t = table([
      row({ 'Invoice Date': '02/10/2026', 'Invoice Number': 'A', 'Customer Name': 'X', 'Item Name': 'i', Quantity: '1', 'Item Price': '10' }),
      row({ 'Invoice Date': '03/10/2026', 'Invoice Number': 'A', 'Customer Name': 'Y', 'Item Name': 'i', Quantity: '1', 'Item Price': '10' }),
      row({ 'Invoice Date': '99/99/2026', 'Invoice Number': 'B', 'Customer Name': '', 'Item Name': 'i', Quantity: '0', 'Item Price': '10' }),
    ]);
    const [a, b] = buildInvoices(t, mapping);
    expect(a.problems.join(' ')).toMatch(/different customers/);
    expect(a.problems.join(' ')).toMatch(/different dates/);
    expect(b.problems.join(' ')).toMatch(/Invoice date .* not a valid date/);
    expect(b.problems.join(' ')).toMatch(/Customer name is missing/);
    expect(b.problems.join(' ')).toMatch(/quantity must be/);
  });

  it('imports an invoice-level export (no line items) as one untaxed line for the total', () => {
    const headers = ['Invoice Number', 'Invoice Date', 'Customer Name', 'Total', 'Balance', 'Invoice Status'];
    const t = { headers, rows: [{ 'Invoice Number': 'INV-9', 'Invoice Date': '2026-08-10', 'Customer Name': 'BMW Ventures', Total: '17,700.00', Balance: '0', 'Invoice Status': 'Paid' }] };
    const { mapping: m, missing } = detectColumns(headers);
    expect(missing).toEqual([]);
    const [inv] = buildInvoices(t, m);
    expect(inv.synthesised_line).toBe(true);
    expect(inv.lines).toEqual([expect.objectContaining({ quantity: 1, rate: 17700, gst_rate: 0 })]);
    expect(inv.warnings.join(' ')).toMatch(/single line/);
  });

  it('converts a discount amount into a percentage and defaults tax to 0 with a warning', () => {
    const headers = ['Invoice Number', 'Invoice Date', 'Customer Name', 'Item Name', 'Quantity', 'Item Price', 'Discount Amount', 'Item Tax %'];
    const t = { headers, rows: [{ 'Invoice Number': 'D1', 'Invoice Date': '2026-08-10', 'Customer Name': 'C', 'Item Name': 'x', Quantity: '2', 'Item Price': '500', 'Discount Amount': '100', 'Item Tax %': '' }] };
    const [inv] = buildInvoices(t, detectColumns(headers).mapping);
    expect(inv.lines[0].discount_pct).toBe(10);
    expect(inv.warnings.join(' ')).toMatch(/no tax %/);
  });
});

describe('reading files', () => {
  it('reads a CSV with a BOM, quoted commas and semicolon delimiters', async () => {
    const t = await readTable('x.csv', csv([['Invoice Number', 'Customer Name'], ['INV-1', 'Acme, Inc'], ['INV-2', 'Shri "Ram" Sales']]));
    expect(t.headers).toEqual(['Invoice Number', 'Customer Name']);
    expect(t.rows).toEqual([{ 'Invoice Number': 'INV-1', 'Customer Name': 'Acme, Inc' }, { 'Invoice Number': 'INV-2', 'Customer Name': 'Shri "Ram" Sales' }]);
    const semi = await readTable('y.csv', Buffer.from('Invoice Number;Customer Name\nINV-1;Acme\n'));
    expect(semi.rows[0]['Customer Name']).toBe('Acme');
  });
  it('reads an XLSX, turning date cells and numbers into text', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoices');
    ws.addRow(['Invoice Number', 'Invoice Date', 'Customer Name', 'Total']);
    ws.addRow(['INV-7', new Date(Date.UTC(2026, 9, 2)), 'BMW Ventures', 17700.5]);
    ws.addRow([]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const t = await readTable('x.xlsx', buf);
    expect(t.rows).toEqual([{ 'Invoice Number': 'INV-7', 'Invoice Date': '2026-10-02', 'Customer Name': 'BMW Ventures', Total: '17700.5' }]);
  });
  it('rejects unsupported, empty and corrupt files with clear errors', async () => {
    await expect(readTable('x.pdf', Buffer.from('x'))).rejects.toMatchObject({ statusCode: 400, code: 'UNSUPPORTED' });
    await expect(readTable('x.csv', csv([['Invoice Number']]))).rejects.toMatchObject({ code: 'EMPTY' });
    await expect(readTable('x.xlsx', Buffer.from('not a zip'))).rejects.toMatchObject({ code: 'BAD_FILE' });
  });
});
