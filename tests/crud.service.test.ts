/**
 * Data-access integration tests for the generic CRM CRUD helper.
 *
 * `crud.service.ts` is the single most load-bearing piece of the CRM backend:
 * every small resource (contacts, accounts, activities, notes, pipelines,
 * lookups) lists/reads/writes through it, and CLAUDE.md calls out its
 * query-building rules as a repeated source of bugs (org scoping, soft-delete,
 * strict vs. shared client scoping, the "apply any non-reserved key as .eq()"
 * behavior, empty owner-scope short-circuit). We drive the real helper against
 * a chainable Supabase double and assert on both the returned rows AND the
 * query the helper actually built.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

// Replace the single Supabase seam. crud.service imports `{ supabaseAdmin }`.
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as crud from '../src/services/crm/crud.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '11111111-1111-1111-1111-111111111111';

beforeEach(() => __mock.reset());

describe('crud.list', () => {
  it('scopes by org_id and excludes soft-deleted rows by default', async () => {
    __mock.setDefault('crm_notes', { data: [{ id: 'n1' }, { id: 'n2' }] });
    const rows = await crud.list('crm_notes', ORG);
    expect(rows).toHaveLength(2);

    const chain = __mock.chainsFor('crm_notes')[0];
    expect(chain.eqs.org_id).toBe(ORG);
    // deleted_at IS NULL applied
    expect(chain.ops.some((o) => o.method === 'is' && o.args[0] === 'deleted_at' && o.args[1] === null)).toBe(true);
  });

  it('does not apply the soft-delete filter when softDelete:false', async () => {
    __mock.setDefault('crm_states', { data: [] });
    await crud.list('crm_states', ORG, {}, { softDelete: false });
    const chain = __mock.chainsFor('crm_states')[0];
    expect(chain.ops.some((o) => o.method === 'is' && o.args[0] === 'deleted_at')).toBe(false);
  });

  it('applies any non-reserved query key as an .eq() filter', async () => {
    __mock.setDefault('crm_activities', { data: [] });
    await crud.list('crm_activities', ORG, { type: 'call', status: 'completed', limit: '10', page: '2' });
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain.eqs.type).toBe('call');
    expect(chain.eqs.status).toBe('completed');
    // Reserved keys never become .eq() filters.
    expect(chain.eqs.limit).toBeUndefined();
    expect(chain.eqs.page).toBeUndefined();
  });

  it('treats client_id in the query string as "shared OR own" (.or with is.null)', async () => {
    __mock.setDefault('crm_lead_sources', { data: [] });
    await crud.list('crm_lead_sources', ORG, { client_id: CLIENT });
    const chain = __mock.chainsFor('crm_lead_sources')[0];
    expect(chain.ors.some((o) => o === `client_id.is.null,client_id.eq.${CLIENT}`)).toBe(true);
    // client_id must NOT also be applied as a plain .eq()
    expect(chain.eqs.client_id).toBeUndefined();
  });

  it('short-circuits to [] when visibleOwnerIds is an empty array (query never finalized)', async () => {
    const rows = await crud.list('crm_activities', ORG, {}, { visibleOwnerIds: [] });
    expect(rows).toEqual([]);
    // It bails out before pagination — no range() is ever applied.
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain?.ops.some((o) => o.method === 'range')).toBeFalsy();
  });

  it('builds an owner OR-filter across the configured owner columns', async () => {
    __mock.setDefault('crm_activities', { data: [] });
    await crud.list('crm_activities', ORG, {}, {
      visibleOwnerIds: ['u1', 'u2'],
      ownerColumns: ['owner_id', 'assigned_to'],
    });
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain.ors).toContain('owner_id.in.(u1,u2),assigned_to.in.(u1,u2)');
  });

  it('clamps limit to a maximum of 200 and applies range() pagination', async () => {
    __mock.setDefault('crm_notes', { data: [] });
    await crud.list('crm_notes', ORG, { limit: '9999', page: '3' });
    const chain = __mock.chainsFor('crm_notes')[0];
    const range = chain.ops.find((o) => o.method === 'range');
    // page 3, limit clamped to 200 -> range(400, 599)
    expect(range?.args).toEqual([400, 599]);
  });

  it('throws AppError(500, DB_ERROR) when the driver returns an error', async () => {
    __mock.setDefault('crm_notes', { error: { message: 'boom' } });
    await expect(crud.list('crm_notes', ORG)).rejects.toMatchObject({ statusCode: 500, code: 'DB_ERROR' });
  });
});

describe('crud.clientScopedListWithCount', () => {
  it('hard-filters by client_id when strictClient is set', async () => {
    __mock.setDefault('crm_leads', { data: [{ id: 'l1' }], count: 1 });
    const { rows, total } = await crud.clientScopedListWithCount('crm_leads', ORG, CLIENT, {}, { strictClient: true });
    expect(rows).toHaveLength(1);
    expect(total).toBe(1);
    const chain = __mock.chainsFor('crm_leads')[0];
    expect(chain.eqs.client_id).toBe(CLIENT);
    // strict never falls through to the is.null OR
    expect(chain.ors.some((o) => o.includes('client_id.is.null'))).toBe(false);
  });

  it('uses shared OR-null semantics when strictClient is false', async () => {
    __mock.setDefault('crm_states', { data: [], count: 0 });
    await crud.clientScopedListWithCount('crm_states', ORG, CLIENT, {}, { strictClient: false });
    const chain = __mock.chainsFor('crm_states')[0];
    expect(chain.ors).toContain(`client_id.is.null,client_id.eq.${CLIENT}`);
  });

  it('returns the exact count from the driver for pagination', async () => {
    __mock.setDefault('crm_leads', { data: [{ id: 'l1' }], count: 137 });
    const { total, page, limit } = await crud.clientScopedListWithCount('crm_leads', ORG, CLIENT, { page: '2', limit: '25' }, { strictClient: true });
    expect(total).toBe(137);
    expect(page).toBe(2);
    expect(limit).toBe(25);
  });

  it('short-circuits with total 0 when visibleOwnerIds is empty', async () => {
    const res = await crud.clientScopedListWithCount('crm_leads', ORG, CLIENT, {}, { strictClient: true, visibleOwnerIds: [] });
    expect(res).toEqual({ rows: [], total: 0, page: 1, limit: 50 });
    // Bails before pagination — no range() finalization.
    const chain = __mock.chainsFor('crm_leads')[0];
    expect(chain?.ops.some((o) => o.method === 'range')).toBeFalsy();
  });
});

describe('crud.get', () => {
  it('requires org_id + id and returns the single row', async () => {
    __mock.setDefault('crm_contacts', { data: [{ id: 'c1', org_id: ORG }] });
    const row = await crud.get('crm_contacts', ORG, 'c1');
    expect(row).toMatchObject({ id: 'c1' });
    const chain = __mock.chainsFor('crm_contacts')[0];
    expect(chain.eqs.org_id).toBe(ORG);
    expect(chain.eqs.id).toBe('c1');
    expect(chain.single).toBe(true);
  });

  it('adds the client-scope OR guard when a client_id is supplied', async () => {
    __mock.setDefault('crm_contacts', { data: [{ id: 'c1' }] });
    await crud.get('crm_contacts', ORG, 'c1', true, CLIENT);
    const chain = __mock.chainsFor('crm_contacts')[0];
    expect(chain.ors).toContain(`client_id.is.null,client_id.eq.${CLIENT}`);
  });

  it('throws AppError(404, NOT_FOUND) when the row is missing', async () => {
    __mock.setDefault('crm_contacts', { data: [] }); // .single() -> no rows -> error
    await expect(crud.get('crm_contacts', ORG, 'missing')).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('crud.create', () => {
  it('stamps org_id and created_by, returns the inserted row', async () => {
    __mock.setDefault('crm_contacts', { data: [{ id: 'new', org_id: ORG, created_by: 'user-1' }] });
    const row = await crud.create('crm_contacts', ORG, { first_name: 'A' }, 'user-1');
    expect(row).toMatchObject({ id: 'new' });
    const chain = __mock.chainsFor('crm_contacts')[0];
    const insert = chain.ops.find((o) => o.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ first_name: 'A', org_id: ORG, created_by: 'user-1' });
  });

  it('does NOT stamp created_by on audit-light lookup tables', async () => {
    __mock.setDefault('crm_settings', { data: [{ id: 's1' }] });
    await crud.create('crm_settings', ORG, { config: {} }, 'user-1');
    const insert = __mock.chainsFor('crm_settings')[0].ops.find((o) => o.method === 'insert');
    expect((insert?.args[0] as Record<string, unknown>).created_by).toBeUndefined();
  });
});

describe('crud.update / softDelete', () => {
  it('pre-flights a tenant check then stamps updated_by', async () => {
    // First .get() (tenant preflight) then the update .single().
    __mock.queue('crm_contacts', { data: [{ id: 'c1' }] }); // preflight get
    __mock.queue('crm_contacts', { data: [{ id: 'c1', updated_by: 'user-9' }] }); // update
    const row = await crud.update('crm_contacts', ORG, 'c1', { title: 'X' }, 'user-9', CLIENT);
    expect(row).toMatchObject({ id: 'c1' });
    const updateChain = __mock.chainsFor('crm_contacts')[1];
    const upd = updateChain.ops.find((o) => o.method === 'update');
    expect(upd?.args[0]).toMatchObject({ title: 'X', updated_by: 'user-9' });
  });

  it('softDelete sets deleted_at (does not hard-delete)', async () => {
    __mock.queue('crm_contacts', { data: [{ id: 'c1' }] }); // preflight get
    __mock.queue('crm_contacts', { data: [{ id: 'c1' }] }); // update
    await crud.softDelete('crm_contacts', ORG, 'c1', CLIENT);
    const delChain = __mock.chainsFor('crm_contacts')[1];
    const upd = delChain.ops.find((o) => o.method === 'update');
    expect((upd?.args[0] as Record<string, unknown>).deleted_at).toBeDefined();
    expect(delChain.ops.some((o) => o.method === 'delete')).toBe(false);
  });
});
