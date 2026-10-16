'use strict';
// Runs the real agent code against a fake Tally (XML over HTTP) and a fake Kinematic API.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const A = require('../lib/agent');
const T = require('../lib/tally');
const { partiesFrom } = T;

const listen = (handler) => new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const body = (req) => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;

const FAKE_TALLY = {
  KinCompanies: '<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Gomant Traders &amp; Co" RESERVEDNAME=""><NAME>Gomant Traders &amp; Co</NAME></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>',
  KinGroups: '<ENVELOPE><COLLECTION><GROUP NAME="Sundry Debtors"><PARENT></PARENT></GROUP><GROUP NAME="Dealers"><PARENT>Sundry Debtors</PARENT></GROUP><GROUP NAME="Sales Accounts"><PARENT></PARENT></GROUP></COLLECTION></ENVELOPE>',
  KinLedgers: `<ENVELOPE><COLLECTION>
    <LEDGER NAME="Sharma Traders"><GUID>g-1</GUID><PARENT>Dealers</PARENT><PARTYGSTIN>27ABCDE1234F1Z5</PARTYGSTIN><LEDSTATENAME>Maharashtra</LEDSTATENAME><ADDRESS.LIST><ADDRESS>12 Market Rd</ADDRESS><ADDRESS>Pune</ADDRESS></ADDRESS.LIST><CREDITLIMIT>50000</CREDITLIMIT><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD></LEDGER>
    <LEDGER NAME="Sales Account"><GUID>g-2</GUID><PARENT>Sales Accounts</PARENT></LEDGER>
    <LEDGER NAME="Cash"><GUID>g-3</GUID><PARENT>Cash-in-Hand&#4;</PARENT></LEDGER></COLLECTION></ENVELOPE>`,
  KinVT: '<ENVELOPE><COLLECTION><VOUCHERTYPE NAME="Sales"/><VOUCHERTYPE NAME="Receipt"></VOUCHERTYPE></COLLECTION></ENVELOPE>',
  KinItems: `<ENVELOPE><COLLECTION><STOCKITEM NAME="TMT Bar 12mm"><GUID>s-1</GUID><BASEUNITS>Kgs</BASEUNITS><PARTNUMBER>TMT12</PARTNUMBER>
    <GSTDETAILS.LIST><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>9</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
    <HSNDETAILS.LIST><HSNCODE>7214</HSNCODE></HSNDETAILS.LIST></STOCKITEM></COLLECTION></ENVELOPE>`,
};

async function fakeTally(extra = {}) {
  const imports = [];
  const s = await listen(async (req, res) => {
    const b = await body(req);
    const id = /<ID>(\w+)<\/ID>/.exec(b);
    res.setHeader('Content-Type', 'text/xml');
    if (id) return res.end(FAKE_TALLY[id[1]]);
    imports.push(b);
    res.end(extra.importResponse || '<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS><LASTVCHID>77</LASTVCHID></RESPONSE>');
  });
  s.imports = imports;
  return s;
}

test('parses Tally collections: entities, control chars, nested lists', async () => {
  const tally = await fakeTally();
  const u = url(tally);
  assert.deepStrictEqual(await T.listCompanies(u), ['Gomant Traders & Co']);
  const ledgers = await T.listLedgers(u, 'x');
  assert.strictEqual(ledgers.length, 3);
  const sharma = ledgers[0];
  assert.deepStrictEqual([sharma.gstin, sharma.address, sharma.credit_limit, sharma.credit_period_days], ['27ABCDE1234F1Z5', '12 Market Rd, Pune', 50000, 30]);
  assert.strictEqual(ledgers[2].parent, 'Cash-in-Hand');                       // &#4; stripped
  const groups = await T.listGroups(u, 'x');
  assert.deepStrictEqual(partiesFrom(ledgers, groups).map(l => l.name), ['Sharma Traders']);   // via Dealers -> Sundry Debtors
  const [item] = await T.listStockItems(u, 'x');
  assert.deepStrictEqual([item.hsn_code, item.gst_rate, item.unit, item.part_number], ['7214', 18, 'Kgs', 'TMT12']);
  tally.close();
});

test('reports a friendly error when Tally is not running', async () => {
  const s = await listen(() => {}); const dead = url(s); s.close();
  const p = await A.collectProfile({ tally_url: dead }, null);
  assert.strictEqual(p.tally_reachable, false);
  assert.match(p.tally_error, /Client\/Server/);
});

test('cycle: sends profile, runs pull_masters + create-ledgers commands, runs jobs, reports results', async () => {
  const tally = await fakeTally();
  const seen = { profile: [], masters: [], cmdResults: [], results: [] };
  let polled = 0;
  const api = await listen(async (req, res) => {
    const b = await body(req);
    const path = new URL(req.url, 'http://x').pathname;
    const j = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'GET') {
      polled++;
      return j({ ok: true, company_name: 'Gomant Traders & Co',
        jobs: [{ event_id: 'e1', kind: 'invoice', ref_id: 'r1', xml_payload: '<ENVELOPE>voucher</ENVELOPE>' }],
        commands: [{ id: 'c1', type: 'pull_masters' }, { id: 'c2', type: 'tally_xml', label: 'create_ledgers', xml: '<ENVELOPE>ledgers</ENVELOPE>' }, { id: 'c3', type: 'future_thing' }] });
    }
    const parsed = JSON.parse(b);
    if (path.endsWith('/profile')) seen.profile.push(parsed);
    else if (path.endsWith('/masters')) seen.masters.push(parsed);
    else if (path.endsWith('/command-result')) seen.cmdResults.push(parsed);
    else if (path.endsWith('/result')) seen.results.push(parsed);
    j({ ok: true });
  });
  const cfg = { tally_url: url(tally), polling_endpoint: `${url(api)}/api/v1/integrations/tally/jobs/abc?key=k`, report_endpoint: `${url(api)}/api/v1/integrations/tally/jobs/abc/result?key=k` };
  const logs = [];
  const ctx = A.newContext(cfg, m => logs.push(m));

  await A.cycle(ctx);
  assert.ok(seen.profile.length >= 1);
  assert.strictEqual(seen.profile[0].tally_reachable, true);
  assert.strictEqual(seen.profile[0].current_company, 'Gomant Traders & Co');
  assert.ok(seen.profile[0].ledgers.some(l => l.name === 'Sales Account'));
  assert.strictEqual(seen.profile[0].party_count, 1);

  assert.deepStrictEqual(seen.masters.map(m => [m.kind, m.items.length, m.final]), [['stock_item', 1, false], ['party', 1, true]]);
  assert.strictEqual(seen.masters[1].items[0].gstin, '27ABCDE1234F1Z5');

  assert.deepStrictEqual(seen.cmdResults.map(r => [r.command_id, r.ok]), [['c1', true], ['c2', true], ['c3', false]]);
  assert.match(seen.cmdResults[2].error, /Unknown command/);
  assert.ok(tally.imports.some(x => x.includes('ledgers')));                    // create-ledgers XML reached Tally
  assert.deepStrictEqual(seen.results.map(r => [r.event_id, r.ok, r.tally_voucher_id]), [['e1', true, '77']]);

  // The same command id is never executed twice, even if the server re-sends it before the ack lands.
  const before = seen.cmdResults.length;
  await A.cycle(ctx);
  assert.strictEqual(seen.cmdResults.length, before);
  assert.strictEqual(polled, 2);
  tally.close(); api.close();
});

test('parseImportResponse surfaces Tally line errors', () => {
  assert.deepStrictEqual(T.parseImportResponse('<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger \'X\' does not exist</LINEERROR></RESPONSE>'),
    { ok: false, error: "Ledger 'X' does not exist" });
  assert.strictEqual(T.parseImportResponse('<RESPONSE><CREATED>1</CREATED><LASTVCHID>5</LASTVCHID></RESPONSE>').ok, true);
});

test('master pushes treat "already exists" as done; vouchers still fail on it', () => {
  const exists = "<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger 'Sharma' already exists!</LINEERROR></RESPONSE>";
  assert.strictEqual(T.parseImportResponse(exists, { tolerateExisting: true }).ok, true);
  assert.strictEqual(T.parseImportResponse(exists).ok, false);
  // unit already exists but the stock item itself was created: still success for masters
  const partial = "<RESPONSE><CREATED>1</CREATED><ERRORS>1</ERRORS><LINEERROR>Unit 'Kgs' already exists!</LINEERROR></RESPONSE>";
  assert.strictEqual(T.parseImportResponse(partial, { tolerateExisting: true }).ok, true);
  // a real master error is still an error
  const bad = "<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Group 'Foo' does not exist</LINEERROR></RESPONSE>";
  assert.strictEqual(T.parseImportResponse(bad, { tolerateExisting: true }).ok, false);
});
