'use strict';
const { clean, blocks, child, xmlEscape, decode } = require('./xml');

/** POST raw XML to Tally and return the text body. Throws a friendly Error when Tally is unreachable. */
async function tallyPost(tallyUrl, xml, timeoutMs = 60000) {
  let res;
  try {
    res = await fetch(tallyUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const code = e.cause && e.cause.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      throw new Error('Cannot connect to Tally. Open Tally and enable F1 > Settings > Connectivity > Client/Server ("TallyPrime acts as" = Both, port 9000).');
    }
    throw new Error(`Tally connection failed: ${e.message}`);
  }
  const body = clean(await res.text());
  if (!res.ok) throw new Error(`Tally HTTP ${res.status}: ${body.slice(0, 300)}`);
  return body;
}

function collectionRequest({ id, type, fetch: fields, company }) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${company ? `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fields.join(',')}</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

const nameOf = b => b.attrs.NAME || child(b.inner, 'NAME') || '';

async function listCompanies(url) {
  const xml = await tallyPost(url, collectionRequest({ id: 'KinCompanies', type: 'Company', fetch: ['Name'] }));
  return blocks(xml, 'COMPANY').map(nameOf).filter(Boolean);
}

async function listLedgers(url, company) {
  const xml = await tallyPost(url, collectionRequest({ id: 'KinLedgers', type: 'Ledger', company,
    fetch: ['Name', 'Parent', 'GUID', 'MailingName', 'Address', 'LedStateName', 'PinCode', 'PartyGSTIN', 'Email', 'LedgerPhone', 'LedgerMobile', 'LedgerContact', 'CreditLimit', 'BillCreditPeriod'] }));
  return blocks(xml, 'LEDGER').map(b => {
    const addr = blocks(b.inner, 'ADDRESS').map(a => decode(a.inner).trim()).filter(Boolean);
    return {
      name: nameOf(b), parent: child(b.inner, 'PARENT'), tally_guid: child(b.inner, 'GUID'),
      gstin: child(b.inner, 'PARTYGSTIN'), state: child(b.inner, 'LEDSTATENAME'), pincode: child(b.inner, 'PINCODE'),
      email: child(b.inner, 'EMAIL'), phone: child(b.inner, 'LEDGERMOBILE') || child(b.inner, 'LEDGERPHONE'),
      contact: child(b.inner, 'LEDGERCONTACT'), address: addr.join(', '),
      credit_limit: parseAmount(child(b.inner, 'CREDITLIMIT')),
      credit_period_days: parseInt(child(b.inner, 'BILLCREDITPERIOD'), 10) || 0,
    };
  }).filter(l => l.name);
}

async function listGroups(url, company) {
  const xml = await tallyPost(url, collectionRequest({ id: 'KinGroups', type: 'Group', company, fetch: ['Name', 'Parent'] }));
  return blocks(xml, 'GROUP').map(b => ({ name: nameOf(b), parent: child(b.inner, 'PARENT') })).filter(g => g.name);
}

async function listVoucherTypes(url, company) {
  const xml = await tallyPost(url, collectionRequest({ id: 'KinVT', type: 'VoucherType', company, fetch: ['Name'] }));
  return blocks(xml, 'VOUCHERTYPE').map(nameOf).filter(Boolean);
}

async function listStockItems(url, company) {
  const xml = await tallyPost(url, collectionRequest({ id: 'KinItems', type: 'StockItem', company,
    fetch: ['Name', 'GUID', 'Parent', 'Category', 'BaseUnits', 'PartNumber', 'HSNDetails', 'GSTDetails'] }));
  return blocks(xml, 'STOCKITEM').map(b => {
    const rates = blocks(b.inner, 'RATEDETAILS.LIST').map(r => ({ head: child(r.inner, 'GSTRATEDUTYHEAD'), rate: parseFloat(child(r.inner, 'GSTRATE')) || 0 }));
    const igst = rates.find(r => /integrated|igst/i.test(r.head));
    const cgst = rates.find(r => /central|cgst/i.test(r.head));
    return {
      name: nameOf(b), tally_guid: child(b.inner, 'GUID'), category: child(b.inner, 'CATEGORY'),
      stock_group: child(b.inner, 'PARENT'), unit: child(b.inner, 'BASEUNITS'), part_number: child(b.inner, 'PARTNUMBER'),
      hsn_code: child(b.inner, 'HSNCODE') || child(b.inner, 'HSN'),
      gst_rate: igst ? igst.rate : cgst ? cgst.rate * 2 : 0,
    };
  }).filter(i => i.name);
}

function parseAmount(s) {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** Ledgers whose parent chain reaches "Sundry Debtors" (customers / dealers / distributors). */
function partiesFrom(ledgers, groups) {
  const parentOf = new Map(groups.map(g => [g.name.toLowerCase(), (g.parent || '').toLowerCase()]));
  const isDebtor = g => {
    for (let cur = (g || '').toLowerCase(), i = 0; cur && i < 20; cur = parentOf.get(cur), i++) {
      if (cur === 'sundry debtors') return true;
    }
    return false;
  };
  return ledgers.filter(l => l.tally_guid && isDebtor(l.parent));
}

/** Parse a Tally import response. */
function parseImportResponse(xml) {
  const tag = n => { const m = new RegExp(`<${n}>([^<]*)</${n}>`, 'i').exec(xml); return m ? m[1].trim() : null; };
  const created = parseInt(tag('CREATED') || '0', 10);
  const altered = parseInt(tag('ALTERED') || '0', 10);
  const errors = parseInt(tag('ERRORS') || '0', 10);
  const lineError = tag('LINEERROR') || tag('DESC');
  const lastVchId = tag('LASTVCHID');
  if (errors > 0 || ((created + altered) === 0 && lineError)) return { ok: false, error: lineError || 'Tally rejected the request' };
  if (created + altered < 1 && !lastVchId) return { ok: false, error: 'Tally accepted the request but created nothing' };
  return { ok: true, tally_voucher_id: lastVchId || undefined };
}

module.exports = { tallyPost, listCompanies, listLedgers, listGroups, listVoucherTypes, listStockItems, partiesFrom, parseImportResponse };
