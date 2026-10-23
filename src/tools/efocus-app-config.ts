/**
 * eFocus app configuration — the "see your travel on check-out, then log it (and other expenses)" setup.
 *
 * Everything here is DATA behind existing admin endpoints, so nothing changes for any other client. Two
 * idempotent parts (an unchanged part is detected and not written again):
 *
 *   1. Expense policy   PUT|POST /api/v1/expenses/policies   rules.gps_distance=true + rules.vehicle_rates
 *                       (so after the final check-out the app offers "Add today's travel to expenses?",
 *                       reads the day's GPS distance and drafts a mileage claim priced per km), plus the
 *                       out-of-pocket categories enabled and mileage labelled "Travel". The policy that
 *                       already exists for the client is edited in place — its own vehicle rates, limits
 *                       and assignment are kept; only the keys above are set. Set VEHICLE_RATES (JSON) to
 *                       seed the rates when the client has none yet (gps_distance needs at least one).
 *   2. App UI           PATCH /api/v1/clients/:id            clients.settings.app_ui.tabs.expenses=true,
 *                       so the Expenses tab shows and the check-out travel prompt is eligible
 *                       (app gate: expensesEnabled && gps_distance && vehicles.length > 0). The endpoint
 *                       REPLACES app_ui wholesale, so the current value is read first and merged.
 *
 *   TOKEN=<admin access token> CLIENT_ID=<efocus client uuid> \
 *     [VEHICLE_RATES='[{"label":"Two-wheeler","rate_per_km":4},{"label":"Car","rate_per_km":10}]'] \
 *     npx tsx src/tools/efocus-app-config.ts [--dry-run]
 *
 *   optional: API_URL (default https://api.kinematicapp.com), PROJECT (X-Kinematic-Project, default
 *   'kinematic'), POLICY_ID (which expense policy to edit when the client has several active ones).
 *
 * The token must belong to an admin who may edit the client in Client Management (PATCH /clients/:id is
 * admin / super_admin of the org that owns the client) and the client's expense policies. VEHICLE_RATES is
 * only needed when the client has no vehicle rates yet; an existing policy's rates are kept untouched.
 */

// ── what eFocus gets ────────────────────────────────────────────────────────
/** Keep aligned with CATEGORIES in src/services/expenses/policy.service.ts (a test pins it). */
export const CATEGORIES = ['mileage', 'travel', 'food', 'lodging', 'fuel', 'toll', 'misc'] as const;
/** GPS travel (mileage) plus the common out-of-pocket categories a field rep logs. */
export const ENABLED_CATEGORIES: string[] = ['mileage', 'food', 'lodging', 'fuel', 'toll', 'misc'];

export const EXPENSE_RULES = {
  gps_distance: true,
  category_labels: { mileage: 'Travel' } as Record<string, string>,
};

export const APP_UI: Record<string, Record<string, boolean>> = {
  tabs: { expenses: true },
};

export const DEFAULT_POLICY_NAME = 'eFocus field policy';

export interface VehicleRate { label: string; rate_per_km: number }

// ── planning (pure, so it is testable) ──────────────────────────────────────
type Json = Record<string, unknown>;
const isPlain = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Key-order independent comparison, so "already up to date" survives a re-serialisation. */
export function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
    : isPlain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** VEHICLE_RATES env → a clean rates array, or [] (invalid / absent). Never throws. */
export function parseVehicleRates(raw: string | undefined): VehicleRate[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: VehicleRate[] = [];
  for (const r of parsed) {
    if (!isPlain(r)) continue;
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    const rate = Number(r.rate_per_km);
    if (label && Number.isFinite(rate) && rate >= 0) out.push({ label, rate_per_km: rate });
  }
  return out;
}

/**
 * The policy rules with eFocus's GPS-travel values laid over what the policy already has. Never mutates
 * the input. Existing vehicle rates are kept; `vehicleRates` only seeds them when the policy has none
 * (so an admin's rates set in the dashboard are never overwritten).
 */
export function planExpenseRules(existing: unknown, vehicleRates: VehicleRate[] = []): Json {
  const base: Json = isPlain(existing) ? { ...existing } : {};
  const cats: Json = isPlain(base.categories) ? (base.categories as Json) : {};
  const categories: Json = {};
  for (const c of CATEGORIES) {
    categories[c] = { ...(isPlain(cats[c]) ? (cats[c] as Json) : {}), enabled: ENABLED_CATEGORIES.includes(c) };
  }
  const existingRates = Array.isArray(base.vehicle_rates) ? (base.vehicle_rates as unknown[]) : [];
  const rates = existingRates.length ? existingRates : vehicleRates;
  const out: Json = {
    ...base,
    categories,
    gps_distance: true,
    category_labels: { ...(isPlain(base.category_labels) ? (base.category_labels as Json) : {}), ...EXPENSE_RULES.category_labels },
  };
  if (rates.length) out.vehicle_rates = rates;
  else delete out.vehicle_rates;
  return out;
}

/** True once the planned rules can actually power the check-out prompt (gps_distance + at least one vehicle). */
export function rulesCanPrompt(rules: Json): boolean {
  return rules.gps_distance === true && Array.isArray(rules.vehicle_rates) && (rules.vehicle_rates as unknown[]).length > 0;
}

export interface PolicyRef { id: string; name: string; is_active?: boolean; client_id?: string | null }
export type PolicyChoice =
  | { op: 'update'; id: string; name: string }
  | { op: 'create' }
  | { op: 'ambiguous'; names: string[] }
  | { op: 'missing'; id: string }
  | { op: 'shared'; id: string; name: string };

/**
 * Which expense policy to edit. Only a policy that belongs to THIS client is ever touched — the list also
 * carries the org-wide policies (client_id null) every client in the org is governed by, and editing one
 * of those would change the other clients too. Order: the one asked for (POLICY_ID), else ours by name,
 * else the client's only active one, else make a new one.
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

/** The app_ui object with eFocus's Expenses tab on and every other key left as it was. */
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

// ── applying it through the API ─────────────────────────────────────────────
export async function main() {
  const dry = process.argv.includes('--dry-run');
  const api = (process.env.API_URL || 'https://api.kinematicapp.com').replace(/\/$/, '');
  const token = process.env.TOKEN;
  const clientId = process.env.CLIENT_ID;
  if (!token || !clientId) {
    console.error('Set TOKEN (an admin access token) and CLIENT_ID (the eFocus client id).');
    process.exit(1);
  }
  const vehicleRates = parseVehicleRates(process.env.VEHICLE_RATES);
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

  // 1. expense policy — GPS travel + out-of-pocket categories
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
    const rules = planExpenseRules(undefined, vehicleRates);
    if (!rulesCanPrompt(rules)) {
      throw new Error('This client has no expense policy yet, so VEHICLE_RATES must be set to create one that can pay GPS travel, e.g. VEHICLE_RATES=\'[{"label":"Two-wheeler","rate_per_km":4}]\'.');
    }
    console.log(`${tag}create expense policy "${DEFAULT_POLICY_NAME}" (everyone): GPS travel ("Travel") + out-of-pocket categories`);
    // priority 10: outranks the generic org-wide policies (100) should one also apply to everyone.
    if (!dry) await call('POST', '/api/v1/expenses/policies', { name: DEFAULT_POLICY_NAME, priority: 10, applies_to: { everyone: true }, rules });
  } else {
    const current = policies.find((p) => p.id === choice.id);
    const rules = planExpenseRules(current?.rules, vehicleRates);
    if (!rulesCanPrompt(rules)) {
      throw new Error(`Expense policy "${choice.name}" has no vehicle rates, so GPS travel cannot be priced. Set VEHICLE_RATES (e.g. '[{"label":"Two-wheeler","rate_per_km":4}]') and re-run, or add the rates in the dashboard first.`);
    }
    if (sameJson(rules, current?.rules)) console.log(`expense policy "${choice.name}": already up to date`);
    else {
      console.log(`${tag}update expense policy "${choice.name}": GPS travel ("Travel") + out-of-pocket categories`);
      if (!dry) await call('PUT', `/api/v1/expenses/policies/${choice.id}`, { rules });
    }
  }

  // 2. the Expenses tab (PATCH replaces app_ui as a whole, so merge into what is there)
  const clients: any[] = (await call('GET', '/api/v1/clients'))?.data ?? [];
  const client = clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Client ${clientId} is not visible to this token (PATCH /clients/:id needs an admin of the org that owns it).`);
  const currentUi = client.settings?.app_ui;
  const appUi = planAppUi(currentUi);
  if (sameJson(appUi, currentUi)) console.log('app_ui: already up to date');
  else {
    console.log(`${tag}update app_ui: tabs.expenses=on`);
    if (!dry) await call('PATCH', `/api/v1/clients/${clientId}`, { app_ui: appUi });
  }

  console.log(dry ? 'Dry run only — nothing was changed.' : 'Done. Reload the dashboard and the apps.');
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
