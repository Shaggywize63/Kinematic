/**
 * Changing the nodal (primary) contact on a lead (crm_lead_contacts).
 *
 * As a deal progresses the point person changes — the rep re-points the lead's primary flag at a
 * different person already linked to the lead. The write must leave EXACTLY one primary: every other
 * link demoted, the chosen one promoted, and never two primaries at any moment. A link that is not on
 * this lead is rejected (404) rather than silently creating a dangling primary.
 *
 * Pins the two-step write shape from the supabase mock.
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
const { setLeadPrimaryContact } = require('../src/services/crm/visitBridge.service');

const ORG = '00000000-0000-0000-0000-0000000000aa';
const LEAD = '11111111-1111-1111-1111-111111111111';
const LINK = '22222222-2222-2222-2222-222222222222';
const ctx = { org_id: ORG, client_id: null };

beforeEach(() => {
  __mock.reset();
  // The chosen link exists on this lead (find step), and the refreshed read returns it as primary.
  __mock.setDefault('crm_lead_contacts', (chain: any) => {
    if (chain.ops.some((o: any) => o.method === 'maybeSingle')) return { data: { id: LINK } };
    if (chain.ops.some((o: any) => o.method === 'update')) return { data: [] };
    // final getLeadContacts select
    return { data: [{ id: LINK, contact_id: 'c1', is_primary: true, role: null, position: 0 }] };
  });
  __mock.setDefault('crm_contacts', { data: [{ id: 'c1', first_name: 'A', last_name: 'B' }] });
});

const updates = () => __mock.chainsFor('crm_lead_contacts').filter((c) => c.ops.some((o) => o.method === 'update'));

describe('setLeadPrimaryContact', () => {
  it('demotes every other link, then promotes the chosen one (never two primaries)', async () => {
    const rows = await setLeadPrimaryContact(ctx, LEAD, LINK);

    const ups = updates();
    expect(ups).toHaveLength(2);

    // 1) demote others: is_primary:false, scoped to the lead, excluding the chosen link
    const demote = ups[0];
    expect(demote.ops.find((o) => o.method === 'update')?.args[0]).toMatchObject({ is_primary: false });
    expect(demote.eqs.lead_id).toBe(LEAD);
    expect(demote.ops.some((o) => o.method === 'neq' && o.args[0] === 'id' && o.args[1] === LINK)).toBe(true);

    // 2) promote the chosen link: is_primary:true, scoped to the exact link
    const promote = ups[1];
    expect(promote.ops.find((o) => o.method === 'update')?.args[0]).toMatchObject({ is_primary: true });
    expect(promote.eqs.id).toBe(LINK);
    expect(promote.eqs.lead_id).toBe(LEAD);

    expect(rows[0]).toMatchObject({ id: LINK, is_primary: true });
  });

  it('rejects a contact that is not linked to this lead', async () => {
    __mock.setDefault('crm_lead_contacts', (chain: any) =>
      chain.ops.some((o: any) => o.method === 'maybeSingle') ? { data: null } : { data: [] });
    await expect(setLeadPrimaryContact(ctx, LEAD, LINK)).rejects.toMatchObject({ statusCode: 404 });
    // Nothing was written.
    expect(updates()).toHaveLength(0);
  });
});
