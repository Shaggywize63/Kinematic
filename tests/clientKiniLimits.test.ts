jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { parseKiniLimit, readKiniLimits, writeKiniLimits } from '../src/controllers/client.controller';

const supa = () => (global as any).__supa;
const A = { id: 'client-a', org_id: 'org-a' };
const B = { id: 'client-b', org_id: 'org-b' };
const opNames = (c: { ops: Array<{ method: string }> }) => c.ops.map((o) => o.method);

beforeEach(() => supa().reset());

describe('parseKiniLimit', () => {
  it('leaves an unsent field alone and clears a blank one', () => {
    expect(parseKiniLimit(undefined)).toBeUndefined();
    expect(parseKiniLimit(null)).toBeNull();
    expect(parseKiniLimit('')).toBeNull();
  });
  it('accepts whole numbers, as numbers or text, rounding down', () => {
    expect(parseKiniLimit(50)).toBe(50);
    expect(parseKiniLimit(' 120 ')).toBe(120);
    expect(parseKiniLimit(7.9)).toBe(7);
  });
  it('rejects zero, negatives and non-numbers instead of silently clearing the limit', () => {
    for (const bad of [0, -3, 'abc', '0', NaN, Infinity, {}]) expect(parseKiniLimit(bad)).toBe('invalid');
  });
  it('caps an absurd value', () => {
    expect(parseKiniLimit(99_999_999)).toBe(1_000_000);
  });
});

describe('writeKiniLimits', () => {
  it('replaces only the org-level row of each limit that was sent, on the client\'s own org', async () => {
    await writeKiniLimits(A, { user: 50, org: undefined });
    const chains = supa().chainsFor('org_settings');
    expect(chains).toHaveLength(2); // delete, then insert; the org-wide key is untouched
    expect(opNames(chains[0])).toContain('delete');
    expect(chains[0].eqs).toMatchObject({ org_id: 'org-a', key: 'kini_user_monthly_query_limit' });
    expect(chains[0].ops.find((o: any) => o.method === 'is')?.args).toEqual(['client_id', null]);
    expect(chains[1].ops.find((o: any) => o.method === 'insert')?.args[0]).toEqual({ org_id: 'org-a', key: 'kini_user_monthly_query_limit', value: 50 });
  });
  it('null removes the row and inserts nothing', async () => {
    await writeKiniLimits(A, { org: null });
    const chains = supa().chainsFor('org_settings');
    expect(chains).toHaveLength(1);
    expect(chains[0].eqs).toMatchObject({ org_id: 'org-a', key: 'kini_monthly_query_limit' });
  });
  it('writes nothing when neither limit was sent', async () => {
    await writeKiniLimits(A, {});
    expect(supa().chainsFor('org_settings')).toHaveLength(0);
  });
  it('surfaces a failed insert', async () => {
    supa().setDefault('org_settings', (c: any) => (c.ops.some((o: any) => o.method === 'insert') ? { error: { message: 'boom' } } : { data: [] }));
    await expect(writeKiniLimits(A, { user: 5 })).rejects.toThrow('boom');
  });
});

describe('readKiniLimits', () => {
  it('returns each client\'s limits and this month\'s org-wide usage', async () => {
    supa().setDefault('org_settings', { data: [
      { org_id: 'org-a', key: 'kini_user_monthly_query_limit', value: 40 },
      { org_id: 'org-a', key: 'kini_monthly_query_limit', value: 500 },
      { org_id: 'org-b', key: 'kini_user_monthly_query_limit', value: '25' },
    ] });
    supa().setDefault('kini_usage', { data: [
      { org_id: 'org-a', query_count: 10 }, { org_id: 'org-a', query_count: 7 }, { org_id: 'org-b', query_count: 3 },
    ] });
    const r = await readKiniLimits([A, B]);
    expect(r['client-a']).toEqual({ user: 40, org: 500, org_used: 17 });
    expect(r['client-b']).toEqual({ user: 25, org: null, org_used: 3 });
  });
  it('a client with nothing set shows no limits (the default applies) and zero usage', async () => {
    supa().setDefault('org_settings', { data: [] });
    supa().setDefault('kini_usage', { data: [] });
    expect((await readKiniLimits([A]))['client-a']).toEqual({ user: null, org: null, org_used: 0 });
  });
  it('only reads org-level rows and this month\'s usage', async () => {
    supa().setDefault('org_settings', { data: [] });
    supa().setDefault('kini_usage', { data: [] });
    await readKiniLimits([A]);
    expect(supa().chainsFor('org_settings')[0].ops.find((o: any) => o.method === 'is')?.args).toEqual(['client_id', null]);
    expect(supa().chainsFor('kini_usage')[0].eqs.month).toMatch(/^\d{4}-\d{2}$/);
  });
});
