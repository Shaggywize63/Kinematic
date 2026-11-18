/**
 * Co-owners (additional owners) on a CRM lead / account / contact / deal.
 *
 * The record keeps its single primary owner_id; a co-owner is a peer who ALSO sees it. These pin the
 * rules that matter: a co-owner must be a real org user, the primary owner is never stored as a
 * co-owner, the set is replaced wholesale (remove the gone, add the new), and the read-scope helper
 * only ever returns the ids the caller actually co-owns (so it WIDENS a list, never narrows it).
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ro = require('../src/services/crm/recordOwners.service');

const ORG = '00000000-0000-0000-0000-0000000000aa';
const LEAD = '11111111-1111-1111-1111-111111111111';
const PRIMARY = '22222222-2222-2222-2222-222222222222';
const U1 = '33333333-3333-3333-3333-333333333333';
const U2 = '44444444-4444-4444-4444-444444444444';
const ctx = { org_id: ORG, client_id: null, user_id: PRIMARY };

beforeEach(() => __mock.reset());

describe('isOwnerEntity', () => {
  it('accepts the four entity types and rejects anything else', () => {
    for (const e of ['lead', 'account', 'contact', 'deal']) expect(ro.isOwnerEntity(e)).toBe(true);
    for (const e of ['leads', 'company', '', null, undefined, 1]) expect(ro.isOwnerEntity(e)).toBe(false);
  });
});

describe('setCoOwners', () => {
  it('validates users, drops the primary owner, inserts the rest, returns the refreshed list', async () => {
    __mock.setDefault('crm_leads', { data: { owner_id: PRIMARY, client_id: null } });
    // assertAssigneesInOrg: both U1 and U2 are org users; the primary is dropped before the check.
    __mock.setDefault('users', (c: any) =>
      c.ops.some((o: any) => o.method === 'in') && !c.ops.some((o: any) => o.method === 'select' && String(o.args[0]).includes('name'))
        ? { data: [{ id: U1 }, { id: U2 }] }
        : { data: [{ id: U1, name: 'Asha' }, { id: U2, name: 'Ravi' }] });
    // existing co-owners: none; final read returns the two we set.
    let readCount = 0;
    __mock.setDefault('crm_record_owners', (c: any) => {
      if (c.ops.some((o: any) => o.method === 'update' || o.method === 'insert')) return { data: [] };
      readCount += 1;
      return readCount === 1 ? { data: [] } : { data: [{ user_id: U1 }, { user_id: U2 }] };
    });

    const rows = await ro.setCoOwners(ctx, 'lead', LEAD, [U1, U2, PRIMARY, U1]);
    expect(rows.map((r: any) => r.user_id).sort()).toEqual([U1, U2].sort());

    // The insert excluded the primary and the duplicate.
    const insert = __mock.chainsFor('crm_record_owners').find((c) => c.ops.some((o) => o.method === 'insert'));
    const inserted = insert?.ops.find((o) => o.method === 'insert')?.args[0] as Array<{ user_id: string; entity_type: string }>;
    expect(inserted.map((r) => r.user_id).sort()).toEqual([U1, U2].sort());
    expect(inserted.every((r) => r.entity_type === 'lead')).toBe(true);
  });

  it('soft-deletes a co-owner who is no longer in the set', async () => {
    __mock.setDefault('crm_leads', { data: { owner_id: PRIMARY, client_id: null } });
    __mock.setDefault('users', { data: [{ id: U1 }] });
    __mock.setDefault('crm_record_owners', (c: any) => {
      if (c.ops.some((o: any) => o.method === 'update' || o.method === 'insert')) return { data: [] };
      // existing has U1 and U2; we only keep U1 → U2's row is removed.
      return { data: [{ id: 'row-1', user_id: U1 }, { id: 'row-2', user_id: U2 }] };
    });
    await ro.setCoOwners(ctx, 'lead', LEAD, [U1]);
    const update = __mock.chainsFor('crm_record_owners').find((c) => c.ops.some((o) => o.method === 'update'));
    expect(update?.ops.find((o) => o.method === 'update')?.args[0]).toHaveProperty('deleted_at');
    expect(update?.ops.some((o) => o.method === 'in' && o.args[0] === 'id' && JSON.stringify(o.args[1]) === JSON.stringify(['row-2']))).toBe(true);
  });

  it('404s when the record is not in the org', async () => {
    __mock.setDefault('crm_leads', { data: null });
    await expect(ro.setCoOwners(ctx, 'lead', LEAD, [U1])).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a user who is not in the org', async () => {
    __mock.setDefault('crm_leads', { data: { owner_id: PRIMARY, client_id: null } });
    __mock.setDefault('users', { data: [] }); // assertAssigneesInOrg finds 0 of 1
    await expect(ro.setCoOwners(ctx, 'lead', LEAD, [U1])).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('coOwnedEntityIds', () => {
  it('returns the distinct record ids the user co-owns, scoped to org + type + user', async () => {
    __mock.setDefault('crm_record_owners', { data: [{ entity_id: LEAD }, { entity_id: LEAD }, { entity_id: 'x2' }] });
    const ids = await ro.coOwnedEntityIds(ORG, U1, 'lead');
    expect(ids.sort()).toEqual([LEAD, 'x2'].sort());
    const chain = __mock.chainsFor('crm_record_owners')[0];
    expect(chain.eqs).toMatchObject({ org_id: ORG, entity_type: 'lead', user_id: U1 });
  });
  it('is empty for no user and never throws on a DB error', async () => {
    expect(await ro.coOwnedEntityIds(ORG, null, 'lead')).toEqual([]);
    __mock.setDefault('crm_record_owners', { error: { message: 'boom' } });
    expect(await ro.coOwnedEntityIds(ORG, U1, 'lead')).toEqual([]);
  });
});
