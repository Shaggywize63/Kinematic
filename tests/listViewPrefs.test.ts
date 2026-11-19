jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { getListViewPrefs, saveListViewPrefs, LIST_VIEW_ENTITIES } from '../src/services/crm/listViewPrefs.service';

const supa = () => (global as any).__supa;

beforeEach(() => {
  supa().reset();
});

describe('LIST_VIEW_ENTITIES', () => {
  it('covers the 5 existing CRM list surfaces', () => {
    expect(LIST_VIEW_ENTITIES).toEqual(['leads', 'deals', 'accounts', 'contacts', 'activities']);
  });
});

describe('getListViewPrefs', () => {
  it('returns defaults when no row exists for this user/org/entity', async () => {
    supa().setDefault('crm_list_view_prefs', { data: null });

    const prefs = await getListViewPrefs('user-1', 'org-1', 'leads');

    expect(prefs).toEqual({ hidden: [], mode: 'table' });
    const chain = supa().chainsFor('crm_list_view_prefs')[0];
    expect(chain.eqs).toEqual({ user_id: 'user-1', org_id: 'org-1', entity: 'leads' });
  });

  it('returns the stored hidden columns and mode', async () => {
    supa().setDefault('crm_list_view_prefs', { data: { config: { hidden: ['source', 'owner'], mode: 'cards' } } });

    const prefs = await getListViewPrefs('user-1', 'org-1', 'deals');

    expect(prefs).toEqual({ hidden: ['source', 'owner'], mode: 'cards' });
  });

  it('accepts the kanban mode', async () => {
    supa().setDefault('crm_list_view_prefs', { data: { config: { hidden: [], mode: 'kanban' } } });

    const prefs = await getListViewPrefs('user-1', 'org-1', 'deals');

    expect(prefs.mode).toBe('kanban');
  });

  it('sanitizes a malformed stored config back to defaults', async () => {
    supa().setDefault('crm_list_view_prefs', { data: { config: { hidden: 'not-an-array', mode: 'bogus' } } });

    const prefs = await getListViewPrefs('user-1', 'org-1', 'accounts');

    expect(prefs).toEqual({ hidden: [], mode: 'table' });
  });

  it('drops non-string entries from a stored hidden array', async () => {
    supa().setDefault('crm_list_view_prefs', { data: { config: { hidden: ['owner', 42, null, 'source'], mode: 'table' } } });

    const prefs = await getListViewPrefs('user-1', 'org-1', 'contacts');

    expect(prefs.hidden).toEqual(['owner', 'source']);
  });

  it('throws on a DB error', async () => {
    supa().setDefault('crm_list_view_prefs', { data: null, error: { message: 'boom' } });

    await expect(getListViewPrefs('user-1', 'org-1', 'activities')).rejects.toThrow('boom');
  });
});

describe('saveListViewPrefs', () => {
  it('upserts the clean row keyed by user_id, org_id, entity', async () => {
    supa().setDefault('crm_list_view_prefs', { data: null });

    const result = await saveListViewPrefs('user-1', 'org-1', 'client-1', 'leads', { hidden: ['owner'], mode: 'cards' });

    expect(result).toEqual({ hidden: ['owner'], mode: 'cards' });
    const chain = supa().chainsFor('crm_list_view_prefs')[0];
    const upsertOp = chain.ops.find((o: { method: string }) => o.method === 'upsert');
    expect(upsertOp.args[0]).toMatchObject({
      user_id: 'user-1',
      org_id: 'org-1',
      client_id: 'client-1',
      entity: 'leads',
      config: { hidden: ['owner'], mode: 'cards' },
    });
    expect(upsertOp.args[1]).toEqual({ onConflict: 'user_id,org_id,entity' });
  });

  it('sanitizes an invalid mode to table', async () => {
    supa().setDefault('crm_list_view_prefs', { data: null });

    const result = await saveListViewPrefs('user-1', 'org-1', null, 'deals', { hidden: [], mode: 'bogus' as any });

    expect(result.mode).toBe('table');
  });

  it('drops non-string entries from the hidden array before saving', async () => {
    supa().setDefault('crm_list_view_prefs', { data: null });

    const result = await saveListViewPrefs('user-1', 'org-1', null, 'accounts', { hidden: ['owner', 7 as any], mode: 'table' });

    expect(result.hidden).toEqual(['owner']);
  });

  it('throws on a DB error', async () => {
    supa().setDefault('crm_list_view_prefs', { data: null, error: { message: 'boom' } });

    await expect(saveListViewPrefs('user-1', 'org-1', null, 'leads', { hidden: [], mode: 'table' })).rejects.toThrow('boom');
  });
});
