/**
 * Service-layer tests for the real lead-listing business logic.
 *
 * Unlike the demo-token HTTP E2E (which serves canned fixtures), these drive
 * `leads.service.listLeadsWithCount` — the query CLAUDE.md repeatedly warns
 * about — against a chainable Supabase double, asserting the *exact* PostgREST
 * query the service builds: strict vs. shared client scoping, the combined
 * city / owner / hierarchy visibility OR, the `ownOnly` short-circuit, the
 * null-city rule, every column filter, search, sort, and pagination.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as leads from '../src/services/crm/leads.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const SELF = '22222222-2222-2222-2222-222222222222';

const leadsChain = () => __mock.chainsFor('crm_leads')[0];
const orExpr = () => leadsChain().ors[0] ?? '';

beforeEach(() => __mock.reset());

describe('listLeadsWithCount — tenant scoping', () => {
  it('hard-filters client_id under strictClient (real tenant isolation)', async () => {
    __mock.setDefault('crm_leads', { data: [{ id: 'l1' }], count: 1 });
    const { rows, total } = await leads.listLeadsWithCount(ORG, {}, CLIENT, { strictClient: true });
    expect(rows).toHaveLength(1);
    expect(total).toBe(1);
    const c = leadsChain();
    expect(c.eqs.org_id).toBe(ORG);
    expect(c.eqs.client_id).toBe(CLIENT);
    expect(c.ors.some((o) => o.includes('client_id.is.null'))).toBe(false);
    expect(c.ops.some((o) => o.method === 'is' && o.args[0] === 'deleted_at')).toBe(true);
  });

  it('uses shared OR-null client semantics when not strict', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, {}, CLIENT, { strictClient: false });
    expect(leadsChain().ors).toContain(`client_id.is.null,client_id.eq.${CLIENT}`);
  });
});

describe('listLeadsWithCount — visibility scope', () => {
  it('builds a city IN-list (quoted) OR self-owner OR null-city for an admin', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, {}, CLIENT, {
      strictClient: true,
      effectiveCities: ['Pune', 'Vasco da Gama'],
      selfOwnerId: SELF,
      includeNullCity: true,
    });
    const or = orExpr();
    expect(or).toContain('city.in.("Pune","Vasco da Gama")');
    expect(or).toContain(`owner_id.eq.${SELF}`);
    expect(or).toContain('city.is.null'); // admin sees city-less leads
  });

  it('ORs the hierarchy owner subtree and does NOT leak null-city leads under hierarchy', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, {}, CLIENT, {
      strictClient: true,
      effectiveCities: ['Pune'],
      visibleOwnerIds: ['u1', 'u2'],
      selfOwnerId: SELF,
      includeNullCity: true, // must be suppressed because an owner scope is present
    });
    const or = orExpr();
    expect(or).toContain('owner_id.in.(u1,u2)');
    expect(or).toContain('city.in.("Pune")');
    expect(or).not.toContain('city.is.null');
  });

  it('ownOnly restricts to owned/subtree leads only — city allocation does not broaden', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, {}, CLIENT, {
      strictClient: true,
      effectiveCities: ['Pune'], // must be ignored under ownOnly
      selfOwnerId: SELF,
      ownOnly: true,
    });
    const or = orExpr();
    expect(or).toContain(`owner_id.eq.${SELF}`);
    expect(or).not.toContain('city.in.');
    expect(or).not.toContain('city.is.null');
  });

  it('a fresh ownOnly user with no owned leads gets an empty page (no query issued)', async () => {
    const res = await leads.listLeadsWithCount(ORG, {}, CLIENT, {
      strictClient: true, ownOnly: true, selfOwnerId: null, visibleOwnerIds: [],
    });
    expect(res).toEqual({ rows: [], total: 0, page: 1, limit: 50 });
    expect(leadsChain()?.ops.some((o) => o.method === 'range')).toBeFalsy();
  });

  it('an empty city scope with nothing else to OR yields an empty page', async () => {
    const res = await leads.listLeadsWithCount(ORG, {}, CLIENT, {
      strictClient: true, effectiveCities: [], includeNullCity: false,
    });
    expect(res.total).toBe(0);
    expect(res.rows).toEqual([]);
  });
});

describe('listLeadsWithCount — column filters', () => {
  it('applies status / owner / source / geo filters as .eq()', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, {
      status: 'working', owner_id: SELF, source_id: 'src-1',
      state: 'Maharashtra', city: 'Pune', district: 'Pune', block: 'Haveli',
      score_grade: 'A',
    }, null, {});
    const c = leadsChain();
    expect(c.eqs.status).toBe('working');
    expect(c.eqs.owner_id).toBe(SELF);
    expect(c.eqs.source_id).toBe('src-1');
    expect(c.eqs.state).toBe('Maharashtra');
    expect(c.eqs.city).toBe('Pune');
    expect(c.eqs.block).toBe('Haveli');
    expect(c.eqs.score_grade).toBe('A');
  });

  it('applies score_gte as a >= filter', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, { score_gte: '70' }, null, {});
    const gte = leadsChain().ops.find((o) => o.method === 'gte' && o.args[0] === 'score');
    expect(gte?.args[1]).toBe(70);
  });

  it('coerces is_converted to a boolean .eq()', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, { is_converted: 'false' }, null, {});
    expect(leadsChain().eqs.is_converted).toBe(false);
    __mock.reset();
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, { is_converted: 'true' }, null, {});
    expect(leadsChain().eqs.is_converted).toBe(true);
  });

  it('runs a sanitised ilike search across name / company / email / phone', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, { q: 'acme' }, null, {});
    const or = leadsChain().ors.find((o) => o.includes('ilike'));
    expect(or).toContain('first_name.ilike.%acme%');
    expect(or).toContain('company.ilike.%acme%');
    expect(or).toContain('email.ilike.%acme%');
    expect(or).toContain('phone.ilike.%acme%');
  });

  it('applies created_at date bounds', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, { from: '2026-01-01', to: '2026-02-01' }, null, {});
    const c = leadsChain();
    expect(c.ops.some((o) => o.method === 'gte' && o.args[0] === 'created_at' && o.args[1] === '2026-01-01')).toBe(true);
    expect(c.ops.some((o) => o.method === 'lte' && o.args[0] === 'created_at' && o.args[1] === '2026-02-01')).toBe(true);
  });
});

describe('listLeadsWithCount — sort & pagination', () => {
  it('maps sort=name to first_name then last_name (whitelisted)', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, { sort: 'name', order: 'asc' }, null, {});
    const orders = leadsChain().ops.filter((o) => o.method === 'order').map((o) => o.args[0]);
    expect(orders[0]).toBe('first_name');
    expect(orders[1]).toBe('last_name');
  });

  it('defaults to latest_update_at-first when no sort is given', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, {}, null, {});
    const firstOrder = leadsChain().ops.find((o) => o.method === 'order');
    expect(firstOrder?.args[0]).toBe('latest_update_at');
  });

  it('ignores a non-whitelisted sort key and uses the default order', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 0 });
    await leads.listLeadsWithCount(ORG, { sort: 'drop table' }, null, {});
    const firstOrder = leadsChain().ops.find((o) => o.method === 'order');
    expect(firstOrder?.args[0]).toBe('latest_update_at');
  });

  it('clamps limit to 200 and applies range() for the page', async () => {
    __mock.setDefault('crm_leads', { data: [], count: 500 });
    const { total, limit } = await leads.listLeadsWithCount(ORG, { limit: '9999', page: '2' }, null, {});
    expect(limit).toBe(200);
    expect(total).toBe(500);
    const range = leadsChain().ops.find((o) => o.method === 'range');
    expect(range?.args).toEqual([200, 399]);
  });

  it('propagates a DB error as AppError(500, DB_ERROR)', async () => {
    __mock.setDefault('crm_leads', { error: { message: 'boom' } });
    await expect(leads.listLeadsWithCount(ORG, {}, null, {})).rejects.toMatchObject({ statusCode: 500, code: 'DB_ERROR' });
  });
});

describe('listStuckLeads', () => {
  it('filters open statuses past the stage-age cutoff, scoped to the client', async () => {
    __mock.setDefault('crm_leads', { data: [{ id: 'stuck-1' }] });
    const rows = await leads.listStuckLeads(ORG, 7, CLIENT, { strictClient: true });
    expect(rows).toHaveLength(1);
    const c = leadsChain();
    expect(c.eqs.org_id).toBe(ORG);
    expect(c.eqs.client_id).toBe(CLIENT);
    const inOp = c.ops.find((o) => o.method === 'in' && o.args[0] === 'status');
    expect(inOp?.args[1]).toEqual(['new', 'working', 'nurturing', 'qualified']);
    expect(c.ops.some((o) => o.method === 'lt' && o.args[0] === 'stage_changed_at')).toBe(true);
  });
});
