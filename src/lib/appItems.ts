/**
 * The mobile apps' sections and screens, and the module each one needs.
 *
 * Client Management ticks modules per client; this file is the rule that says which app screens a ticked module
 * brings with it. Two things use it:
 *
 *  1. `deriveAppUi` — /auth/me returns `app_ui_config` with every screen whose module the client has NOT been given
 *     switched off (`<section>.<id> = false`). The apps already honour those flags, so a screen whose module is not
 *     ticked disappears even on app builds that predate this file.
 *  2. `sanitizeLayout` — the admin's drag-and-drop layout (order of each container, and which screens sit in the bottom
 *     bar) is cleaned before it is stored and again before it is served.
 *
 * The dashboard mirrors the same table in src/lib/appCustomization.ts (KEEP IN SYNC); the apps only receive its result.
 *
 * An item with no `needs` is essential (Profile, Appearance, About…): it is always there.
 */

export type AppSection = 'menu' | 'tabs' | 'crm_more' | 'home' | 'settings';
export const APP_SECTIONS: AppSection[] = ['menu', 'tabs', 'crm_more', 'home', 'settings'];

/** `any`: at least one of these modules is held. `package`: the client holds a module of that package. */
export type Need = { any: string[] } | { package: string };

export const APP_ITEM_NEEDS: Record<AppSection, Record<string, Need | null>> = {
  menu: {
    profile: null,
    notifications: { any: ['notifications'] },
    broadcast: { any: ['broadcast'] },
    learning_hub: { any: ['learning'] },
    log_visit: { any: ['visit_logs'] },
    leaderboard: { any: ['leaderboard'] },
    activity_feed: { any: ['activity_feed'] },
    stock: { any: ['inventory'] },
    grievance: { any: ['grievances'] },
    emergency_sos: { any: ['emergency_sos'] },
    expenses: { any: ['field_expenses'] },
    leave: { any: ['leave'] },
    timeline: { any: ['timeline'] },
    planogram: { any: ['planograms'] },
    book_order: { any: ['distribution_orders'] },
    collect_payment: { any: ['distribution_payments'] },
    my_orders: { any: ['distribution_orders'] },
    van_load: { any: ['distribution_van'] },
    distributor_stock: { any: ['distribution_stock'] },
    log_damage: { any: ['distribution_damage'] },
    stock_batches: { any: ['distribution_batches'] },
    crm: { package: 'crm' },
    ask_kini: { package: 'crm' },
  },
  tabs: {
    attendance: { any: ['attendance'] },
    route_plan: { any: ['orders'] },
    activity: { any: ['activities'] },
    new_form: { any: ['form_builder'] },
    expenses: { any: ['field_expenses'] },
  },
  home: {
    stores: { any: ['stores'] },
    visited: { any: ['visit_logs'] },
    forms: { any: ['form_builder'] },
    todays_route: { any: ['orders'] },
    open_volume: { any: ['crm_dashboard'] },
    my_targets: null,
  },
  settings: {
    appearance: null,
    crm_only_mode: null,
    app_lock: null,
    about: null,
    rate_app: null,
    face_enrollment: { any: ['face_attendance'] },
  },
  crm_more: {
    accounts: { any: ['crm_accounts'] },
    pipeline: { any: ['crm_pipeline'] },
    products: { any: ['crm_products'] },
    custom_objects: { any: ['crm_settings'] },
    nearest_leads: { any: ['crm_leads'] },
    leave: { any: ['leave'] },
    expenses: { any: ['field_expenses'] },
    dashboard: { any: ['crm_dashboard'] },
    lead_analytics: { any: ['crm_lead_analytics'] },
    reports: { any: ['crm_reports'] },
    switch_ff: { package: 'field_force' },
  },
};

/**
 * Screens that may sit in the field-force bottom bar (after Home). Every one has a route and an icon in both apps, so
 * the admin can drag any of them into the bar; the rest only live in the side menu / More / Settings.
 */
export const TAB_CAPABLE: string[] = [
  'attendance', 'route_plan', 'activity', 'new_form', 'expenses', 'leave', 'timeline', 'log_visit',
  'broadcast', 'notifications', 'crm', 'my_orders', 'book_order', 'collect_payment',
];
/** Bottom bar = Home + up to this many more (the bar fits five). */
export const MAX_EXTRA_TABS = 4;

export interface EntitlementView { enabled_modules: string[]; enabled_packages: string[] }

export function needMet(need: Need | null | undefined, ent: EntitlementView): boolean {
  if (!need) return true;
  if ('any' in need) return need.any.some((m) => ent.enabled_modules.includes(m));
  return ent.enabled_packages.includes(need.package);
}

/** Is the screen `id` of `section` available to a client that holds `ent`? Unknown ids are not judged here. */
export function itemAvailable(section: AppSection, id: string, ent: EntitlementView): boolean {
  const need = APP_ITEM_NEEDS[section]?.[id];
  return need === undefined ? true : needMet(need, ent);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export type Layout = Partial<Record<AppSection, string[]>>;

/** Screens a layout may name per container. `tabs` is limited to what the bar can host. */
function knownIds(section: AppSection): string[] {
  return section === 'tabs' ? TAB_CAPABLE : Object.keys(APP_ITEM_NEEDS[section]);
}

/**
 * Normalise an admin's layout: only known ids, no duplicates, `tabs` limited to bar-capable screens and to
 * MAX_EXTRA_TABS, a screen placed in the bar is not also listed in the menu. Containers the admin never touched stay absent
 * (absent = the app's default order). Pass `ent` to also drop screens the client's modules do not provide.
 */
export function sanitizeLayout(input: unknown, ent?: EntitlementView): Layout | undefined {
  if (!isObj(input)) return undefined;
  const out: Layout = {};
  for (const section of APP_SECTIONS) {
    const raw = input[section];
    if (!Array.isArray(raw)) continue;
    const allowed = new Set(knownIds(section));
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const v of raw) {
      const id = typeof v === 'string' ? v.trim() : '';
      if (!id || seen.has(id) || !allowed.has(id)) continue;
      if (ent && !itemAvailable(section === 'tabs' ? tabHome(id) : section, id, ent)) continue;
      seen.add(id);
      ids.push(id);
    }
    out[section] = section === 'tabs' ? ids.slice(0, MAX_EXTRA_TABS) : ids;
  }
  // A screen in the bottom bar leaves the side menu (never both).
  if (out.tabs && out.menu) {
    const inBar = new Set(out.tabs);
    out.menu = out.menu.filter((id) => !inBar.has(id));
  }
  return Object.keys(out).length ? out : undefined;
}

/** Which section's rule decides whether a bar-capable screen is available (its own `tabs.*` rule, else its menu rule). */
function tabHome(id: string): AppSection {
  return id in APP_ITEM_NEEDS.tabs ? 'tabs' : 'menu';
}

/**
 * The `app_ui` the apps receive: the admin's stored config plus `<section>.<id> = false` for every screen the client's
 * modules do not provide, and the layout cleaned against the same rule. Without entitlement data (a failed lookup, or a
 * platform user who sees everything) the stored config is returned untouched.
 */
export function deriveAppUi(stored: unknown, ent: (EntitlementView & { strict?: boolean }) | null | undefined): Json {
  const base: Json = isObj(stored) ? JSON.parse(JSON.stringify(stored)) : {};
  if (!ent || ent.strict !== true) return base;
  for (const section of APP_SECTIONS) {
    for (const [id, need] of Object.entries(APP_ITEM_NEEDS[section])) {
      if (needMet(need, ent)) continue;
      const cur = isObj(base[section]) ? (base[section] as Json) : {};
      base[section] = { ...cur, [id]: false };
    }
  }
  const layout = sanitizeLayout(base.layout, ent);
  if (layout) base.layout = layout; else delete base.layout;
  return base;
}

/** What gets stored for a client: the admin's app_ui with its layout cleaned (everything else is kept as sent). */
export function cleanAppUiForStore(input: Json): Json {
  const out: Json = { ...input };
  if ('layout' in out) {
    const layout = sanitizeLayout(out.layout);
    if (layout) out.layout = layout; else delete out.layout;
  }
  return out;
}
