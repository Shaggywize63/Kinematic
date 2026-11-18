/**
 * Sales / Collection rupee targets (Agrisynx).
 *
 * A client opts in with `crm_settings.config.targets.types` (sales and / or collection); with nothing
 * configured every function here reports "off" and the existing per-FE lead targets are untouched.
 *
 *   - a TARGET is an ordinary crm_targets row with metric sales_amount / collection_amount and period
 *     'monthly' (a whole-rupee integer), resolved user > role > level > default exactly like the lead target;
 *   - an ENTRY is one order / payment a rep logged in the app (crm_target_entries, see
 *     migrations/crm_target_entries.sql). Progress is the running total of the entries dated inside the
 *     current calendar month in IST, so a 23:30 IST entry on the 31st counts to that month and one at
 *     00:30 IST the next morning counts to the next — whatever the server clock's timezone.
 *
 * Before the migration has run, logging an entry answers 409 TARGET_ENTRIES_NOT_ENABLED, progress reports
 * achieved 0 and the history is empty.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { currentProjectKey } from '../../lib/projects';
import { AppError } from '../../utils';
import { Actor, isApprover } from '../expenses/access';
import { loadCrmConfig } from './leadFormConfig';
import { leaderboardUsers, TargetSpec } from './targets.service';
import { stampLinkedEntityNames } from './owners.helper';

export type TargetKind = 'sales' | 'collection';
export const TARGET_KINDS: readonly TargetKind[] = ['sales', 'collection'];
export type TargetSource = 'user' | 'role' | 'level' | 'default';

export const TARGET_PERIOD = 'monthly';
export const TARGET_UNIT = 'INR';
export const MAX_TARGET_VALUE = 1_000_000_000;     // also the per-entry cap
export const MAX_BACKDATE_DAYS = 31;
export const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ENTRIES_DEFAULT_LIMIT = 50;
export const ENTRIES_MAX_LIMIT = 200;
export const TARGET_LABEL_MAX = 40;

const METRIC: Record<TargetKind, string> = { sales: 'sales_amount', collection: 'collection_amount' };
const DEFAULT_LABEL: Record<TargetKind, string> = { sales: 'Sales target', collection: 'Collection target' };
const IST_MIN = 330;

export interface TargetType { key: TargetKind; label: string; metric: string; period: 'monthly'; unit: 'INR' }

// ── config ──────────────────────────────────────────────────────────────────
/** `config.targets` -> the types the client enabled, cleaned: known keys only, once each, a usable label. */
export function normalizeTargetTypes(targetsConfig: unknown): TargetType[] {
  const raw = targetsConfig && typeof targetsConfig === 'object' ? (targetsConfig as { types?: unknown }).types : null;
  if (!Array.isArray(raw)) return [];
  const out: TargetType[] = [];
  for (const t of raw) {
    const key = t && typeof t === 'object' ? (t as { key?: unknown }).key : null;
    if (!(TARGET_KINDS as readonly unknown[]).includes(key) || out.some((o) => o.key === key)) continue;
    const label = typeof (t as { label?: unknown }).label === 'string' ? ((t as { label: string }).label).trim().slice(0, TARGET_LABEL_MAX).trim() : '';
    out.push({ key: key as TargetKind, label: label || DEFAULT_LABEL[key as TargetKind], metric: METRIC[key as TargetKind], period: TARGET_PERIOD, unit: TARGET_UNIT });
  }
  return out;
}

/** The target types enabled for this client; [] = the feature is off. */
export async function loadTargetTypes(org_id: string, client_id: string | null): Promise<TargetType[]> {
  const cfg = await loadCrmConfig(org_id, client_id);
  return normalizeTargetTypes(cfg?.targets);
}

/**
 * The `type` a request asked for. Absent / empty = undefined = today's lead target, untouched. Anything
 * else must be one of the client's enabled types, otherwise 400 TARGET_TYPE_NOT_ENABLED.
 */
export async function resolveTargetType(org_id: string, client_id: string | null, raw: unknown): Promise<{ type: TargetType; spec: TargetSpec } | undefined> {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const type = (await loadTargetTypes(org_id, client_id)).find((t) => t.key === raw);
  if (!type) throw new AppError(400, `The "${String(raw).slice(0, 40)}" target is not enabled for this client`, 'TARGET_TYPE_NOT_ENABLED');
  return { type, spec: { metric: type.metric, period: type.period } };
}

/** A target value from an admin: a non-negative number up to MAX_TARGET_VALUE, floored to whole rupees. */
export function parseTargetValue(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_TARGET_VALUE) {
    throw new AppError(400, `target_value must be a number from 0 to ${MAX_TARGET_VALUE.toLocaleString('en-US')}`, 'VALIDATION');
  }
  return Math.floor(n);
}

// ── IST calendar ────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');

/** Today's date in IST (YYYY-MM-DD). The server's own timezone never enters into it. */
export function istDate(now: number = Date.now()): string {
  const d = new Date(now + IST_MIN * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** First and last day (YYYY-MM-DD) of the IST calendar month containing `now`. */
export function istMonth(now: number = Date.now()): { start: string; end: string } {
  const d = new Date(now + IST_MIN * 60000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}` };
}

export function addDays(date: string, days: number): string {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A real calendar date in YYYY-MM-DD form (not 2026-02-31). */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// ── schema probe ────────────────────────────────────────────────────────────
const probe = new Map<string, { ok: boolean; at: number }>();

/**
 * Has this database run migrations/crm_target_entries.sql? Cached per project (a negative answer is
 * re-checked sooner, so a transient error cannot pin a project to "not enabled" for long).
 */
export async function hasTargetEntries(): Promise<boolean> {
  const key = currentProjectKey();
  const hit = probe.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? 5 * 60_000 : 30_000)) return hit.ok;
  let ok = false;
  try {
    const { error } = await supabaseAdmin.from('crm_target_entries').select('id').limit(1);
    ok = !error;
  } catch { ok = false; }
  probe.set(key, { ok, at: Date.now() });
  return ok;
}

/** Test seam: forget the cached answer. */
export function _resetTargetEntriesProbe(): void { probe.clear(); }

// ── target resolution ───────────────────────────────────────────────────────
export interface TargetRowLite {
  user_id: string | null; org_role_id: string | null; hierarchy_level_id: string | null; client_id: string | null; target_value: number | string | null;
}
const SOURCE_BY_SCORE: Record<number, TargetSource> = { 4: 'user', 3: 'role', 2: 'level', 1: 'default' };

/**
 * A person's target: user > org role > hierarchy level > default, and within a scope the client's own row
 * beats an org-wide one (client_id null) — the same scoring the lead target uses. A winning row of 0 means
 * "no target" (so a 0 on a person clears the role's target for them).
 */
export function resolveTarget(
  rows: TargetRowLite[],
  who: { user_id: string; org_role_id?: string | null; hierarchy_level_id?: string | null },
  client_id: string | null,
): { target: number | null; source: TargetSource | null } {
  let best: TargetRowLite | null = null;
  let bestScore = -1;
  let bestSource: TargetSource | null = null;
  for (const r of rows) {
    const own = !!client_id && r.client_id === client_id;
    if (!own && r.client_id !== null) continue;
    const bonus = own ? 0.5 : 0;
    let s = -1;
    if (r.user_id === who.user_id) s = 4;
    else if (r.user_id === null && r.org_role_id && r.org_role_id === who.org_role_id) s = 3;
    else if (r.user_id === null && r.hierarchy_level_id && r.hierarchy_level_id === who.hierarchy_level_id) s = 2;
    else if (r.user_id === null && r.org_role_id === null && r.hierarchy_level_id === null) s = 1;
    if (s < 0) continue;
    if (s + bonus > bestScore) { bestScore = s + bonus; best = r; bestSource = SOURCE_BY_SCORE[s]; }
  }
  const value = best ? Number(best.target_value) : 0;
  return value > 0 ? { target: value, source: bestSource } : { target: null, source: null };
}

const pctOf = (achieved: number, target: number | null) => (target && target > 0 ? Math.round((achieved / target) * 100) : null);
const toCents = (amount: unknown) => Math.round(Number(amount || 0) * 100);

/** Sum of entry amounts in rupees, added in whole paise so floating point never drifts. */
export function sumRupees(rows: Array<{ amount?: unknown }>): number {
  return rows.reduce((s, r) => s + toCents(r.amount), 0) / 100;
}

// ── achievement basis (per-client) ───────────────────────────────────────────
/**
 * How a client's SALES target is scored: the running total of manually-logged
 * entries (`manual`, the default — unchanged for every existing client incl.
 * Tata), or the sum of WON crm_deals in the period (`won_deals`). Opt-in via
 * `crm_settings.config.targets.achievement_basis`. Anything but the literal
 * 'won_deals' resolves to 'manual', so a missing/garbled value is safe.
 * Applies ONLY to the `sales` type; `collection` is always manual.
 */
export type AchievementBasis = 'manual' | 'won_deals';
export async function resolveAchievementBasis(org_id: string, client_id: string | null): Promise<AchievementBasis> {
  const cfg = await loadCrmConfig(org_id, client_id);
  const raw = cfg && typeof cfg === 'object'
    ? (cfg as { targets?: { achievement_basis?: unknown } }).targets?.achievement_basis
    : null;
  return raw === 'won_deals' ? 'won_deals' : 'manual';
}

/**
 * Won-deal sales value + count per owner in [from, to] (YYYY-MM-DD, inclusive on
 * `actual_close_date`). Mirrors leaderboard.service's won definition: a deal whose
 * joined stage is `won`. Summed in whole paise so rupee totals never drift.
 * `ownerIds` null/empty = every owner.
 */
export async function wonSalesByOwner(
  org_id: string, client_id: string | null, ownerIds: string[] | null, from: string, to: string,
): Promise<Map<string, { value: number; count: number }>> {
  let q = supabaseAdmin.from('crm_deals')
    .select('owner_id, amount, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).is('deleted_at', null)
    .not('actual_close_date', 'is', null)
    .gte('actual_close_date', from).lte('actual_close_date', to)
    .eq('crm_deal_stages.stage_type', 'won')
    .range(0, 99999);
  if (client_id) q = q.eq('client_id', client_id);
  if (ownerIds && ownerIds.length) q = q.in('owner_id', ownerIds);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const cents = new Map<string, { c: number; count: number }>();
  for (const r of (data ?? []) as Array<{ owner_id: string | null; amount: unknown }>) {
    if (!r.owner_id) continue;
    const e = cents.get(r.owner_id) ?? { c: 0, count: 0 };
    e.c += toCents(r.amount); e.count += 1;
    cents.set(r.owner_id, e);
  }
  return new Map(Array.from(cents, ([k, v]) => [k, { value: v.c / 100, count: v.count }]));
}

// ── progress ────────────────────────────────────────────────────────────────
/** Entries (kind, user, amount) counting towards the month, optionally for one user. Empty before the migration. */
async function monthEntries(
  org_id: string, client_id: string | null, kinds: TargetKind[], month: { start: string; end: string }, user_id?: string,
): Promise<Array<{ kind: TargetKind; user_id: string; amount: number }>> {
  if (!kinds.length || !(await hasTargetEntries())) return [];
  let q = supabaseAdmin.from('crm_target_entries').select('kind, user_id, amount')
    .eq('org_id', org_id).is('deleted_at', null).in('kind', kinds)
    .gte('entry_date', month.start).lte('entry_date', month.end)
    // lift the 1000-row cap: the board sums every rep's entries
    .range(0, 99999);
  if (client_id) q = q.eq('client_id', client_id);
  if (user_id) q = q.eq('user_id', user_id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as Array<{ kind: TargetKind; user_id: string; amount: number }>;
}

async function monthTargetRows(org_id: string, types: TargetType[]): Promise<Array<TargetRowLite & { metric: string }>> {
  if (!types.length) return [];
  const { data, error } = await supabaseAdmin.from('crm_targets')
    .select('user_id, org_role_id, hierarchy_level_id, client_id, metric, target_value')
    .eq('org_id', org_id).in('metric', types.map((t) => t.metric)).eq('period', TARGET_PERIOD);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as Array<TargetRowLite & { metric: string }>;
}

/** The caller's target and running monthly total for each enabled type. */
export async function myProgress(actor: Actor, now: number = Date.now()) {
  const client_id = actor.client_id ?? null;
  const month = istMonth(now);
  const types = await loadTargetTypes(actor.org_id, client_id);
  if (!types.length) return { period_start: month.start, period_end: month.end, types: [] };

  const basis = await resolveAchievementBasis(actor.org_id, client_id);
  const wonSales = basis === 'won_deals' && types.some((t) => t.key === 'sales');

  const [{ data: me }, rows, entries, wonMap] = await Promise.all([
    supabaseAdmin.from('users').select('org_role_id, hierarchy_level_id').eq('id', actor.id).maybeSingle(),
    monthTargetRows(actor.org_id, types),
    monthEntries(actor.org_id, client_id, types.map((t) => t.key), month, actor.id),
    wonSales ? wonSalesByOwner(actor.org_id, client_id, [actor.id], month.start, month.end) : Promise.resolve(null),
  ]);
  const who = { user_id: actor.id, org_role_id: (me as any)?.org_role_id ?? null, hierarchy_level_id: (me as any)?.hierarchy_level_id ?? null };
  return {
    period_start: month.start,
    period_end: month.end,
    types: types.map((t) => {
      const { target, source } = resolveTarget(rows.filter((r) => r.metric === t.metric), who, client_id);
      // SALES on the won-deals basis scores off won crm_deals; everything else stays on logged entries.
      const achieved = t.key === 'sales' && wonMap
        ? (wonMap.get(actor.id)?.value ?? 0)
        : sumRupees(entries.filter((e) => e.kind === t.key));
      return { key: t.key, label: t.label, target, achieved, pct: pctOf(achieved, target), source };
    }),
  };
}

// ── leaderboard for one type ────────────────────────────────────────────────
/**
 * Per-user target vs the running monthly total, for one enabled type. Same people as the lead board (the
 * configured role; a non-manager is pinned to their own role). Rows: { user_id, name, role, target,
 * achieved, pct } with `target` / `pct` null when the person has no target.
 */
export async function typedLeaderboard(
  org_id: string,
  client_id: string | null,
  type: TargetType,
  viewer?: { org_role_id?: string | null; org_role_data_scope?: string | null } | null,
  now: number = Date.now(),
) {
  const month = istMonth(now);
  const { users, roleId } = await leaderboardUsers(org_id, client_id, viewer);
  const wonSales = type.key === 'sales' && (await resolveAchievementBasis(org_id, client_id)) === 'won_deals';
  const [rows, entries, wonMap] = await Promise.all([
    monthTargetRows(org_id, [type]),
    monthEntries(org_id, client_id, [type.key], month),
    wonSales ? wonSalesByOwner(org_id, client_id, users.map((u) => u.id), month.start, month.end) : Promise.resolve(null),
  ]);

  const cents = new Map<string, number>();
  for (const e of entries) cents.set(e.user_id, (cents.get(e.user_id) ?? 0) + toCents(e.amount));

  const roleIds = Array.from(new Set(users.map((u) => u.org_role_id).filter(Boolean)));
  const roleName = new Map<string, string>();
  if (roleIds.length) {
    const { data } = await supabaseAdmin.from('org_roles').select('id, name').in('id', roleIds);
    for (const r of (data ?? []) as Array<{ id: string; name: string }>) roleName.set(r.id, r.name);
  }

  const board = users
    .map((u) => {
      const { target } = resolveTarget(rows, { user_id: u.id, org_role_id: u.org_role_id, hierarchy_level_id: u.hierarchy_level_id }, client_id);
      const achieved = wonMap ? (wonMap.get(u.id)?.value ?? 0) : (cents.get(u.id) ?? 0) / 100;
      return {
        user_id: u.id as string,
        name: (u.name || u.email || 'User') as string,
        role: ((u.org_role_id && roleName.get(u.org_role_id)) || u.role || null) as string | null,
        target,
        achieved,
        pct: pctOf(achieved, target),
        _keep: !!(u.org_role_id || u.hierarchy_level_id) || achieved > 0 || target != null,
      };
    })
    .filter((e) => e._keep)
    .map(({ _keep, ...e }) => e)
    .sort((a, b) => b.achieved - a.achieved || a.name.localeCompare(b.name));

  const withTarget = board.filter((e) => e.target != null);
  return {
    type: type.key,
    label: type.label,
    metric: type.metric,
    period: TARGET_PERIOD,
    period_start: month.start,
    period_end: month.end,
    generated_at: new Date(now).toISOString(),
    stats: {
      participants: board.length,
      total_target: withTarget.reduce((s, e) => s + (e.target as number), 0),
      total_achieved: sumRupees(board.map((e) => ({ amount: e.achieved }))),
      meeting_target: withTarget.filter((e) => e.achieved >= (e.target as number)).length,
      target_participants: withTarget.length,
      top_performer: board[0] ? { name: board[0].name, achieved: board[0].achieved } : null,
      lowest_performer: board.length ? { name: board[board.length - 1].name, achieved: board[board.length - 1].achieved } : null,
    },
    entries: board,
    role_id: roleId,
  };
}

// ── entries ─────────────────────────────────────────────────────────────────
export interface EntryInput { kind: TargetKind; amount: number; lead_id?: string | null; note?: string | null; entry_date?: string | null }
export interface EntryQuery { kind?: TargetKind; from?: string; to?: string; limit?: number; user_id?: string; all?: boolean }

export interface EntryDto {
  id: string; kind: TargetKind; amount: number; entry_date: string; lead_id: string | null; lead_name: string | null;
  note: string | null; user_id: string; user_name: string | null; created_at: string;
}

async function toDtos(rows: any[]): Promise<EntryDto[]> {
  if (!rows.length) return [];
  const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
  const names = new Map<string, string>();
  if (userIds.length) {
    const { data } = await supabaseAdmin.from('users').select('id, name').in('id', userIds);
    for (const u of (data ?? []) as Array<{ id: string; name: string }>) names.set(u.id, u.name);
  }
  const stamped = await stampLinkedEntityNames(rows.map((r) => ({ lead_id: r.lead_id ?? null })));
  return rows.map((r, i) => ({
    id: r.id,
    kind: r.kind,
    amount: Number(r.amount),
    entry_date: String(r.entry_date).slice(0, 10),
    lead_id: r.lead_id ?? null,
    lead_name: r.lead_id ? ((stamped[i] as { lead_name?: string | null }).lead_name || null) : null,
    note: r.note ?? null,
    user_id: r.user_id,
    user_name: names.get(r.user_id) ?? null,
    created_at: r.created_at,
  }));
}

/** Log an order / collection for the caller. */
export async function createEntry(actor: Actor, input: EntryInput, now: number = Date.now()): Promise<EntryDto> {
  const client_id = actor.client_id ?? null;
  if (!(await loadTargetTypes(actor.org_id, client_id)).some((t) => t.key === input.kind)) {
    throw new AppError(400, `The "${input.kind}" target is not enabled for this client`, 'TARGET_TYPE_NOT_ENABLED');
  }
  const today = istDate(now);
  const date = input.entry_date || today;
  if (date > today) throw new AppError(400, 'The date cannot be in the future', 'VALIDATION');
  if (date < addDays(today, -MAX_BACKDATE_DAYS)) throw new AppError(400, `The date cannot be more than ${MAX_BACKDATE_DAYS} days ago`, 'VALIDATION');
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0) || amount > MAX_TARGET_VALUE) throw new AppError(400, 'Enter an amount above 0', 'VALIDATION');

  if (!(await hasTargetEntries())) {
    throw new AppError(409, 'Sales and collection entries need a one-time database update (migrations/crm_target_entries.sql). Ask your administrator to apply it.', 'TARGET_ENTRIES_NOT_ENABLED');
  }

  if (input.lead_id) {
    let lq = supabaseAdmin.from('crm_leads').select('id').eq('id', input.lead_id).eq('org_id', actor.org_id).is('deleted_at', null);
    if (client_id) lq = lq.eq('client_id', client_id);
    const { data: lead } = await lq.maybeSingle();
    if (!lead) throw new AppError(400, 'That lead was not found', 'VALIDATION');
  }

  const { data, error } = await supabaseAdmin.from('crm_target_entries').insert({
    org_id: actor.org_id, client_id, user_id: actor.id, kind: input.kind, amount, entry_date: date,
    lead_id: input.lead_id || null, note: (input.note ?? '').trim() || null, created_by: actor.id,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (await toDtos([data]))[0];
}

/** Entries, newest first. Your own by default; another person's, or everyone's, for an approver only. */
export async function listEntries(actor: Actor, q: EntryQuery = {}): Promise<EntryDto[]> {
  const others = !!q.all || (!!q.user_id && q.user_id !== actor.id);
  if (others && !isApprover(actor)) throw new AppError(403, "Only an approver can view other people's entries", 'FORBIDDEN');
  if (q.from && q.to && q.from > q.to) throw new AppError(400, 'The end date is before the start date', 'VALIDATION');
  const limit = Math.min(ENTRIES_MAX_LIMIT, Math.max(1, Math.round(Number(q.limit) || ENTRIES_DEFAULT_LIMIT)));
  const client_id = actor.client_id ?? null;

  // Only kinds the client has enabled: nothing configured = nothing to show.
  const enabled = (await loadTargetTypes(actor.org_id, client_id)).map((t) => t.key);
  const kinds = q.kind ? enabled.filter((k) => k === q.kind) : enabled;
  if (!kinds.length || !(await hasTargetEntries())) return [];

  let query = supabaseAdmin.from('crm_target_entries')
    .select('id, kind, amount, entry_date, lead_id, note, user_id, created_at')
    .eq('org_id', actor.org_id).is('deleted_at', null).in('kind', kinds);
  if (client_id) query = query.eq('client_id', client_id);
  if (others) { if (q.user_id) query = query.eq('user_id', q.user_id); }
  else query = query.eq('user_id', actor.id);
  if (q.from) query = query.gte('entry_date', q.from);
  if (q.to) query = query.lte('entry_date', q.to);
  const { data, error } = await query
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return toDtos((data ?? []) as any[]);
}

/** Soft-delete an entry: its owner within 24 h of logging it, an approver any time. */
export async function deleteEntry(actor: Actor, id: string, now: number = Date.now()): Promise<{ id: string }> {
  const client_id = actor.client_id ?? null;
  if (!(await hasTargetEntries())) throw new AppError(404, 'Entry not found', 'NOT_FOUND');
  let q = supabaseAdmin.from('crm_target_entries').select('id, user_id, created_at')
    .eq('id', id).eq('org_id', actor.org_id).is('deleted_at', null);
  if (client_id) q = q.eq('client_id', client_id);
  const { data: entry } = await q.maybeSingle();
  if (!entry) throw new AppError(404, 'Entry not found', 'NOT_FOUND');

  const e = entry as { user_id: string; created_at: string };
  const mine = e.user_id === actor.id;
  if (!isApprover(actor)) {
    if (!mine) throw new AppError(403, 'You can only delete your own entries', 'FORBIDDEN');
    if (now - Date.parse(e.created_at) > DELETE_WINDOW_MS) {
      throw new AppError(403, 'An entry can be deleted within 24 hours of logging it. Ask your manager.', 'FORBIDDEN');
    }
  }
  const { error } = await supabaseAdmin.from('crm_target_entries')
    .update({ deleted_at: new Date(now).toISOString() })
    .eq('id', id).eq('org_id', actor.org_id).is('deleted_at', null);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { id };
}

// ── salesperson drill-down ────────────────────────────────────────────────────
/** Start + end (YYYY-MM-DD) of the calendar month `ym` ("YYYY-MM"). */
function monthBoundsOf(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${pad(last)}` };
}

/** The `n` calendar months ending at (and including) the month that begins `currentStart` ("YYYY-MM-01"), oldest first. */
function lastNMonths(currentStart: string, n: number): Array<{ month: string; start: string; end: string }> {
  const [y, m] = currentStart.split('-').map(Number); // m is 1-based
  const out: Array<{ month: string; start: string; end: string }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const ym = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    out.push({ month: ym, ...monthBoundsOf(ym) });
  }
  return out;
}

/** The Monday (YYYY-MM-DD) of the ISO week containing `date`. */
function mondayOf(date: string): string {
  const dow = new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay(); // 0 Sun..6 Sat
  return addDays(date, -((dow + 6) % 7));
}

/**
 * Every sales contribution for one user across [from, to], as {date, cents, customer}.
 * On the won-deals basis that is each won deal (dated by actual_close_date, customer =
 * account name || deal name); on the manual basis it is each logged sales entry (dated
 * by entry_date, customer = linked lead name). Amounts stay in whole paise until summed.
 */
async function salesRowsForUser(
  org_id: string, client_id: string | null, userId: string, basis: AchievementBasis, from: string, to: string,
): Promise<Array<{ date: string; cents: number; customer: string | null }>> {
  if (basis === 'won_deals') {
    let q = supabaseAdmin.from('crm_deals')
      .select('amount, actual_close_date, account_id, name, crm_deal_stages!inner(stage_type)')
      .eq('org_id', org_id).is('deleted_at', null).eq('owner_id', userId)
      .not('actual_close_date', 'is', null)
      .gte('actual_close_date', from).lte('actual_close_date', to)
      .eq('crm_deal_stages.stage_type', 'won').range(0, 99999);
    if (client_id) q = q.eq('client_id', client_id);
    const { data, error } = await q;
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    const rows = (data ?? []) as Array<{ amount: unknown; actual_close_date: string; account_id: string | null; name: string | null }>;
    const accIds = Array.from(new Set(rows.map((r) => r.account_id).filter(Boolean))) as string[];
    const accName = new Map<string, string>();
    if (accIds.length) {
      const { data: accs } = await supabaseAdmin.from('crm_accounts').select('id, name').in('id', accIds);
      for (const a of (accs ?? []) as Array<{ id: string; name: string }>) accName.set(a.id, a.name);
    }
    return rows.map((r) => ({
      date: String(r.actual_close_date).slice(0, 10),
      cents: toCents(r.amount),
      customer: (r.account_id && accName.get(r.account_id)) || r.name || null,
    }));
  }
  // manual basis — logged sales entries
  if (!(await hasTargetEntries())) return [];
  let q = supabaseAdmin.from('crm_target_entries').select('amount, entry_date, lead_id')
    .eq('org_id', org_id).is('deleted_at', null).eq('kind', 'sales').eq('user_id', userId)
    .gte('entry_date', from).lte('entry_date', to).range(0, 99999);
  if (client_id) q = q.eq('client_id', client_id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data ?? []) as Array<{ amount: unknown; entry_date: string; lead_id: string | null }>;
  const stamped = await stampLinkedEntityNames(rows.map((r) => ({ lead_id: r.lead_id ?? null })));
  return rows.map((r, i) => ({
    date: String(r.entry_date).slice(0, 10),
    cents: toCents(r.amount),
    customer: r.lead_id ? ((stamped[i] as { lead_name?: string | null }).lead_name || null) : null,
  }));
}

export interface SalespersonDetail {
  user_id: string;
  name: string | null;
  basis: AchievementBasis;
  period_start: string;
  period_end: string;
  target: number | null;
  achieved: number;
  pending: number | null;
  pct: number | null;
  daily: Array<{ date: string; value: number; count: number }>;
  weekly: Array<{ week_start: string; value: number; count: number }>;
  historical: Array<{ month: string; target: number | null; achieved: number; pct: number | null }>;
  customers: Array<{ name: string; value: number; count: number }>;
}

/**
 * One salesperson's SALES target drill-down for the given IST month (default: current):
 * resolved monthly target, achieved + pending, daily and weekly progress, the customers
 * contributing this month, and target-vs-achieved for the last 6 months. Achievement follows
 * the client's basis (won deals for an opted-in client such as Aadinath, logged entries
 * otherwise — unchanged for Tata and every manual client). Read-only; manager-gated at the route.
 */
export async function salespersonTargetDetail(
  org_id: string, client_id: string | null, userId: string, monthParam?: string, now: number = Date.now(),
): Promise<SalespersonDetail> {
  const cur = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthBoundsOf(monthParam) : istMonth(now);
  const basis = await resolveAchievementBasis(org_id, client_id);
  const salesType = (await loadTargetTypes(org_id, client_id)).find((t) => t.key === 'sales');

  const [{ data: u }, targetRows] = await Promise.all([
    supabaseAdmin.from('users').select('id, name, email, org_role_id, hierarchy_level_id').eq('id', userId).maybeSingle(),
    salesType ? monthTargetRows(org_id, [salesType]) : Promise.resolve([] as Array<TargetRowLite & { metric: string }>),
  ]);
  const who = { user_id: userId, org_role_id: (u as any)?.org_role_id ?? null, hierarchy_level_id: (u as any)?.hierarchy_level_id ?? null };
  const target = salesType ? resolveTarget(targetRows, who, client_id).target : null;

  const months = lastNMonths(cur.start, 6);
  const rows = await salesRowsForUser(org_id, client_id, userId, basis, months[0].start, cur.end);

  const inMonth = rows.filter((r) => r.date >= cur.start && r.date <= cur.end);
  const achieved = Math.round(inMonth.reduce((s, r) => s + r.cents, 0)) / 100;
  const pending = target != null ? Math.max(0, target - achieved) : null;

  const bucket = (keyOf: (r: { date: string }) => string) => {
    const m = new Map<string, { cents: number; count: number }>();
    for (const r of inMonth) {
      const k = keyOf(r);
      const e = m.get(k) ?? { cents: 0, count: 0 };
      e.cents += r.cents; e.count += 1; m.set(k, e);
    }
    return m;
  };

  const daily = Array.from(bucket((r) => r.date), ([date, v]) => ({ date, value: v.cents / 100, count: v.count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const weekly = Array.from(bucket((r) => mondayOf(r.date)), ([week_start, v]) => ({ week_start, value: v.cents / 100, count: v.count }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start));

  const custMap = new Map<string, { cents: number; count: number }>();
  for (const r of inMonth) {
    const name = r.customer || 'Unknown';
    const e = custMap.get(name) ?? { cents: 0, count: 0 };
    e.cents += r.cents; e.count += 1; custMap.set(name, e);
  }
  const customers = Array.from(custMap, ([name, v]) => ({ name, value: v.cents / 100, count: v.count }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, 25);

  const historical = months.map((mo) => {
    const a = Math.round(rows.filter((r) => r.date >= mo.start && r.date <= mo.end).reduce((s, r) => s + r.cents, 0)) / 100;
    return { month: mo.month, target, achieved: a, pct: pctOf(a, target) };
  });

  return {
    user_id: userId,
    name: ((u as any)?.name || (u as any)?.email || null) as string | null,
    basis,
    period_start: cur.start,
    period_end: cur.end,
    target,
    achieved,
    pending,
    pct: pctOf(achieved, target),
    daily,
    weekly,
    historical,
    customers,
  };
}
