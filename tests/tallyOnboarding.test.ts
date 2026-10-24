jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import {
  generatePairingCode, hashPairingCode, normalisePairingCode, computeHealth, missingLedgers,
  buildCreateLedgersXml, publicApiBase, sanitiseMaster, matchParty, matchStockItem, partyCode,
} from '../src/services/distribution/integrations/tally.onboarding';
import { agentPair, agentMasters } from '../src/controllers/distribution/tally-onboarding.controller';

const supa = () => (global as any).__supa;
const INT = '55555555-5555-4555-8555-555555555555';
const ORG = '11111111-1111-4111-8111-111111111111';

function call(handler: any, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    handler(req, res, reject);
  });
}

describe('pairing code', () => {
  it('is XXX-XXX from an unambiguous alphabet and hashes the same however it is typed', () => {
    const c = generatePairingCode();
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/);
    expect(hashPairingCode(c)).toBe(hashPairingCode(c.toLowerCase().replace('-', ' ')));
    expect(normalisePairingCode('k7f-29x')).toBe('K7F29X');
  });
  it('agentPair rejects a malformed code without touching the database', async () => {
    const r = await call(agentPair, { body: { code: 'abc' } });
    expect(r.status).toBe(400);
    expect(supa().chains).toHaveLength(0);
  });
  it('agentPair consumes the code with a clear-and-return update and hands back the config', async () => {
    supa().reset();
    supa().queue('distribution_integrations', { data: { id: INT, agent_secret: 'sek', config: { company_name: 'Gomant' } }, error: null });
    const r = await call(agentPair, { body: { code: 'K7F-29X' } });
    expect(r.status).toBe(200);
    expect(r.body.config.integration_id).toBe(INT);
    expect(r.body.config.polling_endpoint).toContain('key=sek');
    const ch = supa().chainsFor('distribution_integrations')[0];
    const upd = ch.ops.find((o: any) => o.method === 'update');
    expect(upd.args[0]).toEqual({ pairing_code_hash: null, pairing_expires_at: null });
    expect(ch.eqs.pairing_code_hash).toBe(hashPairingCode('K7F29X'));
  });
  it('agentPair 404s an unknown / expired / already-used code', async () => {
    supa().reset();
    supa().queue('distribution_integrations', { data: null, error: null });
    const r = await call(agentPair, { body: { code: 'K7F-29X' } });
    expect(r.status).toBe(404);
  });
});

describe('agent endpoints require the agent key', () => {
  it('masters with a wrong key is 403 and writes nothing', async () => {
    supa().reset();
    supa().queue('distribution_integrations', { data: { id: INT, org_id: ORG, provider: 'tally', agent_secret: 'right', config: {} }, error: null });
    const r = await call(agentMasters, { params: { id: INT }, query: { key: 'wrong' }, body: { kind: 'party', items: [] } });
    expect(r.status).toBe(403);
    expect(supa().chainsFor('distribution_tally_masters')).toHaveLength(0);
  });
});

describe('health checklist', () => {
  const cfg = { company_name: 'Gomant Traders' };
  const now = Date.parse('2026-10-16T10:00:00Z');
  const seen = '2026-10-16T09:59:00Z';
  const profile = {
    tally_reachable: true, companies: ['Gomant Traders'], voucher_types: ['Sales', 'Receipt', 'Credit Note'],
    ledgers: [{ name: 'Sales Account' }, { name: 'sales returns' }, { name: 'CGST' }, { name: 'SGST' }, { name: 'IGST' }, { name: 'Cash' }, { name: 'Bank' }, { name: 'Round Off' }],
  };
  it('is ready when everything is present (ledger names compare case-insensitively)', () => {
    const h = computeHealth({ agentSeenAt: seen, profile, config: cfg, now });
    expect(h.ready).toBe(true);
  });
  it('flags a stale agent, an unreachable Tally and a wrong company', () => {
    expect(computeHealth({ agentSeenAt: null, profile: null, config: cfg, now }).checks[0].status).toBe('fail');
    const un = computeHealth({ agentSeenAt: seen, profile: { tally_reachable: false }, config: cfg, now });
    expect(un.ready).toBe(false);
    const wrong = computeHealth({ agentSeenAt: seen, profile, config: { company_name: 'Other' }, now });
    expect(wrong.checks.find(c => c.key === 'company')!.status).toBe('fail');
  });
  it('lists missing ledgers with a create fix, honouring configured names', () => {
    const p = { ...profile, ledgers: profile.ledgers.filter(l => l.name !== 'IGST') };
    const h = computeHealth({ agentSeenAt: seen, profile: p, config: cfg, now });
    const l = h.checks.find(c => c.key === 'ledgers')!;
    expect(l.status).toBe('fail'); expect(l.fix).toBe('create_ledgers'); expect(l.detail).toContain('IGST');
    expect(missingLedgers({ ...cfg, sales_ledger_name: 'Gomant Sales' }, profile).map(m => m.name)).toEqual(['Gomant Sales']);
  });
  it('escapes ledger names in the create XML', () => {
    const xml = buildCreateLedgersXml('A & B', [{ key: 'x', name: 'Tax "<5%>"', parent: 'Duties & Taxes', gstHead: 'Central Tax' }]);
    expect(xml).toContain('A &amp; B');
    expect(xml).toContain('Tax &quot;&lt;5%&gt;&quot;');
    expect(xml).toContain('<GSTDUTYHEAD>Central Tax</GSTDUTYHEAD>');
  });
});

describe('publicApiBase', () => {
  const old = process.env.API_PUBLIC_URL;
  afterEach(() => { if (old === undefined) delete process.env.API_PUBLIC_URL; else process.env.API_PUBLIC_URL = old; });
  it('is always absolute: env (trailing slash stripped) or the production API', () => {
    delete process.env.API_PUBLIC_URL;
    expect(publicApiBase()).toBe('https://api.kinematicapp.com');
    process.env.API_PUBLIC_URL = 'https://api.example.com//';
    expect(publicApiBase()).toBe('https://api.example.com');
  });
  it('agentPair hands the connector absolute endpoints even with API_PUBLIC_URL unset', async () => {
    delete process.env.API_PUBLIC_URL;
    supa().reset();
    supa().queue('distribution_integrations', { data: { id: INT, agent_secret: 'sek', config: {} }, error: null });
    const r = await call(agentPair, { body: { code: 'K7F-29X' } });
    expect(r.body.config.polling_endpoint).toMatch(/^https:\/\/api\.kinematicapp\.com\/api\/v1\/integrations\/tally\/jobs\//);
    expect(r.body.config.report_endpoint).toMatch(/^https:\/\//);
  });
});

describe('masters', () => {
  it('sanitiseMaster keeps scalars only and requires guid + name', () => {
    expect(sanitiseMaster({ name: 'x' })).toBeNull();
    const m = sanitiseMaster({ tally_guid: 'g', name: ' Cement ', gst_rate: 18, junk: { a: 1 }, arr: [1] })!;
    expect(m).toEqual({ tally_guid: 'g', name: 'Cement', gst_rate: 18 });
  });
  const dists = [
    { id: 'd1', name: 'Sharma Traders', legal_name: 'Sharma Traders Pvt Ltd', gstin: '27ABCDE1234F1Z5' },
    { id: 'd2', name: 'Verma & Sons', gstin: null },
    { id: 'd3', name: 'Verma & Sons' },
  ];
  it('matches a party by GSTIN first, then by an unambiguous name only', () => {
    expect(matchParty({ name: 'Anything', gstin: '27abcde1234f1z5' }, dists)).toEqual({ id: 'd1', method: 'gstin' });
    expect(matchParty({ name: 'SHARMA TRADERS PVT. LTD.' }, dists)).toEqual({ id: 'd1', method: 'name' });
    expect(matchParty({ name: 'Verma & Sons' }, dists)).toBeNull();           // ambiguous -> never guess
    expect(matchParty({ name: 'Nobody' }, dists)).toBeNull();
  });
  it('matches stock items by part number, then name', () => {
    const skus = [{ id: 's1', name: 'TMT Bar 12mm', sku_code: 'TMT12' }, { id: 's2', name: 'Cement OPC', sku_code: null }];
    expect(matchStockItem({ name: 'x', part_number: 'tmt12' }, skus)?.id).toBe('s1');
    expect(matchStockItem({ name: 'cement  opc' }, skus)?.id).toBe('s2');
  });
  it('partyCode is stable and fits the 32-char column', () => {
    expect(partyCode('abc')).toBe(partyCode('abc'));
    expect(partyCode('abc').length).toBeLessThanOrEqual(32);
  });
});
