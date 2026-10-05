/**
 * Expense policy engine (v2): many named policies per org/client, each with its
 * own rules and an assignment (everyone / roles / specific people).
 *
 *   - resolve:   the policy that governs a given person (most specific match wins)
 *   - evaluate:  check a claim's lines against that policy → violations
 *   - manage:    list / create / update / duplicate / delete + starter presets
 *
 * Self-gating. A project that has not run migrations/expenses_v2.sql (e.g. a
 * tenant on the legacy single-policy schema) is detected with a schema probe and
 * keeps the legacy behaviour unchanged: one policy per scope, read from the
 * original scalar columns. Everything here normalises to the same ExpensePolicy
 * shape either way, so the claim flow has a single code path.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { currentProjectKey } from '../../lib/projects';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { Actor, isApprover } from './access';

export const CATEGORIES = ['mileage', 'travel', 'food', 'lodging', 'fuel', 'toll', 'misc'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CategoryRule {
  /** false = this kind of expense is not reimbursable under the policy. */
  enabled: boolean;
  per_day_limit: number | null;
  per_claim_limit: number | null;
  per_month_limit: number | null;
  /** Receipt mandatory above this amount; null inherits the policy default. */
  receipt_required_over: number | null;
}

export interface PolicyRules {
  mileage_rate: number;
  /** Receipt mandatory for any non-mileage line above this amount. */
  receipt_required_over: number;
  max_claim_amount: number | null;
  /** Lines dated more than this many days ago are flagged as late. */
  submit_within_days: number | null;
  /** Claims at or under this amount with no violations are approved automatically. 0 = never. */
  auto_approve_under: number;
  /** Claims above this amount need the next manager up as well. */
  escalate_over: number | null;
  /** 'flag' lets a violating claim through to the approver; 'block' stops submission. */
  enforcement: 'flag' | 'block';
  categories: Record<Category, CategoryRule>;
}

export interface AppliesTo {
  everyone: boolean;
  roles: string[];
  org_role_ids: string[];
  user_ids: string[];
}

export interface ExpensePolicy {
  id?: string;
  client_id?: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
  priority: number;
  currency: string;
  applies_to: AppliesTo;
  effective_from: string | null;
  effective_to: string | null;
  rules: PolicyRules;
  updated_at?: string | null;
  /** How many active people this policy is the governing one for (list view). */
  covers?: number;
}

export interface PolicyViolation {
  code: string;
  severity: 'info' | 'warn' | 'high';
  detail: string;
  item_id?: string;
  category?: string;
  /** True when, under this policy, the claim cannot be submitted with it. */
  blocking?: boolean;
}

// ── schema probe ────────────────────────────────────────────────────────────
const probe = new Map<string, { ok: boolean; at: number }>();

/** Has this project run migrations/expenses_v2.sql? Cached per project. */
export async function hasPolicyV2(): Promise<boolean> {
  const key = currentProjectKey();
  const hit = probe.get(key);
  // A positive answer is stable; a negative one is re-checked sooner so a
  // transient DB error can't pin a project to legacy mode for long.
  if (hit && Date.now() - hit.at < (hit.ok ? 5 * 60_000 : 30_000)) return hit.ok;
  let ok = false;
  try {
    const { error } = await supabaseAdmin.from('expense_policies').select('rules').limit(1);
    ok = !error;
  } catch { ok = false; }
  probe.set(key, { ok, at: Date.now() });
  return ok;
}

// ── normalisation ───────────────────────────────────────────────────────────
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const numOr = (v: unknown, d: number): number => numOrNull(v) ?? d;
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.map((x) => String(x).trim()).filter(Boolean))) : [];
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function normalizeApplies(raw: any): AppliesTo {
  const a = raw && typeof raw === 'object' ? raw : {};
  // Lowercase first, then de-duplicate, so "Supervisor" and "supervisor" are one role.
  const roles = Array.from(new Set(strArr(a.roles).map((r) => r.toLowerCase())));
  const org_role_ids = strArr(a.org_role_ids);
  const user_ids = strArr(a.user_ids);
  // An empty selection means everyone — a policy must apply to somebody.
  const everyone = a.everyone === true || (!roles.length && !org_role_ids.length && !user_ids.length);
  return { everyone, roles, org_role_ids, user_ids };
}

/** Fill every field with a sane value. `legacy` is an original-schema row whose
 *  scalar columns seed the rules when the rules column is empty. */
export function normalizeRules(raw: any, legacy?: any): PolicyRules {
  const r = raw && typeof raw === 'object' ? raw : {};
  const legacyLimits = (legacy?.category_limits && typeof legacy.category_limits === 'object') ? legacy.category_limits : {};
  const categories = {} as Record<Category, CategoryRule>;
  for (const c of CATEGORIES) {
    const cr = (r.categories && typeof r.categories === 'object' ? r.categories[c] : null) || {};
    categories[c] = {
      enabled: cr.enabled !== false,
      per_day_limit: numOrNull(cr.per_day_limit ?? legacyLimits[c]),
      per_claim_limit: numOrNull(cr.per_claim_limit),
      per_month_limit: numOrNull(cr.per_month_limit),
      receipt_required_over: numOrNull(cr.receipt_required_over),
    };
  }
  return {
    mileage_rate: numOr(r.mileage_rate ?? legacy?.mileage_rate, 12),
    receipt_required_over: numOr(r.receipt_required_over ?? legacy?.require_receipt_over, 500),
    max_claim_amount: numOrNull(r.max_claim_amount),
    submit_within_days: (() => { const n = numOrNull(r.submit_within_days); return n == null ? null : Math.round(n); })(),
    auto_approve_under: numOr(r.auto_approve_under ?? legacy?.auto_approve_under, 0),
    escalate_over: numOrNull(r.escalate_over ?? legacy?.escalate_over),
    enforcement: r.enforcement === 'block' ? 'block' : 'flag',
    categories,
  };
}

function rowToPolicy(row: any): ExpensePolicy {
  const hasRules = row.rules && typeof row.rules === 'object' && Object.keys(row.rules).length > 0;
  return {
    id: row.id,
    client_id: row.client_id ?? null,
    name: row.name || 'Expense policy',
    description: row.description ?? null,
    is_active: row.is_active !== false,
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100,
    currency: row.currency || 'INR',
    applies_to: normalizeApplies(row.applies_to),
    effective_from: row.effective_from ?? null,
    effective_to: row.effective_to ?? null,
    rules: normalizeRules(hasRules ? row.rules : {}, hasRules ? undefined : row),
    updated_at: row.updated_at ?? null,
  };
}

/** Used when an org has configured nothing at all. */
export const BUILT_IN_POLICY: ExpensePolicy = {
  name: 'Standard policy (built-in)',
  description: null,
  is_active: true,
  priority: 1000,
  currency: 'INR',
  applies_to: { everyone: true, roles: [], org_role_ids: [], user_ids: [] },
  effective_from: null,
  effective_to: null,
  rules: normalizeRules({}),
};

/**
 * The shape the mobile apps already parse from GET /expenses/policy — the scalar
 * fields they know, plus the new ones (ignored by older builds).
 */
export function toClientShape(p: ExpensePolicy) {
  const category_limits: Record<string, number> = {};
  for (const c of CATEGORIES) {
    const lim = p.rules.categories[c].per_day_limit;
    if (lim != null) category_limits[c] = lim;
  }
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    currency: p.currency,
    mileage_rate: p.rules.mileage_rate,
    auto_approve_under: p.rules.auto_approve_under,
    escalate_over: p.rules.escalate_over,
    require_receipt_over: p.rules.receipt_required_over,
    category_limits: Object.keys(category_limits).length ? category_limits : null,
    is_active: p.is_active,
    rules: p.rules,
  };
}

// ── resolution ──────────────────────────────────────────────────────────────
export interface PolicyUser { id: string; role?: string | null; org_role_id?: string | null }

/** 3 = named person, 2 = their role, 1 = everyone, 0 = does not apply. */
function specificity(p: ExpensePolicy, u: PolicyUser): number {
  const a = p.applies_to;
  if (u.id && a.user_ids.includes(u.id)) return 3;
  const role = (u.role ?? '').toLowerCase();
  if ((u.org_role_id && a.org_role_ids.includes(u.org_role_id)) || (role && a.roles.includes(role))) return 2;
  return a.everyone ? 1 : 0;
}

export function pickPolicy(policies: ExpensePolicy[], u: PolicyUser): ExpensePolicy | null {
  let best: { p: ExpensePolicy; s: number } | null = null;
  for (const p of policies) {
    const s = specificity(p, u);
    if (!s) continue;
    if (!best || s > best.s
      || (s === best.s && p.priority < best.p.priority)
      || (s === best.s && p.priority === best.p.priority && String(p.updated_at ?? '') > String(best.p.updated_at ?? ''))) {
      best = { p, s };
    }
  }
  return best?.p ?? null;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

async function fetchLive(org_id: string, client_id: string | null): Promise<ExpensePolicy[]> {
  let q = supabaseAdmin.from('expense_policies').select('*').eq('org_id', org_id).eq('is_active', true);
  q = q.is('deleted_at', null);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  const today = todayIso();
  return ((data as any[]) ?? [])
    .filter((r) => !r.client_id || (client_id && r.client_id === client_id))
    .filter((r) => (!r.effective_from || String(r.effective_from) <= today) && (!r.effective_to || String(r.effective_to) >= today))
    .map(rowToPolicy);
}

/** Legacy (pre-v2) read: the client-scoped row if present, else the org-level one. */
async function legacyPolicy(org_id: string, client_id: string | null): Promise<ExpensePolicy> {
  const { data } = await supabaseAdmin.from('expense_policies').select('*').eq('org_id', org_id).eq('is_active', true);
  const rows = (data as any[]) || [];
  const row = rows.find((r) => r.client_id && r.client_id === client_id) || rows.find((r) => !r.client_id);
  if (!row) return { ...BUILT_IN_POLICY };
  return { ...rowToPolicy({ ...row, rules: {}, name: 'Expense policy' }) };
}

/** The policy that governs `user`. Never throws for "no policy" — falls back to built-ins. */
export async function resolvePolicy(org_id: string, client_id: string | null, user: PolicyUser): Promise<ExpensePolicy> {
  if (!(await hasPolicyV2())) return legacyPolicy(org_id, client_id);
  const live = await fetchLive(org_id, client_id);
  return pickPolicy(live, user) ?? { ...BUILT_IN_POLICY };
}

/** Role + RBAC role of a person, for resolution. */
export async function policyUserOf(user_id: string): Promise<PolicyUser> {
  const { data } = await supabaseAdmin.from('users').select('id, role, org_role_id').eq('id', user_id).maybeSingle();
  const u = data as any;
  return { id: user_id, role: u?.role ?? null, org_role_id: u?.org_role_id ?? null };
}

export async function resolvePolicyForUserId(org_id: string, client_id: string | null, user_id: string): Promise<ExpensePolicy> {
  return resolvePolicy(org_id, client_id, await policyUserOf(user_id));
}

// ── evaluation ──────────────────────────────────────────────────────────────
const money = (cur: string, n: number) => `${cur} ${Number(n).toFixed(0)}`;
const monthOf = (d: unknown) => String(d ?? '').slice(0, 7);

export interface EvalOptions {
  today?: string;
  /** Already-claimed spend this month from the person's other live claims: key `${category}|${YYYY-MM}`. */
  priorMonthSpend?: Record<string, number>;
}

/** Pure rule check of a claim's lines against a policy. */
export function evaluateAgainstPolicy(
  policy: ExpensePolicy, items: any[], opts: EvalOptions = {},
): { violations: PolicyViolation[]; flaggedItemIds: Record<string, string> } {
  const R = policy.rules;
  const cur = policy.currency;
  const today = opts.today ?? todayIso();
  const enforce = R.enforcement === 'block';
  const violations: PolicyViolation[] = [];
  const flagged: Record<string, string> = {};
  const add = (v: PolicyViolation, alwaysBlock = false) => {
    v.blocking = alwaysBlock || (enforce && v.severity !== 'info');
    violations.push(v);
    if (v.item_id && !flagged[v.item_id]) flagged[v.item_id] = v.detail;
  };

  // 1. Categories the policy does not reimburse.
  for (const it of items) {
    const c = it.category as Category;
    if (CATEGORIES.includes(c) && R.categories[c].enabled === false) {
      add({ code: 'category_not_allowed', severity: 'high', category: c, item_id: it.id,
        detail: `${c} expenses are not reimbursable under "${policy.name}".` }, true);
    }
  }

  // 2. Receipt required.
  for (const it of items) {
    if (it.category === 'mileage') continue;
    const c = it.category as Category;
    const over = R.categories[c]?.receipt_required_over ?? R.receipt_required_over;
    if (Number(it.amount) > over && !it.receipt_url) {
      add({ code: 'receipt_missing', severity: 'warn', category: c, item_id: it.id,
        detail: `Missing receipt for ${c} of ${money(cur, it.amount)} (required over ${money(cur, over)}).` });
    }
  }

  // 3. Per-day, per-claim and per-month caps.
  type Agg = Map<string, { sum: number; ids: string[] }>;
  const day: Agg = new Map();
  const claimTotals: Agg = new Map();
  const month: Agg = new Map();
  const bump = (m: Agg, key: string, amt: number, id: string) => {
    const agg = m.get(key) || { sum: 0, ids: [] };
    agg.sum += amt; agg.ids.push(id);
    m.set(key, agg);
  };
  for (const it of items) {
    const c = it.category as Category;
    if (!CATEGORIES.includes(c)) continue;
    const amt = Number(it.amount || 0);
    bump(day, `${c}|${String(it.item_date || '').slice(0, 10)}`, amt, it.id);
    bump(claimTotals, c, amt, it.id);
    bump(month, `${c}|${monthOf(it.item_date)}`, amt, it.id);
  }
  const spread = (ids: string[], detail: string) => { for (const id of ids) if (!flagged[id]) flagged[id] = detail; };
  for (const [key, agg] of day) {
    const c = key.split('|')[0] as Category;
    const cap = R.categories[c]?.per_day_limit;
    if (cap != null && agg.sum > cap) {
      const detail = `${c} spend ${money(cur, agg.sum)} exceeds the per-day cap of ${money(cur, cap)}.`;
      add({ code: 'over_category_limit', severity: 'warn', category: c, detail });
      spread(agg.ids, detail);
    }
  }
  for (const [c, agg] of claimTotals) {
    const cap = R.categories[c as Category]?.per_claim_limit;
    if (cap != null && agg.sum > cap) {
      const detail = `${c} total ${money(cur, agg.sum)} exceeds the per-claim cap of ${money(cur, cap)}.`;
      add({ code: 'over_claim_category_limit', severity: 'warn', category: c, detail });
      spread(agg.ids, detail);
    }
  }
  for (const [key, agg] of month) {
    const [c, ym] = key.split('|');
    const cap = R.categories[c as Category]?.per_month_limit;
    if (cap == null) continue;
    const total = agg.sum + (opts.priorMonthSpend?.[key] ?? 0);
    if (total > cap) {
      const detail = `${c} spend for ${ym} would reach ${money(cur, total)}, over the monthly budget of ${money(cur, cap)}.`;
      add({ code: 'over_month_limit', severity: 'warn', category: c, detail });
      spread(agg.ids, detail);
    }
  }

  // 4. Whole-claim cap.
  const total = items.reduce((s, it) => s + Number(it.amount || 0), 0);
  if (R.max_claim_amount != null && total > R.max_claim_amount) {
    add({ code: 'over_claim_limit', severity: 'warn',
      detail: `Claim total ${money(cur, total)} exceeds the policy maximum of ${money(cur, R.max_claim_amount)} per claim.` });
  }

  // 5. Dates: late submission and future-dated lines.
  for (const it of items) {
    const d = String(it.item_date || '').slice(0, 10);
    if (!d) continue;
    if (d > today) {
      add({ code: 'future_date', severity: 'warn', item_id: it.id, category: it.category,
        detail: `${it.category} line is dated in the future (${d}).` });
    } else if (R.submit_within_days != null) {
      const ageDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000);
      if (ageDays > R.submit_within_days) {
        add({ code: 'late_submission', severity: 'warn', item_id: it.id, category: it.category,
          detail: `${it.category} line from ${d} is ${ageDays} days old (policy: claim within ${R.submit_within_days} days).` });
      }
    }
  }

  return { violations, flaggedItemIds: flagged };
}

/** Eligible for automatic approval: under the threshold and nothing to review. */
export function canAutoApprove(policy: ExpensePolicy, total: number, violations: PolicyViolation[]): boolean {
  const under = policy.rules.auto_approve_under;
  if (!(under > 0) || total > under) return false;
  return !violations.some((v) => v.severity === 'warn' || v.severity === 'high');
}

// ── management (v2 only) ────────────────────────────────────────────────────
async function requireV2(): Promise<void> {
  if (!(await hasPolicyV2())) {
    throw new AppError(409, 'Multiple expense policies are not enabled for this workspace yet', 'POLICY_V2_UNAVAILABLE');
  }
}
function requireAdmin(actor: Actor) {
  if (!isApprover(actor)) throw new AppError(403, 'Only an admin can manage expense policies', 'FORBIDDEN');
}

export interface PolicyInput {
  name?: string;
  description?: string | null;
  is_active?: boolean;
  priority?: number;
  currency?: string;
  applies_to?: Partial<AppliesTo>;
  effective_from?: string | null;
  effective_to?: string | null;
  rules?: any;
}

function toRow(actor: Actor, body: PolicyInput, existing?: ExpensePolicy) {
  const name = (body.name ?? existing?.name ?? '').toString().trim();
  if (!name) throw new AppError(400, 'Give the policy a name', 'VALIDATION');
  if (name.length > 80) throw new AppError(400, 'Policy name is too long (80 characters max)', 'VALIDATION');
  const rules = normalizeRules(body.rules ?? existing?.rules);
  const applies = normalizeApplies(body.applies_to ?? existing?.applies_to);
  const from = body.effective_from !== undefined ? body.effective_from : existing?.effective_from ?? null;
  const to = body.effective_to !== undefined ? body.effective_to : existing?.effective_to ?? null;
  if (from && to && from > to) throw new AppError(400, 'The end date is before the start date', 'VALIDATION');
  const categoryLimits: Record<string, number> = {};
  for (const c of CATEGORIES) { const l = rules.categories[c].per_day_limit; if (l != null) categoryLimits[c] = l; }
  return {
    name,
    description: body.description !== undefined ? (body.description?.toString().trim() || null) : existing?.description ?? null,
    is_active: body.is_active ?? existing?.is_active ?? true,
    priority: Math.min(1000, Math.max(1, Math.round(Number(body.priority ?? existing?.priority ?? 100)))),
    currency: (body.currency ?? existing?.currency ?? 'INR').toString().slice(0, 8) || 'INR',
    applies_to: applies,
    effective_from: from || null,
    effective_to: to || null,
    rules,
    // Mirror the headline numbers into the legacy columns so older readers agree.
    mileage_rate: rules.mileage_rate,
    auto_approve_under: rules.auto_approve_under,
    escalate_over: rules.escalate_over,
    require_receipt_over: rules.receipt_required_over,
    category_limits: Object.keys(categoryLimits).length ? categoryLimits : null,
    updated_by: actor.id,
    updated_at: new Date().toISOString(),
  };
}

const isDup = (e: { code?: string; message?: string } | null) => !!e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));

/** Everyone the actor's policies could apply to, for coverage counts. */
async function peopleInScope(org_id: string, client_id: string | null): Promise<PolicyUser[]> {
  let q = supabaseAdmin.from('users').select('id, role, org_role_id, client_id').eq('org_id', org_id).eq('is_active', true).limit(5000);
  if (client_id) q = q.or(`client_id.eq.${client_id},client_id.is.null`);
  const { data } = await q;
  return ((data as any[]) ?? []).map((u) => ({ id: u.id, role: u.role, org_role_id: u.org_role_id }));
}

export async function listPolicies(actor: Actor): Promise<ExpensePolicy[]> {
  await requireV2();
  let q = supabaseAdmin.from('expense_policies').select('*').eq('org_id', actor.org_id).is('deleted_at', null);
  if (actor.client_id) q = q.or(`client_id.eq.${actor.client_id},client_id.is.null`);
  const { data, error } = await q.order('priority', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw new AppError(500, error.message, 'DB');
  const all = ((data as any[]) ?? []).map(rowToPolicy);

  // Coverage: who each policy actually governs (the winner for that person).
  const live = all.filter((p) => p.is_active);
  const people = await peopleInScope(actor.org_id, actor.client_id ?? null);
  const counts = new Map<string, number>();
  for (const u of people) {
    const win = pickPolicy(live, u);
    if (win?.id) counts.set(win.id, (counts.get(win.id) ?? 0) + 1);
  }
  return all.map((p) => ({ ...p, covers: counts.get(p.id as string) ?? 0 }));
}

/**
 * Names for the people a policy is assigned to, so the editor can show who they
 * are (the policy itself only stores ids). A person who has since been removed
 * still appears, so an admin can see and clear the stale assignment.
 */
export async function attachPeopleNames<T extends ExpensePolicy>(actor: Actor, list: T[]): Promise<Array<T & { people: Array<{ id: string; name: string }> }>> {
  const ids = Array.from(new Set(list.flatMap((p) => p.applies_to.user_ids))).slice(0, 1000);
  const names = new Map<string, string>();
  if (ids.length) {
    const { data } = await supabaseAdmin.from('users').select('id, name').eq('org_id', actor.org_id).in('id', ids);
    for (const u of (data as any[]) ?? []) names.set(u.id, u.name);
  }
  return list.map((p) => ({ ...p, people: p.applies_to.user_ids.map((id) => ({ id, name: names.get(id) ?? 'Removed user' })) }));
}

export async function getPolicyById(actor: Actor, id: string): Promise<ExpensePolicy> {
  await requireV2();
  const { data } = await supabaseAdmin.from('expense_policies').select('*')
    .eq('org_id', actor.org_id).eq('id', id).is('deleted_at', null).maybeSingle();
  if (!data) throw new AppError(404, 'Policy not found', 'NOT_FOUND');
  return rowToPolicy(data);
}

export async function createPolicy(actor: Actor, body: PolicyInput): Promise<ExpensePolicy> {
  await requireV2(); requireAdmin(actor);
  const row = { ...toRow(actor, body), org_id: actor.org_id, client_id: actor.client_id ?? null, created_by: actor.id };
  const { data, error } = await supabaseAdmin.from('expense_policies').insert(row).select('*').single();
  if (error) {
    if (isDup(error)) throw new AppError(409, `A policy named "${row.name}" already exists`, 'DUPLICATE_NAME');
    throw new AppError(500, error.message, 'DB');
  }
  return rowToPolicy(data);
}

export async function updatePolicy(actor: Actor, id: string, body: PolicyInput): Promise<ExpensePolicy> {
  await requireV2(); requireAdmin(actor);
  const existing = await getPolicyById(actor, id);
  const row = toRow(actor, body, existing);
  const { data, error } = await supabaseAdmin.from('expense_policies').update(row)
    .eq('org_id', actor.org_id).eq('id', id).select('*').single();
  if (error) {
    if (isDup(error)) throw new AppError(409, `A policy named "${row.name}" already exists`, 'DUPLICATE_NAME');
    throw new AppError(500, error.message, 'DB');
  }
  return rowToPolicy(data);
}

/** Soft delete. Claims already filed keep their frozen snapshot, so history is unaffected. */
export async function deletePolicy(actor: Actor, id: string): Promise<{ id: string }> {
  await requireV2(); requireAdmin(actor);
  await getPolicyById(actor, id);
  const { error } = await supabaseAdmin.from('expense_policies')
    .update({ deleted_at: new Date().toISOString(), is_active: false, updated_by: actor.id })
    .eq('org_id', actor.org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB');
  return { id };
}

export async function duplicatePolicy(actor: Actor, id: string): Promise<ExpensePolicy> {
  await requireV2(); requireAdmin(actor);
  const src = await getPolicyById(actor, id);
  const { data } = await supabaseAdmin.from('expense_policies').select('name')
    .eq('org_id', actor.org_id).is('deleted_at', null);
  const taken = new Set(((data as any[]) ?? []).map((r) => String(r.name).toLowerCase()));
  let name = `${src.name} (copy)`;
  for (let n = 2; taken.has(name.toLowerCase()) && n < 50; n++) name = `${src.name} (copy ${n})`;
  // A copy starts inactive so duplicating can never silently change who is governed by what.
  return createPolicy(actor, { ...src, name, is_active: false });
}

// ── helpers for the policy editor ───────────────────────────────────────────
export async function policyPeople(actor: Actor, q: string) {
  requireAdmin(actor);
  const term = q.replace(/[^\w\s@.\-]/g, '').trim();
  let query = supabaseAdmin.from('users').select('id, name, employee_id, role, email')
    .eq('org_id', actor.org_id).eq('is_active', true).order('name', { ascending: true }).limit(20);
  if (actor.client_id) query = query.or(`client_id.eq.${actor.client_id},client_id.is.null`);
  if (term) query = query.or(`name.ilike.%${term}%,employee_id.ilike.%${term}%,email.ilike.%${term}%`);
  const { data, error } = await query;
  if (error) throw new AppError(500, error.message, 'DB');
  return data ?? [];
}

export async function policyRoles(actor: Actor) {
  requireAdmin(actor);
  const out: { legacy: Array<{ role: string; people: number }>; org_roles: Array<{ id: string; name: string }> } = { legacy: [], org_roles: [] };
  try {
    let q = supabaseAdmin.from('users').select('role').eq('org_id', actor.org_id).eq('is_active', true).limit(5000);
    if (actor.client_id) q = q.or(`client_id.eq.${actor.client_id},client_id.is.null`);
    const { data } = await q;
    const counts = new Map<string, number>();
    for (const u of (data as any[]) ?? []) if (u.role) counts.set(String(u.role).toLowerCase(), (counts.get(String(u.role).toLowerCase()) ?? 0) + 1);
    out.legacy = Array.from(counts.entries()).map(([role, people]) => ({ role, people })).sort((a, b) => b.people - a.people);
  } catch (e: any) { logger.warn(`[expenses] policyRoles users failed: ${e?.message || e}`); }
  try {
    const { data } = await supabaseAdmin.from('org_roles').select('id, name').eq('org_id', actor.org_id).order('name', { ascending: true });
    out.org_roles = ((data as any[]) ?? []).map((r) => ({ id: r.id, name: r.name }));
  } catch (e: any) { logger.warn(`[expenses] policyRoles org_roles failed: ${e?.message || e}`); }
  return out;
}

// ── starter presets ─────────────────────────────────────────────────────────
export interface PolicyPreset { key: string; name: string; description: string; rules: PolicyRules }

const caps = (o: Partial<Record<Category, Partial<CategoryRule>>>) => {
  const c = normalizeRules({}).categories;
  for (const k of Object.keys(o) as Category[]) c[k] = { ...c[k], ...o[k] };
  return c;
};

export function policyPresets(): PolicyPreset[] {
  const base = (over: Partial<PolicyRules>): PolicyRules => ({ ...normalizeRules({}), ...over });
  return [
    {
      key: 'field_rep', name: 'Field sales rep',
      description: 'Everyday travel and meals for people on the road. Receipts over ₹500, daily caps on food, lodging and fuel.',
      rules: base({
        mileage_rate: 12, receipt_required_over: 500, escalate_over: 10000, submit_within_days: 30,
        categories: caps({ food: { per_day_limit: 500 }, lodging: { per_day_limit: 3000 }, fuel: { per_day_limit: 1500 },
          travel: { per_day_limit: 2000 }, toll: { per_day_limit: 500 }, misc: { per_day_limit: 300 } }),
      }),
    },
    {
      key: 'manager', name: 'Manager',
      description: 'Higher limits for team leads and managers. Larger claims go one level up.',
      rules: base({
        mileage_rate: 14, receipt_required_over: 1000, escalate_over: 25000, submit_within_days: 45,
        categories: caps({ food: { per_day_limit: 1200 }, lodging: { per_day_limit: 6000 }, fuel: { per_day_limit: 3000 },
          travel: { per_day_limit: 5000 }, toll: { per_day_limit: 1000 }, misc: { per_day_limit: 1000 } }),
      }),
    },
    {
      key: 'leadership', name: 'Leadership',
      description: 'No category caps. A receipt is needed for anything over ₹2,000.',
      rules: base({ mileage_rate: 16, receipt_required_over: 2000, escalate_over: null, submit_within_days: 60 }),
    },
    {
      key: 'strict', name: 'Strict — block on violation',
      description: 'A receipt for every expense, and a claim that breaks a rule cannot be submitted at all.',
      rules: base({
        mileage_rate: 12, receipt_required_over: 0, enforcement: 'block', submit_within_days: 15,
        categories: caps({ food: { per_day_limit: 400 }, lodging: { per_day_limit: 2500 }, fuel: { per_day_limit: 1200 },
          travel: { per_day_limit: 1500 }, toll: { per_day_limit: 400 }, misc: { per_day_limit: 200 } }),
      }),
    },
    {
      key: 'fast_track', name: 'Small claims fast-track',
      description: 'Claims up to ₹1,000 with nothing flagged are approved automatically.',
      rules: base({ auto_approve_under: 1000, receipt_required_over: 500, submit_within_days: 30 }),
    },
    {
      key: 'blank', name: 'Start from scratch',
      description: 'Sensible defaults with no category caps — set your own rules.',
      rules: base({}),
    },
  ];
}

/** Prior-month spend by category for a person's other live claims (for monthly budgets). */
export async function priorMonthSpend(org_id: string, user_id: string, excludeClaimId: string, months: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!months.length) return out;
  const { data: claims } = await supabaseAdmin.from('expense_claims').select('id')
    .eq('org_id', org_id).eq('user_id', user_id).in('status', ['submitted', 'approved', 'reimbursed']).neq('id', excludeClaimId).limit(500);
  const ids = ((claims as any[]) ?? []).map((c) => c.id);
  if (!ids.length) return out;
  const sorted = [...months].sort();
  const first = `${sorted[0]}-01`;
  const lastMonth = sorted[sorted.length - 1];
  const [y, m] = lastMonth.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // first day of the next month
  const { data: items } = await supabaseAdmin.from('expense_claim_items')
    .select('category, amount, item_date, decision').in('claim_id', ids).gte('item_date', first).lt('item_date', end);
  for (const it of (items as any[]) ?? []) {
    if (it.decision === 'rejected') continue;
    const key = `${it.category}|${monthOf(it.item_date)}`;
    out[key] = round2((out[key] ?? 0) + Number(it.amount || 0));
  }
  return out;
}
