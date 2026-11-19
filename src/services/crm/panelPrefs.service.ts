/**
 * Per-user panel order for CRM detail pages — lead/deal/account detail and
 * the Client Management "Account & Billing" page. A sibling of
 * listViewPrefs.service.ts (list-page column/mode prefs) and
 * dashboardLayout.service.ts (widget-grid pages): same per-user,
 * backend-synced shape, kept as its own small table because the data it
 * holds (an ordered list of panel ids) doesn't fit either of those shapes.
 *
 * Requires the crm_panel_prefs table (migration crm_panel_prefs.sql).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export const PANEL_PAGES = ['lead_detail', 'deal_detail', 'account_detail', 'account_detail_sidebar', 'client_detail'] as const;
export type PanelPage = typeof PANEL_PAGES[number];

export interface PanelPrefs {
  /** Panel ids in the order the user wants them rendered. A page's render site falls back to its own
   *  default order for any id missing here (new panel the user hasn't seen) or any saved id it no
   *  longer recognizes (a panel that was removed/renamed) — this table doesn't validate panel ids. */
  order: string[];
}

const DEFAULT_PREFS: PanelPrefs = { order: [] };

export async function getPanelOrder(user_id: string, org_id: string, page: PanelPage): Promise<PanelPrefs> {
  const { data, error } = await supabaseAdmin
    .from('crm_panel_prefs')
    .select('config')
    .eq('user_id', user_id)
    .eq('org_id', org_id)
    .eq('page', page)
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const cfg = (data?.config as Partial<PanelPrefs> | null) ?? {};
  return {
    order: Array.isArray(cfg.order) ? cfg.order.filter((k): k is string => typeof k === 'string') : DEFAULT_PREFS.order,
  };
}

export async function savePanelOrder(
  user_id: string,
  org_id: string,
  client_id: string | null,
  page: PanelPage,
  prefs: PanelPrefs,
): Promise<PanelPrefs> {
  const clean: PanelPrefs = {
    order: Array.isArray(prefs?.order) ? prefs.order.filter((k) => typeof k === 'string') : [],
  };
  const row = {
    user_id,
    org_id,
    client_id,
    page,
    config: clean,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from('crm_panel_prefs')
    .upsert(row, { onConflict: 'user_id,org_id,page' });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return clean;
}
