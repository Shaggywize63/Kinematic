/**
 * Renaming an account cascades to its leads: recomputeLeadNamesForAccount re-derives each linked
 * lead's display_name (Account · Plant · Department — Requirement, with the NEW account name) and
 * refreshes the free-text company snapshot, so the lead header / list row / identity strip stop
 * showing the old account name.
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
const { recomputeLeadNamesForAccount } = require('../src/services/crm/visitBridge.service') as {
  recomputeLeadNamesForAccount: (org: string, accountId: string, name: string) => Promise<void>;
};

const ORG = 'org-1';
const ACC = 'acc-1';

type Patch = Record<string, unknown>;
const updatePatches = (): Array<{ patch: Patch; id: unknown }> =>
  __mock.chainsFor('crm_leads')
    .filter((c) => c.ops.some((o) => o.method === 'update'))
    .map((c) => ({
      patch: (c.ops.find((o) => o.method === 'update')!.args[0]) as Patch,
      id: c.eqs['id'],
    }));

beforeEach(() => __mock.reset());

test('re-derives display_name + company for every linked lead with the new account name', async () => {
  // 1) the leads query
  __mock.queue('crm_leads', { data: [
    { id: 'lead-1', department: 'Procurement', requirement: '150 mm Gate Valves', site_id: 'site-1' },
    { id: 'lead-2', department: null, requirement: 'Pulse valves', site_id: null },
  ] });
  // 2) the plant/site-name batch
  __mock.queue('crm_sites', { data: [{ id: 'site-1', name: 'Dadri' }] });
  // 3) the two per-lead updates
  __mock.queue('crm_leads', { data: null });
  __mock.queue('crm_leads', { data: null });

  await recomputeLeadNamesForAccount(ORG, ACC, 'The Ramco Cements Limited');

  const patches = updatePatches();
  expect(patches).toHaveLength(2);

  const l1 = patches.find((p) => p.id === 'lead-1')!;
  expect(l1.patch.company).toBe('The Ramco Cements Limited');
  expect(l1.patch.display_name).toBe('The Ramco Cements Limited · Dadri · Procurement — 150 mm Gate Valves');

  const l2 = patches.find((p) => p.id === 'lead-2')!;
  expect(l2.patch.company).toBe('The Ramco Cements Limited');
  // No plant / department: the head collapses to just the company, then the requirement.
  expect(l2.patch.display_name).toBe('The Ramco Cements Limited — Pulse valves');

  // Scoped to the org on every write.
  for (const c of __mock.chainsFor('crm_leads').filter((c) => c.ops.some((o) => o.method === 'update'))) {
    expect(c.eqs['org_id']).toBe(ORG);
  }
});

test('no linked leads → no updates, and a blank name is a no-op', async () => {
  __mock.queue('crm_leads', { data: [] });
  await recomputeLeadNamesForAccount(ORG, ACC, 'Whatever');
  expect(updatePatches()).toHaveLength(0);

  __mock.reset();
  await recomputeLeadNamesForAccount(ORG, ACC, '   ');
  // Never even queried.
  expect(__mock.chainsFor('crm_leads')).toHaveLength(0);
});
