/**
 * Per-user list-view preferences (hidden columns + view mode) for CRM list
 * pages — leads, deals, accounts, contacts, activities.
 *
 * Synced via backend so a user's column/view choices follow them across
 * browsers and devices. This replaces the legacy `kinematic_view_prefs:*`
 * localStorage keys in the dashboard, which were per-browser and per-client
 * rather than per-user.
 *
 * Column *offers* must still be filtered through the entity's admin field
 * overrides (crmFieldOverrides.ts on the client) before being shown to the
 * user — an admin-hidden built-in field is never a choosable column here,
 * regardless of what a user previously saved.
 *
 * Requires the crm_list_view_prefs table (migration crm_list_view_prefs.sql).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export const LIST_VIEW_ENTITIES = ['leads', 'deals', 'accounts', 'contacts', 'activities'] as const;
export type ListViewEntity = typeof LIST_VIEW_ENTITIES[number];
export type ListViewMode = 'table' | 'cards' | 'kanban';

export interface ListViewPrefs {
  hidden: string[];
  mode: ListViewMode;
}

const DEFAULT_PREFS: ListViewPrefs = { hidden: [], mode: 'table' };

function isMode(v: unknown): v is ListViewMode {
  return v === 'table' || v === 'cards' || v === 'kanban';
}

export async function getListViewPrefs(user_id: string, org_id: string, entity: ListViewEntity): Promise<ListViewPrefs> {
  const { data, error } = await supabaseAdmin
    .from('crm_list_view_prefs')
    .select('config')
    .eq('user_id', user_id)
    .eq('org_id', org_id)
    .eq('entity', entity)
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const cfg = (data?.config as Partial<ListViewPrefs> | null) ?? {};
  return {
    hidden: Array.isArray(cfg.hidden) ? cfg.hidden.filter((k): k is string => typeof k === 'string') : DEFAULT_PREFS.hidden,
    mode: isMode(cfg.mode) ? cfg.mode : DEFAULT_PREFS.mode,
  };
}

export async function saveListViewPrefs(
  user_id: string,
  org_id: string,
  client_id: string | null,
  entity: ListViewEntity,
  prefs: ListViewPrefs,
): Promise<ListViewPrefs> {
  const clean: ListViewPrefs = {
    hidden: Array.isArray(prefs?.hidden) ? prefs.hidden.filter((k) => typeof k === 'string') : [],
    mode: isMode(prefs?.mode) ? prefs.mode : 'table',
  };
  const row = {
    user_id,
    org_id,
    client_id,
    entity,
    config: clean,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from('crm_list_view_prefs')
    .upsert(row, { onConflict: 'user_id,org_id,entity' });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return clean;
}
