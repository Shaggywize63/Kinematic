/**
 * Pure builders for the item-level parts of Tally XML: inventory lines on Sales /
 * Sales Order vouchers, and master create messages for dealers (ledgers) and
 * products (stock items). No I/O so they are unit-testable.
 */
import { xmlEscape, amt } from './tally.xml';

export interface LineItem {
  sku_id: string;
  qty: number | string;
  unit_price?: number | string;
  taxable_value?: number | string;
  is_free_good?: boolean | null;
  uom?: string | null;
}
export interface StockName { name: string; unit: string }

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Inventory lines for an item-invoice. Returns null (=> caller falls back to the
 * ledger-only voucher) unless EVERY line resolves to a pulled Tally stock item with a
 * known unit AND the lines add up to `expectedTaxable` (within 5 paise), because a
 * voucher whose lines don't match its ledger totals is rejected by Tally.
 */
export function buildInventoryLines(
  items: LineItem[],
  names: Map<string, StockName>,
  salesLedger: string,
  expectedTaxable: number,
  extraPerLine: (item: LineItem) => string = () => '',
): { xml: string; total: number } | null {
  if (!items || items.length === 0) return null;
  let total = 0;
  const parts: string[] = [];
  for (const it of items) {
    const sn = names.get(it.sku_id);
    const qty = Number(it.qty);
    if (!sn || !sn.unit || !(qty > 0)) return null;
    const taxable = it.is_free_good ? 0 : Number(it.taxable_value ?? 0);
    total += taxable;
    const rate = qty > 0 ? Math.round((taxable / qty) * 10000) / 10000 : 0;
    parts.push(`          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>${xmlEscape(sn.name)}</STOCKITEMNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <RATE>${rate}/${xmlEscape(sn.unit)}</RATE>
            <AMOUNT>${amt(taxable)}</AMOUNT>
            <ACTUALQTY> ${qty} ${xmlEscape(sn.unit)}</ACTUALQTY>
            <BILLEDQTY> ${qty} ${xmlEscape(sn.unit)}</BILLEDQTY>${extraPerLine(it)}
            <ACCOUNTINGALLOCATIONS.LIST>
              <LEDGERNAME>${xmlEscape(salesLedger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${amt(taxable)}</AMOUNT>
            </ACCOUNTINGALLOCATIONS.LIST>
          </ALLINVENTORYENTRIES.LIST>`);
  }
  total = round2(total);
  if (Math.abs(total - round2(Number(expectedTaxable))) > 0.05) return null;
  return { xml: parts.join('\n'), total };
}

/** Lists the lines that could not be resolved to a Tally stock item (for a helpful error). */
export function unresolvedLines(
  items: Array<LineItem & { sku_name?: string | null; sku_code?: string | null }>,
  names: Map<string, StockName>,
): string[] {
  return items.filter(i => !names.get(i.sku_id)?.unit).map(i => i.sku_name || i.sku_code || i.sku_id);
}

// GST state codes -> the state names Tally uses in LEDSTATENAME.
export const GST_STATE_NAMES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
  '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

export interface DistributorForTally {
  name: string; legal_name?: string | null; gstin?: string | null; state_code?: string | null;
  address?: Record<string, unknown> | null; contact_mobile?: string | null; email?: string | null;
  credit_limit?: number | string | null; payment_terms_days?: number | string | null;
}

/**
 * Ledger master (Sundry Debtors) for a Kinematic distributor. `ledgerName` is the
 * exact Tally name. `action` is 'Create' for a new dealer or 'Alter' to push an edit
 * to an existing ledger (same NAME → Tally matches and updates in place; the two-way
 * sync re-pushes as 'Alter' when a linked distributor is edited).
 */
export function buildDistributorLedger(d: DistributorForTally, ledgerName: string, action: 'Create' | 'Alter' = 'Create'): string {
  const gstin = (d.gstin || '').trim().toUpperCase();
  const state = d.state_code ? GST_STATE_NAMES[d.state_code] : undefined;
  const a = (d.address ?? {}) as Record<string, unknown>;
  const addrLines = [a.line1, a.city, a.pincode].map(x => String(x ?? '').trim()).filter(Boolean);
  const days = Number(d.payment_terms_days);
  const limit = Number(d.credit_limit);
  return `          <LEDGER NAME="${xmlEscape(ledgerName)}" ACTION="${action}">
            <NAME>${xmlEscape(ledgerName)}</NAME>
            <PARENT>Sundry Debtors</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <MAILINGNAME>${xmlEscape(d.legal_name || ledgerName)}</MAILINGNAME>${addrLines.length ? `
            <ADDRESS.LIST>${addrLines.map(l => `
              <ADDRESS>${xmlEscape(l)}</ADDRESS>`).join('')}
            </ADDRESS.LIST>` : ''}${state ? `
            <LEDSTATENAME>${xmlEscape(state)}</LEDSTATENAME>` : ''}${a.pincode ? `
            <PINCODE>${xmlEscape(a.pincode)}</PINCODE>` : ''}
            <GSTREGISTRATIONTYPE>${gstin ? 'Regular' : 'Unregistered'}</GSTREGISTRATIONTYPE>${gstin ? `
            <PARTYGSTIN>${xmlEscape(gstin)}</PARTYGSTIN>` : ''}${d.email ? `
            <EMAIL>${xmlEscape(d.email)}</EMAIL>` : ''}${d.contact_mobile ? `
            <LEDGERMOBILE>${xmlEscape(d.contact_mobile)}</LEDGERMOBILE>` : ''}${limit > 0 ? `
            <CREDITLIMIT>${amt(limit)}</CREDITLIMIT>` : ''}${days > 0 ? `
            <BILLCREDITPERIOD>${Math.floor(days)} Days</BILLCREDITPERIOD>` : ''}
          </LEDGER>`;
}

/** No PARENT stock group is set on purpose: a group that doesn't exist in Tally would fail the whole import. */
export interface SkuForTally { name: string; sku_code?: string | null; category?: string | null; unit?: string | null }

/** Unit + stock item masters for a Kinematic product. Both are "Create"; an existing unit/item is reported as an error by Tally, not overwritten. */
export function buildStockItem(s: SkuForTally, itemName: string): string {
  const unit = (s.unit || 'Nos').trim();
  return `          <UNIT NAME="${xmlEscape(unit)}" ACTION="Create">
            <NAME>${xmlEscape(unit)}</NAME>
            <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
          </UNIT>
          <STOCKITEM NAME="${xmlEscape(itemName)}" ACTION="Create">
            <NAME>${xmlEscape(itemName)}</NAME>${s.sku_code ? `
            <PARTNUMBER>${xmlEscape(s.sku_code)}</PARTNUMBER>` : ''}
            <BASEUNITS>${xmlEscape(unit)}</BASEUNITS>
          </STOCKITEM>`;
}
