/**
 * Tally XML voucher mapper.
 *
 * Translates Kinematic invoice / payment / return rows into the XML
 * voucher format Tally Prime accepts via its HTTP/XML interface (port
 * 9000 by default on the Tally PC).
 *
 * Lazy render — called from the public agent-polling endpoint when the
 * bridge agent fetches pending jobs. Source data is joined to the latest
 * source rows at render time so any post-create amendments (e.g. status
 * change on a payment) are reflected.
 *
 * Covered:
 *   • Sales Voucher   (invoices)   — GST splits + optional inventory lines
 *   • Receipt Voucher (payments)   — bill allocations against the original invoice
 *   • Credit Note     (returns)    — sales-return debit + party credit
 *   • Sales Order     (orders)     — inventory lines, order tracking
 *   • Ledger master   (distributors as Sundry Debtors) — Create and Alter (edit sync)
 *   • Stock item      (SKUs)
 *
 * Direction: this module renders OUR rows → Tally XML (push). The return
 * direction (pull masters, pull voucher/order status) is handled by the agent
 * export + the onboarding controller's agentMasters/agentVouchers endpoints.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { xmlEscape, tallyDate, amt, envelope } from './tally.xml';
import { buildInventoryLines, unresolvedLines, buildDistributorLedger, buildStockItem, type StockName, type LineItem } from './tally.inventory';

export type EventKind = 'invoice' | 'payment' | 'return' | 'credit_note' | 'order' | 'master_ledger' | 'master_ledger_update' | 'master_stock_item';

export interface TallyIntegrationConfig {
  company_name?: string;                  // Tally company name (SVCURRENTCOMPANY)
  sales_ledger_name?: string;             // default 'Sales Account'
  cash_ledger_name?: string;              // default 'Cash'
  bank_ledger_name?: string;              // optional override per-mode
  cgst_ledger_name?: string;              // default 'CGST @9%' (Tally convention varies)
  sgst_ledger_name?: string;              // default 'SGST @9%'
  igst_ledger_name?: string;              // default 'IGST @18%'
  cess_ledger_name?: string;              // default 'Cess'
  credit_note_ledger_name?: string;       // default 'Sales Returns'
  round_off_ledger_name?: string;         // default 'Round Off'
  // Opt-in outbound features (all default off; set from the dashboard's Set up & sync screen).
  sync_orders?: boolean;                  // push approved orders as Sales Orders
  auto_create_ledgers?: boolean;          // push new distributors as Sundry Debtor ledgers
  auto_create_stock_items?: boolean;      // push new products as stock items
}

interface IntegrationRow {
  id: string;
  org_id: string;
  config: TallyIntegrationConfig;
}

// ── Ledger-name resolution ─────────────────────────────────────────────────────────────

/**
 * Look up the Tally ledger name for a distributor. Priority:
 *   1. distribution_external_party_map.external_name (admin override)
 *   2. distribution_tally_masters (ledger matched/imported via master pull)
 *   3. distributors.tally_ledger_name (admin override on distributor row)
 *   4. distributors.legal_name (sensible default)
 */
async function partyLedger(integration_id: string, distributor_id: string): Promise<string> {
  const { data: mapping } = await supabaseAdmin
    .from('distribution_external_party_map')
    .select('external_name')
    .eq('integration_id', integration_id)
    .eq('ref_table', 'distributors')
    .eq('ref_id', distributor_id)
    .maybeSingle();
  if (mapping?.external_name) return mapping.external_name as string;

  // Ledger matched/imported through the Tally master-pull (exact Tally spelling).
  const { data: pulled } = await supabaseAdmin
    .from('distribution_tally_masters')
    .select('name')
    .eq('integration_id', integration_id)
    .eq('kind', 'party')
    .eq('matched_ref_id', distributor_id)
    .in('status', ['matched', 'imported'])
    .limit(1)
    .maybeSingle();
  if (pulled?.name) return pulled.name as string;

  const { data: dist } = await supabaseAdmin
    .from('distributors')
    .select('tally_ledger_name, legal_name, name')
    .eq('id', distributor_id)
    .maybeSingle();
  return (dist?.tally_ledger_name as string | null)
    ?? (dist?.legal_name as string | null)
    ?? (dist?.name as string | null)
    ?? `Unknown Party (${distributor_id.slice(0, 8)})`;
}

/** Default ledger-name resolver with per-integration config override. */
export function defaults(cfg: TallyIntegrationConfig) {
  return {
    sales:        cfg.sales_ledger_name        ?? 'Sales Account',
    cash:         cfg.cash_ledger_name         ?? 'Cash',
    bank:         cfg.bank_ledger_name         ?? 'Bank',
    cgst:         cfg.cgst_ledger_name         ?? 'CGST',
    sgst:         cfg.sgst_ledger_name         ?? 'SGST',
    igst:         cfg.igst_ledger_name         ?? 'IGST',
    cess:         cfg.cess_ledger_name         ?? 'Cess',
    credit_note:  cfg.credit_note_ledger_name  ?? 'Sales Returns',
    round_off:    cfg.round_off_ledger_name    ?? 'Round Off',
  };
}

// ── Stock item resolution ────────────────────────────────────────────────────────────────────
/**
 * Map sku_id -> the exact Tally stock item name + unit, for products linked through "Pull from
 * Tally" (distribution_tally_masters, status matched/imported). Products without a pulled link
 * are deliberately absent: we never guess a stock item name Tally may not have.
 */
export async function resolveStockNames(integration_id: string, skuIds: string[]): Promise<Map<string, StockName>> {
  const out = new Map<string, StockName>();
  if (skuIds.length === 0) return out;
  const { data } = await supabaseAdmin
    .from('distribution_tally_masters')
    .select('name, data, matched_ref_id')
    .eq('integration_id', integration_id)
    .eq('kind', 'stock_item')
    .in('status', ['matched', 'imported'])
    .in('matched_ref_id', skuIds);
  for (const m of (data as Array<{ name: string; data: Record<string, unknown> | null; matched_ref_id: string }> | null) ?? []) {
    const unit = String(m.data?.unit ?? '').trim();
    if (m.matched_ref_id && unit) out.set(m.matched_ref_id, { name: m.name, unit });
  }
  return out;
}

// ── Render: invoice → Sales Voucher ─────────────────────────────────────────────────────────
export async function renderInvoice(integration: IntegrationRow, invoice_id: string): Promise<string> {
  const cfg = defaults(integration.config ?? {});
  const company = integration.config?.company_name ?? 'Default Company';

  const { data: inv } = await supabaseAdmin.from('invoices')
    .select('id, invoice_no, distributor_id, issued_at, irn, eway_bill_no, taxable_value, cgst, sgst, igst, cess, round_off, grand_total')
    .eq('id', invoice_id).maybeSingle();
  if (!inv) throw new Error(`invoice ${invoice_id} not found`);

  const party = await partyLedger(integration.id, inv.distributor_id as string);
  const date = tallyDate(inv.issued_at as string);
  const remoteId = `KIN-INV-${inv.id}`;

  // Build ledger entry list. Tally convention:
  //   Party (Sundry Debtors): DR — ISDEEMEDPOSITIVE=Yes, AMOUNT=negative-grand-total
  //   Sales:                  CR — ISDEEMEDPOSITIVE=No,  AMOUNT=positive-taxable
  //   CGST/SGST/IGST/Cess:    CR — ISDEEMEDPOSITIVE=No,  AMOUNT=positive
  //   Round off:              CR — sign depends on direction
  // Item invoice: when every line resolves to a stock item pulled from Tally (and the lines add up),
  // the sales amount rides on the inventory lines (their accounting allocation) so stock moves in Tally.
  // Otherwise the voucher stays ledger-only exactly as before.
  const { data: itemRows } = await supabaseAdmin.from('invoice_items')
    .select('sku_id, qty, unit_price, taxable_value, is_free_good, uom').eq('invoice_id', invoice_id).order('line_no');
  const lineItems = (itemRows as LineItem[] | null) ?? [];
  const stockNames = await resolveStockNames(integration.id, Array.from(new Set(lineItems.map(i => i.sku_id))));
  const inventory = buildInventoryLines(lineItems, stockNames, cfg.sales, Number(inv.taxable_value));

  const entries: string[] = [];

  // Party
  entries.push(`          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xmlEscape(party)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${amt(inv.grand_total)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`);

  // Sales (ledger-only mode)
  if (!inventory && Number(inv.taxable_value) > 0) {
    entries.push(`          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xmlEscape(cfg.sales)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${amt(inv.taxable_value)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`);
  }

  // Taxes
  const tax = (name: string, value: number) => {
    if (!value || value === 0) return;
    entries.push(`          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xmlEscape(name)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${amt(value)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`);
  };
  tax(cfg.cgst, Number(inv.cgst));
  tax(cfg.sgst, Number(inv.sgst));
  tax(cfg.igst, Number(inv.igst));
  tax(cfg.cess, Number(inv.cess));

  // Round off (Tally accepts signed amounts here; CR positive, DR negative)
  if (Number(inv.round_off) !== 0) {
    entries.push(`          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xmlEscape(cfg.round_off)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${amt(inv.round_off)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`);
  }

  const voucher = `          <VOUCHER REMOTEID="${xmlEscape(remoteId)}" VCHTYPE="Sales" ACTION="Create">
            <DATE>${date}</DATE>
            <NARRATION>Invoice ${xmlEscape(inv.invoice_no)}${inv.irn ? ` · IRN ${xmlEscape(inv.irn)}` : ''}${inv.eway_bill_no ? ` · E-way ${xmlEscape(inv.eway_bill_no)}` : ''}</NARRATION>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(inv.invoice_no)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>
            <REFERENCE>${xmlEscape(inv.invoice_no)}</REFERENCE>${inventory ? `
            <ISINVOICE>Yes</ISINVOICE>` : ''}
${entries.join('\n')}${inventory ? `\n${inventory.xml}` : ''}
          </VOUCHER>`;

  return envelope(company, voucher);
}

// ── Payment bill allocations (pure; exported for tests) ──────────────────────────────────────
export interface PaymentAllocationEntry {
  invoice_id?: string;
  invoice_no?: string | null;
  amount?: number;
}

/**
 * BILLALLOCATIONS.LIST XML for a Receipt voucher.
 *
 *   - Each entry becomes an "Agst Ref" row named by its invoice_no; when the entry
 *     has none, `invoiceNoById` (resolved from invoice_id) supplies it.
 *   - Entries with no resolvable invoice number, and any part of the payment
 *     amount not covered by the entries, are emitted as ONE "On Account" row so
 *     the allocations sum to the voucher amount (an empty <NAME/> is never emitted).
 *   - No entries at all => a single On Account row for the full amount (legacy).
 */
export function buildPaymentBillAllocations(
  apps: PaymentAllocationEntry[],
  paymentAmount: number,
  invoiceNoById: Map<string, string> = new Map(),
): string {
  const rows: string[] = [];
  let allocated = 0;
  for (const a of apps ?? []) {
    const amount = Number(a?.amount ?? 0);
    if (!(amount > 0)) continue;
    const name = String(a?.invoice_no ?? '').trim() || (a?.invoice_id ? invoiceNoById.get(a.invoice_id) ?? '' : '');
    if (!name) continue;                       // unresolved -> falls into the On Account remainder
    allocated += amount;
    rows.push(`              <BILLALLOCATIONS.LIST>
                <NAME>${xmlEscape(name)}</NAME>
                <BILLTYPE>Agst Ref</BILLTYPE>
                <AMOUNT>${amt(amount)}</AMOUNT>
              </BILLALLOCATIONS.LIST>`);
  }
  const remainder = Math.round((Number(paymentAmount ?? 0) - allocated) * 100) / 100;
  if (rows.length === 0 || remainder > 0.005) {
    rows.push(`              <BILLALLOCATIONS.LIST>
                <NAME>On Account</NAME>
                <BILLTYPE>On Account</BILLTYPE>
                <AMOUNT>${amt(rows.length === 0 ? paymentAmount : remainder)}</AMOUNT>
              </BILLALLOCATIONS.LIST>`);
  }
  return rows.join('\n');
}

// ── Render: payment → Receipt Voucher ─────────────────────────────────────────────────────────
export async function renderPayment(integration: IntegrationRow, payment_id: string): Promise<string> {
  const cfg = defaults(integration.config ?? {});
  const company = integration.config?.company_name ?? 'Default Company';

  const { data: p } = await supabaseAdmin.from('payments')
    .select('id, payment_no, distributor_id, mode, amount, reference, received_at, applied_to_invoices')
    .eq('id', payment_id).maybeSingle();
  if (!p) throw new Error(`payment ${payment_id} not found`);

  const party = await partyLedger(integration.id, p.distributor_id as string);
  const date = tallyDate(p.received_at as string);
  const remoteId = `KIN-PAY-${p.id}`;

  // Bank vs Cash ledger based on payment mode.
  const debitLedger = p.mode === 'cash' ? cfg.cash : cfg.bank;

  // Bill allocations — if the payment row carries `applied_to_invoices`,
  // emit one BILLALLOCATIONS row per invoice. Older rows (and rows written by
  // clients that only sent invoice_id) have no `invoice_no` on the entry, so it
  // is resolved from the invoices table by invoice_id; an entry whose invoice
  // can't be resolved, plus any unallocated remainder, goes On Account so the
  // allocations always add up to the party credit.
  const apps: PaymentAllocationEntry[] = Array.isArray(p.applied_to_invoices) ? (p.applied_to_invoices as PaymentAllocationEntry[]) : [];
  const missingIds = Array.from(new Set(
    apps.filter(a => a && a.invoice_id && !String(a.invoice_no ?? '').trim()).map(a => a.invoice_id as string),
  ));
  const invoiceNoById = new Map<string, string>();
  if (missingIds.length > 0) {
    const { data: invRows } = await supabaseAdmin.from('invoices')
      .select('id, invoice_no').eq('org_id', integration.org_id).in('id', missingIds);
    for (const r of (invRows as Array<{ id: string; invoice_no: string | null }> | null) ?? []) {
      if (r.invoice_no) invoiceNoById.set(r.id, r.invoice_no);
    }
  }
  const billAllocations = buildPaymentBillAllocations(apps, Number(p.amount), invoiceNoById);

  const voucher = `          <VOUCHER REMOTEID="${xmlEscape(remoteId)}" VCHTYPE="Receipt" ACTION="Create">
            <DATE>${date}</DATE>
            <NARRATION>Payment ${xmlEscape(p.payment_no)} · ${xmlEscape(p.mode)}${p.reference ? ` · ref ${xmlEscape(p.reference)}` : ''}</NARRATION>
            <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(p.payment_no)}</VOUCHERNUMBER>
            <REFERENCE>${xmlEscape(p.reference ?? p.payment_no)}</REFERENCE>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(debitLedger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amt(p.amount)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(party)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${amt(p.amount)}</AMOUNT>
${billAllocations}
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>`;

  return envelope(company, voucher);
}

// ── Render: return → Credit Note ─────────────────────────────────────────────────────────────
export async function renderReturn(integration: IntegrationRow, return_id: string): Promise<string> {
  const cfg = defaults(integration.config ?? {});
  const company = integration.config?.company_name ?? 'Default Company';

  const { data: r } = await supabaseAdmin.from('returns')
    .select('id, return_no, distributor_id, original_invoice_id, reason_code, total_value, cgst, sgst, igst, cess, created_at')
    .eq('id', return_id).maybeSingle();
  if (!r) throw new Error(`return ${return_id} not found`);

  // Original invoice number for the BILLALLOCATIONS reference.
  let originalInvoiceNo = '';
  if (r.original_invoice_id) {
    const { data: orig } = await supabaseAdmin.from('invoices')
      .select('invoice_no').eq('id', r.original_invoice_id).maybeSingle();
    originalInvoiceNo = (orig?.invoice_no as string | undefined) ?? '';
  }

  const party = await partyLedger(integration.id, r.distributor_id as string);
  const date = tallyDate(r.created_at as string);
  const remoteId = `KIN-RET-${r.id}`;

  // Credit Note: sales-returns DEBITED, party CREDITED.
  const taxableValue = Number(r.total_value)
    - Number(r.cgst ?? 0) - Number(r.sgst ?? 0) - Number(r.igst ?? 0) - Number(r.cess ?? 0);

  const entries: string[] = [];
  // Sales Returns debit
  if (taxableValue > 0) {
    entries.push(`            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(cfg.credit_note)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amt(taxableValue)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`);
  }
  // GST debits (reverse the original output tax)
  const taxDebit = (name: string, value: number) => {
    if (!value || value === 0) return;
    entries.push(`            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(name)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amt(value)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`);
  };
  taxDebit(cfg.cgst, Number(r.cgst));
  taxDebit(cfg.sgst, Number(r.sgst));
  taxDebit(cfg.igst, Number(r.igst));
  taxDebit(cfg.cess, Number(r.cess));

  // Party credit
  const billAllocations = originalInvoiceNo
    ? `              <BILLALLOCATIONS.LIST>
                <NAME>${xmlEscape(originalInvoiceNo)}</NAME>
                <BILLTYPE>Agst Ref</BILLTYPE>
                <AMOUNT>${amt(r.total_value)}</AMOUNT>
              </BILLALLOCATIONS.LIST>`
    : `              <BILLALLOCATIONS.LIST>
                <NAME>On Account</NAME>
                <BILLTYPE>On Account</BILLTYPE>
                <AMOUNT>${amt(r.total_value)}</AMOUNT>
              </BILLALLOCATIONS.LIST>`;

  entries.push(`            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(party)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${amt(r.total_value)}</AMOUNT>
${billAllocations}
            </ALLLEDGERENTRIES.LIST>`);

  const voucher = `          <VOUCHER REMOTEID="${xmlEscape(remoteId)}" VCHTYPE="Credit Note" ACTION="Create">
            <DATE>${date}</DATE>
            <NARRATION>Return ${xmlEscape(r.return_no)}${r.reason_code ? ` · ${xmlEscape(r.reason_code)}` : ''}${originalInvoiceNo ? ` · against ${xmlEscape(originalInvoiceNo)}` : ''}</NARRATION>
            <VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(r.return_no)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>
            <REFERENCE>${xmlEscape(originalInvoiceNo || r.return_no)}</REFERENCE>
${entries.join('\n')}
          </VOUCHER>`;

  return envelope(company, voucher);
}

// ── Render: order → Sales Order ──────────────────────────────────────────────────────────────
/**
 * Sales Order voucher (no accounting impact in Tally; it books the order and its items). Needs every
 * line linked to a pulled Tally stock item, so a clear error says which products to link first.
 * Taxes are not carried: they belong on the invoice that later fulfils the order.
 */
export async function renderOrder(integration: IntegrationRow, order_id: string): Promise<string> {
  const cfg = defaults(integration.config ?? {});
  const company = integration.config?.company_name ?? 'Default Company';

  const { data: o } = await supabaseAdmin.from('orders')
    .select('id, order_no, distributor_id, placed_at, taxable_value, notes')
    .eq('id', order_id).maybeSingle();
  if (!o) throw new Error(`order ${order_id} not found`);

  const { data: itemRows } = await supabaseAdmin.from('order_items')
    .select('sku_id, sku_name, sku_code, qty, unit_price, taxable_value, is_free_good, uom').eq('order_id', order_id).order('line_no');
  const items = (itemRows as Array<LineItem & { sku_name?: string | null; sku_code?: string | null }> | null) ?? [];
  const names = await resolveStockNames(integration.id, Array.from(new Set(items.map(i => i.sku_id))));
  const date = tallyDate(o.placed_at as string);
  const lines = buildInventoryLines(items, names, cfg.sales, Number(o.taxable_value), () => `
            <BATCHALLOCATIONS.LIST>
              <GODOWNNAME>Main Location</GODOWNNAME>
              <BATCHNAME>Primary Batch</BATCHNAME>
              <ORDERNO>${xmlEscape(o.order_no)}</ORDERNO>
              <TRACKINGNUMBER>Not Applicable</TRACKINGNUMBER>
              <ORDERDUEDATE>${date}</ORDERDUEDATE>
            </BATCHALLOCATIONS.LIST>`);
  if (!lines) {
    const missing = unresolvedLines(items as Array<LineItem & { sku_name?: string | null; sku_code?: string | null }>, names);
    throw new Error(missing.length
      ? `Sales order not sent: these products are not linked to Tally stock items: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}. Use "Pull from Tally" in Set up & sync.`
      : 'Sales order not sent: its lines do not add up to the order total.');
  }

  const party = await partyLedger(integration.id, o.distributor_id as string);
  const voucher = `          <VOUCHER REMOTEID="${xmlEscape(`KIN-ORD-${o.id}`)}" VCHTYPE="Sales Order" ACTION="Create">
            <DATE>${date}</DATE>
            <NARRATION>Order ${xmlEscape(o.order_no)}${o.notes ? ` · ${xmlEscape(o.notes)}` : ''}</NARRATION>
            <VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(o.order_no)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>
            <REFERENCE>${xmlEscape(o.order_no)}</REFERENCE>
            <ISINVOICE>No</ISINVOICE>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(party)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amt(lines.total)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
${lines.xml}
          </VOUCHER>`;
  return envelope(company, voucher);
}

// ── Render: dealer → Sundry Debtor ledger (Create for new, Alter for an edit) ──────────────────
export async function renderMasterLedger(integration: IntegrationRow, distributor_id: string, action: 'Create' | 'Alter' = 'Create'): Promise<string> {
  const company = integration.config?.company_name ?? 'Default Company';
  const { data: d } = await supabaseAdmin.from('distributors')
    .select('name, legal_name, gstin, state_code, address, contact_mobile, email, credit_limit, payment_terms_days')
    .eq('id', distributor_id).maybeSingle();
  if (!d) throw new Error(`distributor ${distributor_id} not found`);
  // Same name the vouchers will use for this dealer, so invoices find the ledger we create.
  const ledgerName = await partyLedger(integration.id, distributor_id);
  return envelope(company, buildDistributorLedger(d as never, ledgerName, action), 'All Masters');
}

// ── Render: new product → stock item ──────────────────────────────────────────────────────────
export async function renderMasterStockItem(integration: IntegrationRow, sku_id: string): Promise<string> {
  const company = integration.config?.company_name ?? 'Default Company';
  const { data: k } = await supabaseAdmin.from('skus')
    .select('name, sku_code, category, unit, tally_stock_item_name').eq('id', sku_id).maybeSingle();
  if (!k) throw new Error(`sku ${sku_id} not found`);
  const itemName = ((k.tally_stock_item_name as string | null) || (k.name as string)).trim();
  return envelope(company, buildStockItem(k as never, itemName), 'All Masters');
}

// ── Dispatcher ────────────────────────────────────────────────────────────────────────────────
export async function renderTallyXml(
  integration: IntegrationRow,
  kind: EventKind,
  ref_id: string,
): Promise<string> {
  if (kind === 'invoice')  return renderInvoice(integration, ref_id);
  if (kind === 'payment')  return renderPayment(integration, ref_id);
  if (kind === 'return' || kind === 'credit_note') return renderReturn(integration, ref_id);
  if (kind === 'order')              return renderOrder(integration, ref_id);
  if (kind === 'master_ledger')         return renderMasterLedger(integration, ref_id, 'Create');
  if (kind === 'master_ledger_update')  return renderMasterLedger(integration, ref_id, 'Alter');
  if (kind === 'master_stock_item')  return renderMasterStockItem(integration, ref_id);
  throw new Error(`Unsupported Tally event kind: ${kind}`);
}
