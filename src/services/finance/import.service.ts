/**
 * Import previously issued invoices (e.g. a Zoho Invoice export) as CSV or XLSX.
 *
 * Stateless two-step flow — the file is posted twice, and the server re-parses and re-validates each time:
 *   previewInvoiceImport  → parses, matches customers, flags duplicates and problems; writes NOTHING
 *   commitInvoiceImport   → creates customers, invoices (original numbers kept) and "Imported" payments
 *
 * One row per line item; rows sharing an invoice number form one invoice. A file with one row per invoice
 * and just a Total is accepted too (imported as a single line).
 */
import { parse as parseCsv } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { FinanceScope, scoped } from './scope';
import { computeDocument, round2, LineInput } from './money';
import { stateCodeFromText } from './gstStates';
import { getSettings, updateSettings } from './masters.service';
import { addEvent, createDocument } from './documents.service';
import { recalcInvoice } from './payments.service';

const db = () => supabaseAdmin;
const fail = (e: { message: string }) => new AppError(500, e.message, 'DB_ERROR');

export const MAX_ROWS = 20_000;
export const MAX_INVOICES = 2_000;
const PREVIEW_LIMIT = 300;
const TOLERANCE = 1.01; // rupees: rounding noise between our totals and the file's

export interface ImportOptions { create_customers: boolean; allow_total_mismatch: boolean; advance_numbering: boolean }
export const DEFAULT_OPTIONS: ImportOptions = { create_customers: true, allow_total_mismatch: false, advance_numbering: true };

// ── reading the file ────────────────────────────────────────────────────────
export interface Table { headers: string[]; rows: Array<Record<string, string>> }

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: Array<{ text: string }>; hyperlink?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('').trim();
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return cellText(o.text);
    return '';
  }
  return String(v).trim();
}

export async function readTable(fileName: string, buffer: Buffer): Promise<Table> {
  const lower = fileName.toLowerCase();
  let headers: string[] = [];
  let rows: Array<Record<string, string>> = [];
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    let records: Array<Record<string, unknown>>;
    try {
      records = parseCsv(buffer.toString('utf-8'), {
        columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true,
        delimiter: lower.endsWith('.tsv') ? '\t' : [',', ';'],
      });
    } catch (e) {
      throw new AppError(400, `Could not read the CSV: ${(e as Error).message}`, 'BAD_FILE');
    }
    headers = records.length ? Object.keys(records[0]) : [];
    rows = records.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cellText(v)])));
  } else if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); }
    catch { throw new AppError(400, 'Could not read the Excel file. Save it as .xlsx or export a CSV.', 'BAD_FILE'); }
    const ws = wb.worksheets[0];
    if (!ws) throw new AppError(400, 'The Excel file has no sheets', 'BAD_FILE');
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, idx) => { headers[idx - 1] = cellText(cell.value); });
    headers = Array.from(headers, (h) => h ?? '');
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const r: Record<string, string> = {};
      let any = false;
      headers.forEach((h, i) => { if (!h) return; const t = cellText(row.getCell(i + 1).value); r[h] = t; if (t) any = true; });
      if (any) rows.push(r);
    });
  } else {
    throw new AppError(400, 'Upload a .csv or .xlsx file', 'UNSUPPORTED');
  }
  headers = headers.filter(Boolean);
  if (!rows.length) throw new AppError(400, 'The file has no data rows', 'EMPTY');
  if (rows.length > MAX_ROWS) throw new AppError(400, `The file has ${rows.length} rows; the limit is ${MAX_ROWS}. Split it and import in parts.`, 'TOO_BIG');
  return { headers, rows };
}

// ── column detection ────────────────────────────────────────────────────────
type Field =
  | 'number' | 'issue_date' | 'due_date' | 'status' | 'customer' | 'email' | 'gstin' | 'gst_treatment' | 'place_of_supply'
  | 'reference' | 'terms_days' | 'notes' | 'terms' | 'adjustment' | 'total' | 'balance' | 'item_name' | 'item_desc' | 'hsn'
  | 'qty' | 'rate' | 'disc_pct' | 'disc_amt' | 'tax_pct' | 'line_total' | 'bill_street' | 'bill_city' | 'bill_state'
  | 'bill_code' | 'bill_country' | 'paid_date' | 'cgst_pct' | 'sgst_pct' | 'igst_pct';

// Normalised header names (lower-case letters, digits, % and #). Earlier entries win when several headers match.
const ALIASES: Record<Field, string[]> = {
  number: ['invoicenumber', 'invoiceno', 'invoice#', 'invoiceno.', 'invno', 'number'],
  issue_date: ['invoicedate', 'issuedate', 'date'],
  due_date: ['duedate'],
  status: ['invoicestatus', 'status'],
  customer: ['customername', 'customer', 'displayname', 'clientname', 'billtoname'],
  email: ['customeremail', 'emailid', 'email', 'primarycontactemailid', 'primarycontactemail'],
  gstin: ['gstidentificationnumbergstin', 'gstidentificationnumber', 'customergstin', 'gstin', 'gstnumber'],
  gst_treatment: ['gsttreatment'],
  place_of_supply: ['placeofsupply', 'placeofsupplywithstatecode'],
  reference: ['purchaseorder', 'ponumber', 'referencenumber', 'ordernumber', 'reference#', 'po#'],
  terms_days: ['paymentterms'],
  notes: ['notes', 'customernotes'],
  terms: ['termsconditions', 'termsandconditions', 'terms'],
  adjustment: ['adjustment'],
  total: ['total', 'invoicetotal', 'totalamount'],
  balance: ['balance', 'balancedue'],
  item_name: ['itemname', 'item', 'productname', 'product', 'itemdetails'],
  item_desc: ['itemdesc', 'itemdescription'],
  hsn: ['hsn/sac', 'hsnsac', 'hsncode', 'hsn'],
  qty: ['quantity', 'qty'],
  rate: ['itemprice', 'rate', 'unitprice', 'price'],
  disc_pct: ['discount%', 'itemdiscount%', 'discountpercent', 'entitydiscountpercent'],
  disc_amt: ['discountamount', 'itemdiscountamount'],
  tax_pct: ['itemtax%', 'itemtax1%', 'tax%', 'gst%', 'taxrate', 'taxpercentage', 'itemtaxpercent', 'taxpercent'],
  line_total: ['itemtotal', 'lineamount', 'amount'],
  bill_street: ['billingaddress', 'billingstreet', 'billingaddress1'],
  bill_city: ['billingcity'],
  bill_state: ['billingstate'],
  bill_code: ['billingcode', 'billingpincode', 'billingzip', 'billingpostalcode'],
  bill_country: ['billingcountry'],
  paid_date: ['lastpaymentdate', 'paymentdate'],
  // Zoho India exports split GST per component; they add up to the line's GST rate when there is no single tax % column.
  cgst_pct: ['cgstrate%'], sgst_pct: ['sgstrate%'], igst_pct: ['igstrate%'],
};

export const FIELD_LABELS: Partial<Record<Field, string>> = {
  number: 'Invoice number', issue_date: 'Invoice date', due_date: 'Due date', status: 'Status', customer: 'Customer name',
  email: 'Customer email', gstin: 'GSTIN', gst_treatment: 'GST treatment', place_of_supply: 'Place of supply', reference: 'PO / reference',
  total: 'Invoice total', balance: 'Balance due', item_name: 'Item name', item_desc: 'Item description', hsn: 'HSN/SAC', qty: 'Quantity',
  rate: 'Item price', disc_pct: 'Discount %', disc_amt: 'Discount amount', tax_pct: 'Tax %', line_total: 'Item total', notes: 'Notes',
  terms: 'Terms & conditions', adjustment: 'Adjustment', terms_days: 'Payment terms', paid_date: 'Last payment date', cgst_pct: 'CGST rate %', sgst_pct: 'SGST rate %', igst_pct: 'IGST rate %',
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9%#]/g, '');

export type Mapping = Partial<Record<Field, string>>;

export function detectColumns(headers: string[]): { mapping: Mapping; missing: string[]; ignored: string[] } {
  const byNorm = new Map<string, string>();
  for (const h of headers) if (!byNorm.has(norm(h))) byNorm.set(norm(h), h);
  const mapping: Mapping = {};
  const used = new Set<string>();
  for (const [field, aliases] of Object.entries(ALIASES) as Array<[Field, string[]]>) {
    for (const a of aliases) {
      const h = byNorm.get(a);
      if (h && !used.has(h)) { mapping[field] = h; used.add(h); break; }
    }
  }
  const missing: string[] = [];
  if (!mapping.number) missing.push('Invoice Number');
  if (!mapping.issue_date) missing.push('Invoice Date');
  if (!mapping.customer) missing.push('Customer Name');
  if (!mapping.item_name && !mapping.total) missing.push('Item Name (or a Total column)');
  return { mapping, missing, ignored: headers.filter((h) => !used.has(h)) };
}

// ── value parsing ───────────────────────────────────────────────────────────
export function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  let t = String(v).trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[₹$,\s]|rs\.?|inr/gi, '').replace(/%$/, '');
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  if (!/^\d*\.?\d+$/.test(t) && !/^\d+\.$/.test(t)) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
/** YYYY-MM-DD, ISO datetimes, DD/MM/YYYY (India), DD-MM-YYYY, "02 Oct 2026". Slash dates are always day-first. */
export function parseDate(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(t);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return validYmd(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s,-]+(\d{4})$/.exec(t);
  if (m) { const mi = MONTHS.indexOf(m[2].toLowerCase()); return mi >= 0 ? validYmd(+m[3], mi + 1, +m[1]) : null; }
  return null;
}

export type ImportStatus = 'draft' | 'sent' | 'paid' | 'partially_paid' | 'void';
export function normaliseStatus(v: string | undefined): ImportStatus {
  const t = (v ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return 'sent';
  if (t.startsWith('draft')) return 'draft';
  if (t.startsWith('void') || t.startsWith('cancel') || t === 'writtenoff') return 'void';
  if (t.startsWith('partial')) return 'partially_paid';
  if (t === 'paid' || t === 'closed') return 'paid';
  return 'sent'; // sent, viewed, unpaid, overdue, due, pending ... (overdue is derived from the due date)
}

function gstTreatment(v: string | undefined): string | null {
  const t = (v ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;
  if (t.includes('composition')) return 'registered_composition';
  if (t.includes('sez')) return 'sez';
  if (t.includes('overseas')) return 'overseas';
  if (t.includes('consumer')) return 'consumer';
  if (t.includes('unregistered') || t.includes('businessnone') || t === 'none') return 'unregistered';
  if (t.includes('business') || t.includes('registered') || t.includes('gst')) return 'registered_regular';
  return null;
}

// ── grouping rows into invoices ─────────────────────────────────────────────
export interface ParsedLine { name: string; description: string | null; hsn_sac: string | null; quantity: number; rate: number; discount_pct: number; gst_rate: number }
export interface ParsedInvoice {
  number: string; rows: number[];
  issue_date: string | null; due_date: string | null; status: ImportStatus;
  customer: { name: string; email: string | null; gstin: string | null; gst_treatment: string | null; place_of_supply: string | null; address: Record<string, string> };
  reference: string | null; notes: string | null; terms: string | null; terms_days: number | null; adjustment: number;
  file_total: number | null; file_balance: number | null; paid_date: string | null;
  lines: ParsedLine[]; synthesised_line: boolean; problems: string[]; warnings: string[];
}

export function buildInvoices(table: Table, mapping: Mapping): ParsedInvoice[] {
  const get = (row: Record<string, string>, f: Field) => (mapping[f] ? (row[mapping[f] as string] ?? '').trim() : '');
  // Zoho prefixes text that starts with "-", "+" or "=" with an apostrophe so spreadsheets don't read it as a formula.
  const getText = (row: Record<string, string>, f: Field) => get(row, f).replace(/^'(?=[-+=@])/, '');
  const order: string[] = [];
  const byNumber = new Map<string, ParsedInvoice>();

  table.rows.forEach((row, idx) => {
    const rowNo = idx + 2; // 1-based, header is row 1
    const number = get(row, 'number');
    if (!number) { return; }
    let inv = byNumber.get(number);
    const issue = parseDate(get(row, 'issue_date'));
    const custName = get(row, 'customer');
    if (!inv) {
      const addr: Record<string, string> = {};
      const set = (k: string, f: Field) => { const v = get(row, f); if (v) addr[k] = v; };
      set('line1', 'bill_street'); set('city', 'bill_city'); set('state', 'bill_state'); set('pincode', 'bill_code'); set('country', 'bill_country');
      inv = {
        number, rows: [], issue_date: issue, due_date: parseDate(get(row, 'due_date')), status: normaliseStatus(get(row, 'status')),
        customer: {
          name: custName, email: get(row, 'email') || null, gstin: get(row, 'gstin').toUpperCase() || null,
          gst_treatment: gstTreatment(get(row, 'gst_treatment')), place_of_supply: stateCodeFromText(get(row, 'place_of_supply')), address: addr,
        },
        reference: getText(row, 'reference') || null, notes: getText(row, 'notes') || null, terms: getText(row, 'terms') || null,
        terms_days: parseNumber(get(row, 'terms_days')), adjustment: parseNumber(get(row, 'adjustment')) ?? 0,
        file_total: parseNumber(get(row, 'total')), file_balance: parseNumber(get(row, 'balance')), paid_date: parseDate(get(row, 'paid_date')),
        lines: [], synthesised_line: false, problems: [], warnings: [],
      };
      byNumber.set(number, inv); order.push(number);
      const rawDate = get(row, 'issue_date');
      if (!issue) inv.problems.push(rawDate ? `Invoice date "${rawDate}" is not a valid date (use DD/MM/YYYY or YYYY-MM-DD)` : 'Invoice date is missing');
      if (get(row, 'due_date') && !inv.due_date) inv.warnings.push(`Due date "${get(row, 'due_date')}" was not understood; it is calculated from the terms instead`);
      if (!custName) inv.problems.push('Customer name is missing');
      if (get(row, 'place_of_supply') && !inv.customer.place_of_supply) inv.warnings.push(`Place of supply "${get(row, 'place_of_supply')}" was not recognised; your own state is used`);
    } else {
      // Later rows of the same invoice may repeat the header fields; they must agree.
      if (custName && inv.customer.name && custName !== inv.customer.name) inv.problems.push(`Rows ${inv.rows[0]} and ${rowNo} give different customers for the same invoice number`);
      if (issue && inv.issue_date && issue !== inv.issue_date) inv.problems.push(`Rows ${inv.rows[0]} and ${rowNo} give different dates for the same invoice number`);
      if (inv.file_total === null) inv.file_total = parseNumber(get(row, 'total'));
      if (inv.file_balance === null) inv.file_balance = parseNumber(get(row, 'balance'));
    }
    inv.rows.push(rowNo);

    // ── the line on this row
    const name = get(row, 'item_name');
    const qtyRaw = get(row, 'qty'), rateRaw = get(row, 'rate'), totalRaw = get(row, 'line_total');
    if (!name && !qtyRaw && !rateRaw && !totalRaw) return; // header-only row
    let qty = parseNumber(qtyRaw);
    let rate = parseNumber(rateRaw);
    if (qty === null && (rate !== null || totalRaw)) qty = 1;
    if (rate === null && totalRaw && qty) { const lt = parseNumber(totalRaw); rate = lt === null ? null : round2(lt / qty); }
    if (!name && qty === null && rate === null) return;
    if (qty === null || !(qty > 0)) { inv.problems.push(`Row ${rowNo}: quantity must be a number greater than 0`); return; }
    if (rate === null || rate < 0) { inv.problems.push(`Row ${rowNo}: item price is missing or negative`); return; }
    let disc = parseNumber(get(row, 'disc_pct'));
    if (disc === null) {
      const amt = parseNumber(get(row, 'disc_amt'));
      disc = amt && qty * rate > 0 ? round2((amt / (qty * rate)) * 100) : 0;
    }
    let tax = parseNumber(get(row, 'tax_pct'));
    if (tax === null) {
      const parts = (['cgst_pct', 'sgst_pct', 'igst_pct'] as Field[]).map((f) => parseNumber(get(row, f))).filter((n): n is number => n !== null);
      if (parts.length) tax = round2(parts.reduce((a, b) => a + b, 0));
    }
    if (tax !== null && (tax < 0 || tax > 100)) { inv.problems.push(`Row ${rowNo}: tax % must be between 0 and 100`); return; }
    inv.lines.push({
      name: name || '(no description)', description: get(row, 'item_desc') || null, hsn_sac: get(row, 'hsn') || null,
      quantity: qty, rate, discount_pct: Math.min(100, Math.max(0, disc)), gst_rate: tax ?? 0,
    });
    if (tax === null && (mapping.tax_pct || mapping.igst_pct || mapping.cgst_pct)) inv.warnings.push(`Row ${rowNo}: no tax % given, treated as 0%`);
  });

  for (const inv of byNumber.values()) {
    if (!inv.lines.length && inv.file_total !== null && inv.file_total > 0 && !inv.problems.some((p) => p.startsWith('Row '))) {
      // Invoice-level export with no line items: keep the amount as a single untaxed line.
      inv.lines.push({ name: `Imported invoice ${inv.number}`, description: null, hsn_sac: null, quantity: 1, rate: inv.file_total - inv.adjustment, discount_pct: 0, gst_rate: 0 });
      inv.synthesised_line = true;
      inv.warnings.push('No line items in the file: imported as a single line with no tax breakup');
    } else if (!inv.lines.length && !inv.problems.length) {
      inv.problems.push('No line items found for this invoice');
    }
  }
  return order.map((n) => byNumber.get(n) as ParsedInvoice);
}

// ── planning (validation against the database) ──────────────────────────────
export interface PlannedInvoice extends ParsedInvoice {
  action: 'import' | 'skip_duplicate' | 'error';
  customer_action: 'match' | 'create' | 'missing';
  customer_id: string | null;
  calc_total: number; calc_tax: number; paid: number; balance: number;
  due_date_final: string | null; place_of_supply_final: string | null;
}

interface CustomerRow { id: string; display_name: string; gstin: string | null }

async function loadAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw fail(error);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function planImport(s: FinanceScope, invoices: ParsedInvoice[], opts: ImportOptions): Promise<PlannedInvoice[]> {
  if (invoices.length > MAX_INVOICES) throw new AppError(400, `The file has ${invoices.length} invoices; the limit is ${MAX_INVOICES} per import. Split it and import in parts.`, 'TOO_BIG');
  const settings = await getSettings(s);

  const customers = await loadAll<CustomerRow>((a, b) => scoped(db().from('finance_customers').select('id,display_name,gstin'), s).is('deleted_at', null).range(a, b));
  const byName = new Map(customers.map((c) => [c.display_name.trim().toLowerCase(), c.id]));
  const byGstin = new Map(customers.filter((c) => c.gstin).map((c) => [String(c.gstin).toUpperCase(), c.id]));

  const numbers = invoices.map((i) => i.number);
  const existing = new Set<string>();
  for (let i = 0; i < numbers.length; i += 200) {
    const r = await scoped(db().from('finance_documents').select('number'), s).eq('doc_type', 'invoice').is('deleted_at', null).in('number', numbers.slice(i, i + 200));
    if (r.error) throw fail(r.error);
    for (const d of r.data ?? []) existing.add(d.number as string);
  }

  return invoices.map((inv) => {
    const problems = [...inv.problems];
    const warnings = [...inv.warnings];
    const custKey = inv.customer.name.trim().toLowerCase();
    const matchId = (inv.customer.gstin && byGstin.get(inv.customer.gstin)) || byName.get(custKey) || null;
    const customer_action: PlannedInvoice['customer_action'] = matchId ? 'match' : inv.customer.name ? (opts.create_customers ? 'create' : 'missing') : 'missing';
    if (customer_action === 'missing' && inv.customer.name) problems.push(`Customer "${inv.customer.name}" does not exist (enable "create missing customers" or add it first)`);

    const due = inv.due_date ?? null;
    const place = inv.customer.place_of_supply ?? settings.state_code ?? null;
    let calc_total = 0, calc_tax = 0;
    if (inv.lines.length) {
      const calc = computeDocument(inv.lines as LineInput[], { sellerStateCode: settings.state_code, placeOfSupply: place, adjustment: inv.adjustment });
      calc_total = calc.totals.total; calc_tax = calc.totals.tax_total;
    }
    if (inv.file_total !== null && inv.lines.length && Math.abs(calc_total - inv.file_total) > TOLERANCE) {
      const msg = `Calculated total ${calc_total.toFixed(2)} differs from the file's total ${inv.file_total.toFixed(2)} (check the tax columns)`;
      if (opts.allow_total_mismatch) warnings.push(`${msg}; imported with the calculated total`); else problems.push(msg);
    }
    if (inv.due_date && inv.issue_date && inv.due_date < inv.issue_date) warnings.push('Due date is before the invoice date');

    // What has been paid?
    let paid = 0;
    if (inv.status === 'paid') paid = calc_total;
    else if (inv.status !== 'draft' && inv.status !== 'void' && inv.file_balance !== null) {
      paid = round2(calc_total - Math.min(Math.max(inv.file_balance, 0), calc_total));
      if (inv.file_balance < 0 || inv.file_balance > calc_total + TOLERANCE) warnings.push('Balance due is outside 0 to the invoice total; it was adjusted');
    }
    if (inv.status === 'partially_paid' && inv.file_balance === null) warnings.push('Marked partially paid but there is no Balance column; imported as unpaid');
    if (paid < 0.005) paid = 0;
    const balance = inv.status === 'void' ? 0 : round2(calc_total - paid);

    const dup = existing.has(inv.number);
    const action: PlannedInvoice['action'] = dup ? 'skip_duplicate' : problems.length ? 'error' : 'import';
    return {
      ...inv, problems, warnings, action, customer_action, customer_id: matchId, calc_total, calc_tax, paid, balance,
      due_date_final: due, place_of_supply_final: place,
    };
  });
}

// ── preview ─────────────────────────────────────────────────────────────────
export async function previewInvoiceImport(s: FinanceScope, fileName: string, buffer: Buffer, opts: ImportOptions) {
  const table = await readTable(fileName, buffer);
  const { mapping, missing, ignored } = detectColumns(table.headers);
  if (missing.length) {
    throw new AppError(400, `The file is missing required columns: ${missing.join(', ')}. Columns found: ${table.headers.slice(0, 25).join(', ')}`, 'MISSING_COLUMNS');
  }
  const plan = await planImport(s, buildInvoices(table, mapping), opts);
  const importable = plan.filter((p) => p.action === 'import');
  const newCustomers = new Set(importable.filter((p) => p.customer_action === 'create').map((p) => p.customer.name.trim().toLowerCase()));
  return {
    file: { name: fileName, rows: table.rows.length, rows_without_number: table.rows.filter((r) => !(r[mapping.number as string] ?? '').trim()).length },
    columns: {
      detected: (Object.entries(mapping) as Array<[Field, string]>).map(([field, header]) => ({ field, label: FIELD_LABELS[field] ?? field, header })),
      ignored,
    },
    summary: {
      invoices: plan.length, importable: importable.length,
      duplicates: plan.filter((p) => p.action === 'skip_duplicate').length,
      errors: plan.filter((p) => p.action === 'error').length,
      with_warnings: importable.filter((p) => p.warnings.length).length,
      new_customers: newCustomers.size,
      total_value: round2(importable.reduce((x, p) => x + p.calc_total, 0)),
      outstanding: round2(importable.filter((p) => p.status !== 'void' && p.status !== 'draft').reduce((x, p) => x + p.balance, 0)),
    },
    invoices: plan.slice(0, PREVIEW_LIMIT).map((p) => ({
      number: p.number, issue_date: p.issue_date, due_date: p.due_date_final, status: p.status, customer: p.customer.name,
      customer_action: p.customer_action, lines: p.lines.length, total: p.calc_total, file_total: p.file_total, paid: p.paid, balance: p.balance,
      action: p.action, problems: p.problems, warnings: p.warnings,
    })),
    truncated: plan.length > PREVIEW_LIMIT,
  };
}

// ── commit ──────────────────────────────────────────────────────────────────
const dayCount = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export async function commitInvoiceImport(s: FinanceScope, fileName: string, buffer: Buffer, opts: ImportOptions) {
  const table = await readTable(fileName, buffer);
  const { mapping, missing } = detectColumns(table.headers);
  if (missing.length) throw new AppError(400, `The file is missing required columns: ${missing.join(', ')}`, 'MISSING_COLUMNS');
  const plan = await planImport(s, buildInvoices(table, mapping), opts);
  const settings = await getSettings(s);

  const createdCustomers = new Map<string, string>(); // lower-case name → id
  const imported: string[] = [];
  const failed: Array<{ number: string; reason: string }> = [];
  let paymentsCreated = 0;

  for (const p of plan) {
    if (p.action === 'skip_duplicate') continue;
    if (p.action === 'error') { failed.push({ number: p.number, reason: p.problems[0] ?? 'Invalid invoice' }); continue; }

    let documentId: string | null = null;
    let paymentId: string | null = null;
    try {
      // 1. customer
      let customerId = p.customer_id;
      if (!customerId) {
        const key = p.customer.name.trim().toLowerCase();
        customerId = createdCustomers.get(key) ?? null;
        if (!customerId) {
          const addr = p.customer.address;
          const c = await db().from('finance_customers').insert({
            org_id: s.org_id, client_id: s.client_id, display_name: p.customer.name.trim(), email: p.customer.email, gstin: p.customer.gstin,
            gst_treatment: p.customer.gst_treatment, place_of_supply: p.customer.place_of_supply,
            billing_address: Object.keys(addr).length ? { ...addr, country: addr.country ?? 'India' } : {},
            payment_terms_days: Math.max(0, Math.round(p.terms_days ?? 0)), created_by: s.user_id || null,
          }).select('id').single();
          if (c.error) throw fail(c.error);
          customerId = c.data.id as string;
          createdCustomers.set(key, customerId);
        }
      }

      // 2. the invoice, with its original number
      const issue = p.issue_date as string;
      const termsDays = p.due_date_final ? Math.max(0, dayCount(issue, p.due_date_final)) : Math.max(0, Math.round(p.terms_days ?? settings.default_payment_terms_days ?? 0));
      const extra: Record<string, unknown> = p.status === 'draft'
        ? {}
        : p.status === 'void'
          ? { status: 'void', balance: 0, voided_at: new Date().toISOString() }
          : { status: 'sent', sent_at: `${issue}T00:00:00Z` };
      const doc = await createDocument(s, 'invoice', {
        customer_id: customerId, reference_number: p.reference, issue_date: issue, due_date: p.due_date_final, payment_terms_days: termsDays,
        place_of_supply: p.place_of_supply_final, items: p.lines as LineInput[], adjustment: p.adjustment,
        notes: p.notes, terms: p.terms, // explicit null: historical invoices do not pick up today's default notes
      }, extra, { number: p.number });
      documentId = doc.id as string;

      // 3. money already received → an "Imported" payment so receivables, reports and balances agree
      if (p.paid > 0 && p.status !== 'draft' && p.status !== 'void') {
        let paymentNumber = `IMP-${p.number}`;
        for (let n = 2; n < 6; n++) {
          const ex = await scoped(db().from('finance_payments').select('id'), s).eq('payment_number', paymentNumber).is('deleted_at', null).limit(1);
          if (!ex.data?.length) break;
          paymentNumber = `IMP-${p.number}-${n}`;
        }
        const pay = await db().from('finance_payments').insert({
          org_id: s.org_id, client_id: s.client_id, payment_number: paymentNumber, customer_id: customerId, payment_date: p.paid_date ?? issue,
          amount: p.paid, unused_amount: 0, mode: 'other', reference: 'Imported',
          notes: `Imported with historical invoice ${p.number}${p.paid_date ? '' : ' (original payment date unknown; invoice date used)'}`, created_by: s.user_id || null,
        }).select('id').single();
        if (pay.error) throw fail(pay.error);
        paymentId = pay.data.id as string;
        const al = await db().from('finance_payment_allocations').insert({ org_id: s.org_id, payment_id: paymentId, document_id: documentId, amount: p.paid });
        if (al.error) throw fail(al.error);
        await recalcInvoice(s, documentId);
        paymentsCreated++;
      }
      await addEvent(s, documentId, 'imported', { file: fileName });
      imported.push(p.number);
    } catch (e) {
      // Leave nothing half-created behind.
      if (paymentId) { await db().from('finance_payment_allocations').delete().eq('payment_id', paymentId); await db().from('finance_payments').delete().eq('id', paymentId); paymentsCreated = Math.max(0, paymentsCreated - 1); }
      if (documentId) await db().from('finance_documents').delete().eq('id', documentId);
      failed.push({ number: p.number, reason: (e as Error).message || 'Import failed' });
    }
  }

  // Keep new invoices numbering on from the imported ones (same prefix only).
  let nextNumber: number | null = null;
  if (opts.advance_numbering && imported.length) {
    const re = new RegExp(`^${settings.invoice_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
    const max = imported.reduce((m, n) => { const x = re.exec(n); return x ? Math.max(m, parseInt(x[1], 10)) : m; }, 0);
    if (max + 1 > Number(settings.invoice_next_number)) { await updateSettings(s, { invoice_next_number: max + 1 }); nextNumber = max + 1; }
  }

  return {
    imported: imported.length, skipped_duplicates: plan.filter((p) => p.action === 'skip_duplicate').length,
    failed, customers_created: createdCustomers.size, payments_created: paymentsCreated, next_invoice_number: nextNumber,
  };
}
