jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { actOnMasters } from '../src/controllers/distribution/tally-onboarding.controller';
import { pickPriceList, isCompanyScoped } from '../src/services/distribution/priceListPicker';
import { tallyPrice } from '../src/services/distribution/companyPriceList';

const supa = () => (global as any).__supa;
const INT = '55555555-5555-4555-8555-555555555555';
const ORG = '11111111-1111-4111-8111-111111111111';
const CO = '22222222-2222-4222-8222-222222222222';
const MASTER = '66666666-6666-4666-8666-666666666666';
const SKU = '77777777-7777-4777-8777-777777777777';
const PL = '88888888-8888-4888-8888-888888888888';

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
const inserts = (table: string) => supa().chainsFor(table).flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert').map((o: any) => o.args[0]));
beforeEach(() => supa().reset());

describe('tallyPrice', () => {
  it('prefers the selling rate, falls back to MRP, and never returns 0', () => {
    expect(tallyPrice({ rate: 120.456, mrp: 150 })).toBe(120.46);
    expect(tallyPrice({ rate: 0, mrp: '150' })).toBe(150);
    expect(tallyPrice({ rate: 'x' })).toBeNull();
    expect(tallyPrice({})).toBeNull();
  });
});

describe('importing Tally stock items through a connection pinned to a company', () => {
  const run = (config: any) => {
    supa().queue('distribution_integrations', { data: { id: INT, org_id: ORG, config }, error: null });
    supa().queue('distribution_tally_masters', { data: [{ id: MASTER, name: 'Royal Whisky 750ml', tally_guid: 'guid-abcdef12', status: 'new', data: { rate: 900, mrp: 1000, unit: 'BTL', gst_rate: 28 } }], error: null });
    supa().queue('skus', { data: { id: SKU }, error: null });
    return call(actOnMasters, { user: { id: 'u', org_id: ORG, role: 'admin', client_id: null }, params: { id: INT }, body: { kind: 'stock_item', action: 'import', all_new: true } });
  };

  it('creates the product under that company and adds it to the company price list at the Tally rate', async () => {
    supa().queue('price_lists', { data: { id: PL }, error: null });          // the company already has a list
    const r = await run({ client_id: CO });
    expect(r.body.data.created).toBe(1);
    expect(inserts('skus')[0].client_id).toBe(CO);
    expect(inserts('price_list_items')).toEqual([{ price_list_id: PL, sku_id: SKU, base_price: 900 }]);
  });

  it('creates the company price list on first import', async () => {
    supa().queue('price_lists', { data: null, error: null });                 // none yet
    supa().queue('clients', { data: { name: 'Royal Spirits North' }, error: null });
    supa().queue('price_lists', { data: { id: PL }, error: null });          // insert ... select
    await run({ client_id: CO });
    const list = inserts('price_lists')[0];
    expect(list).toMatchObject({ org_id: ORG, client_id: CO, customer_class: 'co-22222222', name: 'Royal Spirits North price list' });
    expect(inserts('price_list_items')[0].price_list_id).toBe(PL);
  });

  it('an unpinned connection leaves price lists alone (existing behaviour)', async () => {
    await run({});
    expect(supa().chainsFor('price_lists')).toHaveLength(0);
    expect(inserts('price_list_items')).toHaveLength(0);
  });
});

describe('pickPriceList', () => {
  const base = { org_id: ORG, customer_class: 'GT', region: 'ALL', client_id: CO };
  it('is the old single lookup for anyone not on several companies', async () => {
    await pickPriceList(base);
    expect(supa().chainsFor('price_lists')).toHaveLength(1);
    expect(supa().chainsFor('price_lists')[0].eqs.customer_class).toBe('GT');
    expect(supa().chainsFor('price_lists')[0].eqs.client_id).toBeUndefined();
  });
  it('a multi-company rep gets the picked company\'s own list first', async () => {
    supa().queue('price_lists', { data: { id: PL }, error: null });
    const r = await pickPriceList({ ...base, company_scoped: true });
    expect(r.id).toBe(PL);
    expect(supa().chainsFor('price_lists')).toHaveLength(1);
    expect(supa().chainsFor('price_lists')[0].eqs.client_id).toBe(CO);
  });
  it('falls back only to org-wide lists, never another company\'s', async () => {
    supa().queue('price_lists', { data: null, error: null });
    await pickPriceList({ ...base, company_scoped: true });
    const second = supa().chainsFor('price_lists')[1];
    expect(second.ops.find((o: any) => o.method === 'is').args).toEqual(['client_id', null]);
  });
  it('isCompanyScoped needs more than one assigned company', () => {
    expect(isCompanyScoped({ company_client_ids: [CO] })).toBe(false);
    expect(isCompanyScoped({ company_client_ids: [CO, PL] })).toBe(true);
    expect(isCompanyScoped(undefined)).toBe(false);
  });
});
