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
 * v1 scope:
 *   • Sales Voucher  (invoices)        — with GST splits as separate ledger entries
 *   • Receipt Voucher (payments)        — with bill allocations against the original invoice
 *   • Credit Note    (returns)         — sales-return debit + party credit
 *
 * Deferred to v2:
 *   • Inventory entries (STOCKITEMNAME / ACTUALQTY)
 *   • Master sync (distributors as ledger masters, SKUs as stock items)
 *   • Multi-currency / multi-company
 */
import { supabaseAdmin } from '../../../lib/supabase';

export type EventKind = 'invoice' | 'payment' | 'return' | 'credit_note';

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
}

interface IntegrationRow {
  id: string;
  org_id: string;
  config: TallyIntegrationConfig;
}

// ── String helpers ────────────────────────────────────────────────────────────────────────
const xmlEscape = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Tally prefers YYYYMMDD date strings (no separators). */
const tallyDate = (iso: string | Date | null | undefined): string => {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

/** Tally amount format: 2 decimals, no thousand separators. */
const amt = (n: unknown): string => Number(n ?? 0).toFixed(2);

// ── Ledger-name resolution ─────────────────────────────────────────────────────────────

/**
 * Look up the Tally ledger name for a distributor. Priority:
 *   1. distribution_external_party_map.external_name (admin override)
 *   2. distributors.tally_ledger_name (admin override on distributor row)
 *   3. distributors.legal_name (sensible default)
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
function defaults(cfg: TallyIntegrationConfig) {
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

// ── Envelope ────────────────────────────────────────────────────────────────────────────────────
function envelope(companyName: string, innerVoucherXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
${innerVoucherXml}
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
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
  const entries: string[] = [];

  // Party
  entries.push(`          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xmlEscape(party)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${amt(inv.grand_total)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`);

  // Sales
  if (Number(inv.taxable_value) > 0) {
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
            <REFERENCE>${xmlEscape(inv.invoice_no)}</REFERENCE>
${entries.join('\n')}
          </VOUCHER>`;

  return envelope(company, voucher);
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
  // emit one BILLALLOCATIONS row per invoice. Otherwise leave the
  // party credit unallocated (On Account).
  const apps = (p.applied_to_invoices as Array<{ invoice_no?: string; amount?: number }> | null) ?? [];
  let billAllocations = '';
  if (apps.length > 0) {
    billAllocations = apps.map(a => `              <BILLALLOCATIONS.LIST>
                <NAME>${xmlEscape(a.invoice_no ?? '')}</NAME>
                <BILLTYPE>Agst Ref</BILLTYPE>
                <AMOUNT>${amt(a.amount)}</AMOUNT>
              </BILLALLOCATIONS.LIST>`).join('\n');
  } else {
    billAllocations = `              <BILLALLOCATIONS.LIST>
                <NAME>On Account</NAME>
                <BILLTYPE>On Account</BILLTYPE>
                <AMOUNT>${amt(p.amount)}</AMOUNT>
              </BILLALLOCATIONS.LIST>`;
  }

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

// ── Dispatcher ────────────────────────────────────────────────────────────────────────────────
export async function renderTallyXml(
  integration: IntegrationRow,
  kind: EventKind,
  ref_id: string,
): Promise<string> {
  if (kind === 'invoice')  return renderInvoice(integration, ref_id);
  if (kind === 'payment')  return renderPayment(integration, ref_id);
  if (kind === 'return' || kind === 'credit_note') return renderReturn(integration, ref_id);
  throw new Error(`Unsupported Tally event kind: ${kind}`);
}
