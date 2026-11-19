jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { getPanelOrder, savePanelOrder, PANEL_PAGES } from '../src/services/crm/panelPrefs.service';

const supa = () => (global as any).__supa;

beforeEach(() => {
  supa().reset();
});

describe('PANEL_PAGES', () => {
  it('covers the detail pages', () => {
    expect(PANEL_PAGES).toEqual(['lead_detail', 'deal_detail', 'account_detail', 'account_detail_sidebar', 'client_detail']);
  });
});

describe('getPanelOrder', () => {
  it('returns an empty order when no row exists', async () => {
    supa().setDefault('crm_panel_prefs', { data: null });

    const prefs = await getPanelOrder('user-1', 'org-1', 'lead_detail');

    expect(prefs).toEqual({ order: [] });
    const chain = supa().chainsFor('crm_panel_prefs')[0];
    expect(chain.eqs).toEqual({ user_id: 'user-1', org_id: 'org-1', page: 'lead_detail' });
  });

  it('returns the stored order', async () => {
    supa().setDefault('crm_panel_prefs', { data: { config: { order: ['notes', 'profile', 'activity'] } } });

    const prefs = await getPanelOrder('user-1', 'org-1', 'deal_detail');

    expect(prefs).toEqual({ order: ['notes', 'profile', 'activity'] });
  });

  it('sanitizes a malformed stored config back to an empty order', async () => {
    supa().setDefault('crm_panel_prefs', { data: { config: { order: 'not-an-array' } } });

    const prefs = await getPanelOrder('user-1', 'org-1', 'account_detail');

    expect(prefs).toEqual({ order: [] });
  });

  it('drops non-string entries from a stored order array', async () => {
    supa().setDefault('crm_panel_prefs', { data: { config: { order: ['profile', 42, null, 'notes'] } } });

    const prefs = await getPanelOrder('user-1', 'org-1', 'client_detail');

    expect(prefs.order).toEqual(['profile', 'notes']);
  });

  it('throws on a DB error', async () => {
    supa().setDefault('crm_panel_prefs', { data: null, error: { message: 'boom' } });

    await expect(getPanelOrder('user-1', 'org-1', 'lead_detail')).rejects.toThrow('boom');
  });
});

describe('savePanelOrder', () => {
  it('upserts the clean row keyed by user_id, org_id, page', async () => {
    supa().setDefault('crm_panel_prefs', { data: null });

    const result = await savePanelOrder('user-1', 'org-1', 'client-1', 'lead_detail', { order: ['activity', 'profile'] });

    expect(result).toEqual({ order: ['activity', 'profile'] });
    const chain = supa().chainsFor('crm_panel_prefs')[0];
    const upsertOp = chain.ops.find((o: { method: string }) => o.method === 'upsert');
    expect(upsertOp.args[0]).toMatchObject({
      user_id: 'user-1',
      org_id: 'org-1',
      client_id: 'client-1',
      page: 'lead_detail',
      config: { order: ['activity', 'profile'] },
    });
    expect(upsertOp.args[1]).toEqual({ onConflict: 'user_id,org_id,page' });
  });

  it('drops non-string entries from the order array before saving', async () => {
    supa().setDefault('crm_panel_prefs', { data: null });

    const result = await savePanelOrder('user-1', 'org-1', null, 'account_detail', { order: ['profile', 9 as any] });

    expect(result.order).toEqual(['profile']);
  });

  it('throws on a DB error', async () => {
    supa().setDefault('crm_panel_prefs', { data: null, error: { message: 'boom' } });

    await expect(savePanelOrder('user-1', 'org-1', null, 'deal_detail', { order: [] })).rejects.toThrow('boom');
  });
});
