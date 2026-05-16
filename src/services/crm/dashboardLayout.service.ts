/**
 * CRM dashboard layout — per-user widget grid persistence.
 *
 * Two pages are tracked:
 *   - 'analytics': the customizable Lead Analytics page
 *   - 'overview':  the CRM Overview where users pin widgets they want at
 *                  the top of their landing screen.
 *
 * Storage shape (jsonb column `config`):
 * {
 *   widgets: [{ id, widget_type, chart_type, config }],
 *   layouts: { lg: [{i,x,y,w,h}], md: [...], sm: [...] }
 * }
 *
 * Requires the crm_dashboard_layouts table (applied via Supabase migration
 * add_crm_dashboard_layouts).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export type LayoutPage = 'analytics' | 'overview';

export interface WidgetInstance {
  id: string;
  widget_type: string;
  chart_type: string;
  config?: Record<string, unknown>;
}

export interface GridItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export interface DashboardConfig {
  widgets: WidgetInstance[];
  layouts: { lg?: GridItem[]; md?: GridItem[]; sm?: GridItem[] };
}

const DEFAULT_CONFIG: DashboardConfig = { widgets: [], layouts: {} };

export async function getLayout(user_id: string, org_id: string, page: LayoutPage): Promise<DashboardConfig> {
  const { data, error } = await supabaseAdmin
    .from('crm_dashboard_layouts')
    .select('config')
    .eq('user_id', user_id)
    .eq('org_id', org_id)
    .eq('page', page)
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const cfg = (data?.config as DashboardConfig | null) ?? DEFAULT_CONFIG;
  return {
    widgets: Array.isArray(cfg.widgets) ? cfg.widgets : [],
    layouts: typeof cfg.layouts === 'object' && cfg.layouts ? cfg.layouts : {},
  };
}

export async function saveLayout(
  user_id: string,
  org_id: string,
  client_id: string | null,
  page: LayoutPage,
  config: DashboardConfig,
): Promise<DashboardConfig> {
  const clean: DashboardConfig = {
    widgets: (config.widgets ?? []).map(w => ({
      id: String(w.id),
      widget_type: String(w.widget_type),
      chart_type: String(w.chart_type ?? 'bar'),
      config: typeof w.config === 'object' && w.config != null ? w.config : {},
    })),
    layouts: {
      lg: Array.isArray(config.layouts?.lg) ? config.layouts!.lg : undefined,
      md: Array.isArray(config.layouts?.md) ? config.layouts!.md : undefined,
      sm: Array.isArray(config.layouts?.sm) ? config.layouts!.sm : undefined,
    },
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
    .from('crm_dashboard_layouts')
    .upsert(row, { onConflict: 'user_id,org_id,page' });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return clean;
}

/** Pin a widget to the CRM Overview — used by "Add to dashboard" on each analytics tile. */
export async function pinWidgetToOverview(
  user_id: string,
  org_id: string,
  client_id: string | null,
  widget: WidgetInstance,
): Promise<DashboardConfig> {
  const current = await getLayout(user_id, org_id, 'overview');

  const existingIdx = current.widgets.findIndex(w => w.widget_type === widget.widget_type);
  if (existingIdx >= 0) {
    current.widgets[existingIdx] = { ...current.widgets[existingIdx], ...widget };
    return saveLayout(user_id, org_id, client_id, 'overview', current);
  }

  current.widgets.push(widget);
  for (const bp of ['lg', 'md', 'sm'] as const) {
    const layout = current.layouts[bp] ?? [];
    const maxY = layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    const w = bp === 'lg' ? 6 : bp === 'md' ? 6 : 12;
    layout.push({ i: widget.id, x: 0, y: maxY, w, h: 4 });
    current.layouts[bp] = layout;
  }
  return saveLayout(user_id, org_id, client_id, 'overview', current);
}

export async function removeWidget(
  user_id: string,
  org_id: string,
  client_id: string | null,
  page: LayoutPage,
  widget_id: string,
): Promise<DashboardConfig> {
  const current = await getLayout(user_id, org_id, page);
  current.widgets = current.widgets.filter(w => w.id !== widget_id);
  for (const bp of ['lg', 'md', 'sm'] as const) {
    if (current.layouts[bp]) {
      current.layouts[bp] = current.layouts[bp]!.filter(it => it.i !== widget_id);
    }
  }
  return saveLayout(user_id, org_id, client_id, page, current);
}
