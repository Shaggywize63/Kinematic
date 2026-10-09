/**
 * Agrisynx app configuration — expenses as "Travel", the app's tabs / home tiles, the consent block and the
 * Sales / Collection rupee targets.
 *
 * Everything here is DATA behind existing admin endpoints, so nothing changes for any other client.
 * Four parts, each idempotent (an unchanged part is detected and not written again):
 *
 *   1. Expense policy   PUT|POST /api/v1/expenses/policies   rules.categories (all but mileage disabled),
 *                       rules.category_labels {mileage:"Travel"}, route_fields:false, single_line:true,
 *                       odometer_camera_only:true. The policy that already exists is edited in place — its
 *                       vehicle rates, limits and assignment are kept; only the keys above are set.
 *   2. App UI           PATCH /api/v1/clients/:id               clients.settings.app_ui:
 *                       tabs.expenses=true, tabs.new_form=false, home.open_volume=false. The endpoint
 *                       REPLACES app_ui wholesale, so the current value is read first and merged.
 *   3. Consent block    PATCH /api/v1/crm/settings              hides lead.data_consent (and the marketing /
 *                       WhatsApp consent boxes on dealers) on the lead forms. config.field_overrides is also
 *                       replaced as a whole, so it is read first and merged. Same values the lead-form
 *                       seed (agrisynx-lead-forms.ts) writes — run either, or both.
 *   4. Targets          PATCH /api/v1/crm/settings              config.targets.types = sales + collection (the
 *                       monthly rupee targets and the order / collection entries behind them). Written in the
 *                       same request as part 3. Needs migrations/crm_target_entries.sql applied (psql, as the
 *                       table owner) before reps can log entries; until then the API answers 409
 *                       TARGET_ENTRIES_NOT_ENABLED and shows progress 0. Existing labels are kept.
 *
 *   TOKEN=<admin access token> CLIENT_ID=<agrisynx client uuid> \
 *     npx tsx src/tools/agrisynx-app-config.ts [--dry-run]
 *
 *   optional: API_URL (default https://api.kinematicapp.com), PROJECT (X-Kinematic-Project, default
 *   'kinematic'), POLICY_ID (which expense policy to edit when the client has several active ones).
 *
 * The token must belong to an admin who may edit the client in Client Management (PATCH /clients/:id is
 * admin / super_admin of the org that owns the client) and the expense policies and CRM settings.
 *
 * Hiding the consent block does not lift a client's "consent required" setting
 * (crm_settings.config.consent.lead_pii.required): keep the two consistent.
 */
import { FIELD_OVERRIDES } from './agrisynx-lead-forms';

// ── what Agrisynx gets ──────────────────────────────────────────────────────
/** Keep aligned with CATEGORIES in src/services/expenses/policy.service.ts (a test pins it). */
export const CATEGORIES = ['mileage', 'travel', 'food', 'lodging', 'fuel', 'toll', 'misc'] as const;
export const ENABLED_CATEGORIES: string[] = ['mileage'];

export const EXPENSE_RULES = {
  category_labels: { mileage: 'Travel' } as Record<string, string>,
  route_fields: false,
  single_line: true,
  odometer_camera_only: true,
};

export const APP_UI: Record<string, Record<string, boolean>> = {
  tabs: { expenses: true, new_form: false },
  home: { open_volume: false },
};

/** The consent boxes hidden on the lead forms — taken from the lead-form seed so the two never disagree. */
export const CONSENT_OVERRIDE_KEYS = [
  'lead.data_consent@b2b', 'lead.data_consent@b2c', 'lead.marketing_consent@b2b', 'lead.whatsapp_consent@b2b',
];
export const CONSENT_OVERRIDES = Object.fromEntries(CONSENT_OVERRIDE_KEYS.map((k) => [k, FIELD_OVERRIDES[k]]));

/** crm_settings.config.targets: the rupee target types the client gets (labels left to their defaults). */
export const TARGET_KEYS = ['sales', 'collection'] as const;

export const DEFAULT_POLICY_NAME = 'Agrisynx field policy';

// ── planning (pure, so it is testable) ──────────────────────────────────────
type Json = Record<string, unknown>;
const isPlain = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Key-order independent comparison, so "already up to date" survives a re-serialisation. */
export function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
    : isPlain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** The policy rules with Agrisynx's values laid over what the policy already has. Never mutates the input. */
export function planExpenseRules(existing: unknown): Json {
  const base: Json = isPlain(existing) ? { ...existing } : {};
  const cats: Json = isPlain(base.categories) ? (base.categories as Json) : {};
  const categories: Json = {};
  for (const c of CATEGORIES) {
    categories[c] = { ...(isPlain(cats[c]) ? (cats[c] as Json) : {}), enabled: ENABLED_CATEGORIES.includes(c) };
  }
  return {
    ...base,
    categories,
    ...EXPENSE_RULES,
    category_labels: { ...(isPlain(base.category_labels) ? (base.category_labels as Json) : {}), ...EXPENSE_RULES.category_labels },
  };
}

export interface PolicyRef { id: string; name: string; is_active?: boolean; client_id?: string | null }
export type PolicyChoice =
  | { op: 'update'; id: string; name: string }
  | { op: 'create' }
  | { op: 'ambiguous'; names: string[] }
  | { op: 'missing'; id: string }
  | { op: 'shared'; id: string; name: string };

/**
 * Which expense policy to edit. Only a policy that belongs to THIS client is ever touched — the list
 * also carries the org-wide policies (client_id null) every client in the org is governed by, and
 * editing one of those would change the other clients too. Order: the one asked for (POLICY_ID), else
 * ours by name, else the client's only active one, else make a new one.
 */
export function choosePolicy(list: PolicyRef[], clientId: string, wantedId?: string): PolicyChoice {
  if (wantedId) {
    const hit = list.find((p) => p.id === wantedId);
    if (!hit) return { op: 'missing', id: wantedId };
    return hit.client_id === clientId ? { op: 'update', id: hit.id, name: hit.name } : { op: 'shared', id: hit.id, name: hit.name };
  }
  const own = list.filter((p) => p.client_id === clientId);
  const named = own.find((p) => p.name.trim().toLowerCase() === DEFAULT_POLICY_NAME.toLowerCase());
  if (named) return { op: 'update', id: named.id, name: named.name };
  const active = own.filter((p) => p.is_active !== false);
  if (active.length === 0) return { op: 'create' };
  if (active.length === 1) return { op: 'update', id: active[0].id, name: active[0].name };
  return { op: 'ambiguous', names: active.map((p) => `${p.name} (${p.id})`) };
}

/** The app_ui object with Agrisynx's tabs / home keys set and every other key left as it was. */
export function planAppUi(existing: unknown): Json {
  const cur: Json = isPlain(existing) ? existing : {};
  const out: Json = { ...cur };
  for (const [group, values] of Object.entries(APP_UI)) {
    const have = cur[group];
    if (have !== undefined && have !== null && !isPlain(have)) {
      throw new Error(`app_ui.${group} is not an object (${Array.isArray(have) ? 'array' : typeof have}); refusing to overwrite it — fix it in Client Management first.`);
    }
    out[group] = { ...(isPlain(have) ? have : {}), ...values };
  }
  return out;
}

/**
 * The settings patch for the consent block: our overrides laid over whatever is already configured.
 *
 * `inherited`: the config was read from the org-level default row because the client has no row of its
 * own yet. Saving creates the client's row, after which the org default is no longer consulted for it —
 * so the whole inherited config is carried across (minus `score_boost_signals`, which GET /crm/settings
 * overlays from clients.settings and must not be frozen into the row).
 */
export function planConsentSettings(existingConfig: unknown, inherited = false) {
  const cfg: Json = isPlain(existingConfig) ? existingConfig : {};
  const current = isPlain(cfg.field_overrides) ? cfg.field_overrides : {};
  const field_overrides = { ...current, ...CONSENT_OVERRIDES };
  if (!inherited) return { config: { field_overrides } };
  const { score_boost_signals: _overlay, ...rest } = cfg;
  return { config: { ...rest, field_overrides } };
}

/**
 * `config.targets` with Sales and Collection enabled. Whatever is already there stays: a type that is
 * already listed keeps its position and label, only the missing ones are added (in sales, collection order).
 */
export function planTargetsConfig(existing: unknown): Json {
  const cur: Json = isPlain(existing) ? existing : {};
  const types = (Array.isArray(cur.types) ? cur.types : []).filter(isPlain) as Json[];
  const have = new Set(types.map((t) => t.key));
  return { ...cur, types: [...types, ...TARGET_KEYS.filter((k) => !have.has(k)).map((key) => ({ key }))] };
}

/** The whole CRM settings patch: the hidden consent block and the rupee targets (see planConsentSettings for `inherited`). */
export function planCrmSettings(existingConfig: unknown, inherited = false) {
  const consent = planConsentSettings(existingConfig, inherited);
  const cfg: Json = isPlain(existingConfig) ? existingConfig : {};
  return { config: { ...consent.config, targets: planTargetsConfig(cfg.targets) } };
}

// ── applying it through the API ─────────────────────────────────────────────
async function main() {
  const dry = process.argv.includes('--dry-run');
  const api = (process.env.API_URL || 'https://api.kinematicapp.com').replace(/\/$/, '');
  const token = process.env.TOKEN;
  const clientId = process.env.CLIENT_ID;
  if (!token || !clientId) {
    console.error('Set TOKEN (an admin access token) and CLIENT_ID (the agrisynx client id).');
    process.exit(1);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Client-Id': clientId,
    ...(process.env.PROJECT && process.env.PROJECT !== 'default' ? { 'X-Kinematic-Project': process.env.PROJECT }
      : process.env.PROJECT === undefined ? { 'X-Kinematic-Project': 'kinematic' } : {}),
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json?.error?.message || json?.error || json?.message || text.slice(0, 200)}`);
    return json;
  };
  const tag = dry ? '[dry-run] ' : '';

  // 1. expense policy
  const policies: any[] = (await call('GET', '/api/v1/expenses/policies'))?.data ?? [];
  const choice = choosePolicy(policies, clientId, process.env.POLICY_ID);
  if (choice.op === 'ambiguous') {
    throw new Error(`This client has several active expense policies; re-run with POLICY_ID=<id> for the one the field team uses:\n  ${choice.names.join('\n  ')}`);
  }
  if (choice.op === 'missing') throw new Error(`No expense policy with id ${choice.id} for this client.`);
  if (choice.op === 'shared') {
    throw new Error(`Expense policy "${choice.name}" is shared by the whole org, so editing it would change the other clients too. Duplicate it for this client (or let this tool create the client's own) and re-run.`);
  }
  if (choice.op === 'create') {
    console.log(`${tag}create expense policy "${DEFAULT_POLICY_NAME}" (everyone): Travel only, one line, no route fields, camera-only odometer`);
    // priority 10: outranks the generic org-wide policies (100) should one also apply to everyone.
    if (!dry) await call('POST', '/api/v1/expenses/policies', { name: DEFAULT_POLICY_NAME, priority: 10, applies_to: { everyone: true }, rules: planExpenseRules(undefined) });
  } else {
    const current = policies.find((p) => p.id === choice.id);
    const rules = planExpenseRules(current?.rules);
    if (sameJson(rules, current?.rules)) console.log(`expense policy "${choice.name}": already up to date`);
    else {
      console.log(`${tag}update expense policy "${choice.name}": Travel only, one line, no route fields, camera-only odometer`);
      if (!dry) await call('PUT', `/api/v1/expenses/policies/${choice.id}`, { rules });
    }
  }

  // 2. app tabs / home tiles (PATCH replaces app_ui as a whole, so merge into what is there)
  const clients: any[] = (await call('GET', '/api/v1/clients'))?.data ?? [];
  const client = clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Client ${clientId} is not visible to this token (PATCH /clients/:id needs an admin of the org that owns it).`);
  const currentUi = client.settings?.app_ui;
  const appUi = planAppUi(currentUi);
  if (sameJson(appUi, currentUi)) console.log('app_ui: already up to date');
  else {
    console.log(`${tag}update app_ui: tabs.expenses=on, tabs.new_form=off, home.open_volume=off`);
    if (!dry) await call('PATCH', `/api/v1/clients/${clientId}`, { app_ui: appUi });
  }

  // 3 + 4. consent block hidden on the lead forms, rupee targets enabled (PATCH merges config keys shallowly, so
  // send all of field_overrides / targets, built from what is there now)
  const settings = await call('GET', '/api/v1/crm/settings');
  const row = settings?.data ?? settings;
  // The org-level default row (no client_id) is what a client without its own row is served.
  const inherited = !!row?.id && !row?.client_id;
  const patch = planCrmSettings(row?.config, inherited);
  const consentDone = sameJson(patch.config.field_overrides, row?.config?.field_overrides);
  const targetsDone = sameJson(patch.config.targets, row?.config?.targets);
  if (consentDone) console.log('lead consent block: already hidden');
  else console.log(`${tag}update settings: hide ${CONSENT_OVERRIDE_KEYS.join(', ')}`);
  if (targetsDone) console.log('targets: sales + collection already enabled');
  else console.log(`${tag}update settings: enable the sales + collection targets (config.targets.types)`);
  if (!(consentDone && targetsDone) && !dry) await call('PATCH', '/api/v1/crm/settings', patch);
  console.log('Note: reps can only log sales / collection entries once migrations/crm_target_entries.sql has been applied (psql, as the table owner).');

  console.log(dry ? 'Dry run only — nothing was changed.' : 'Done. Reload the dashboard and the apps.');
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
