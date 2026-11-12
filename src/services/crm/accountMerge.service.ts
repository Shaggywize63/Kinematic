/**
 * Find similar CRM accounts and merge them.
 *
 * The same company ends up in the CRM several times ("NTPC Lara", "NTPC Lara Ltd."). Two operations:
 *
 *   findSimilarAccountGroups  GET  /crm/accounts/similar  -> groups of likely duplicates
 *   mergeAccounts             POST /crm/accounts/merge    -> move everything onto one account, soft-delete the rest
 *
 * The pure helpers (normaliseName, similarity, groupSimilarAccounts, ...) are exported for unit tests.
 *
 * Merge safety:
 *  - It cannot be a database transaction (PostgREST), so the order is: validate everything, move references,
 *    update the kept row, and only then soft-delete the merged accounts. A failure part-way leaves the merged
 *    accounts alive, and running the same merge again finishes the job (it only moves what is still pointing at them).
 *  - Each referencing table is independent and resilient: a tenant database that lacks a table or column is skipped
 *    (and reported in `skipped`), any other database error aborts.
 *  - Contacts are never merged automatically; same email / phone pairs are reported for a human to look at.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { chunk } from '../../lib/chunk';
import { AppError } from '../../utils';
import { isTenantAdmin } from '../../middleware/auth';
import { stampOwnerName, stampOwnerNames } from './owners.helper';
import * as crud from './crud.service';
import { writeAccountResilient } from './accountWrite';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers: name normalisation, similarity, grouping
// ─────────────────────────────────────────────────────────────────────────────

/** Words that say what legal form a company has, not which company it is. */
export const LEGAL_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'corp', 'corporation', 'co', 'company', 'the',
]);

export const DEFAULT_MIN_SCORE = 0.88;
export const MIN_SCORE_FLOOR = 0.7;
export const MAX_ACCOUNTS_SCANNED = 5000;
export const MAX_GROUPS = 200;
export const MAX_MERGE_IDS = 20;

/**
 * Lower-case, `&` -> `and`, strip punctuation / accents, drop legal suffix words, collapse spaces.
 * "NTPC Lara Ltd." and "N.T.P.C. Lara (Pvt) Limited" -> "ntpc lara". A name made only of suffix words
 * ("The Company") keeps them so it never normalises to an empty string.
 */
export function normaliseName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    // "N.T.P.C." -> "NTPC": a dot between single letters is an abbreviation, not a word break.
    .replace(/(?<=\b\p{L})\.(?=\p{L}\b)/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ');
  const kept = tokens.filter((t) => !LEGAL_SUFFIX_WORDS.has(t));
  return (kept.length ? kept : tokens).join(' ');
}

/** Levenshtein edit distance (two-row DP). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 - distance / longer length, in 0..1. Two empty strings are not "similar" (0). */
export function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - levenshtein(a, b) / longest;
}

/** Tokens of a normalised name, de-duplicated and sorted: word order and repeats stop mattering. */
function tokenSet(normalised: string): string {
  return Array.from(new Set(normalised.split(' ').filter(Boolean))).sort().join(' ');
}

/** The tokens that carry digits ("plant 2", "unit 101"): different numbers mean different sites. */
function numberTokens(normalised: string): string {
  return normalised.split(' ').filter((t) => /\d/.test(t)).sort().join(' ');
}

/**
 * Similarity of two ALREADY-NORMALISED names, 0..1: the better of the plain Levenshtein ratio and the
 * Levenshtein ratio of the sorted token sets ("lara ntpc" ~ "ntpc lara"). Deliberately NOT a subset match:
 * "ntpc" is not the same company as "ntpc lara". Names whose numbers differ ("plant 1" vs "plant 2") are capped
 * at 0.5 so a one-character difference in a code never reads as a typo.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (numberTokens(a) !== numberTokens(b)) return Math.min(0.5, levenshteinRatio(a, b));
  return Math.max(levenshteinRatio(a, b), levenshteinRatio(tokenSet(a), tokenSet(b)));
}

export interface SimilarityInput {
  id: string;
  name?: string | null;
  client_id?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
}
export interface AccountGroup<T extends SimilarityInput = SimilarityInput> { key: string; score: number; accounts: T[] }

const firstToken = (n: string): string => n.split(' ')[0] ?? '';

/**
 * Group likely-duplicate accounts. Exact-equal normalised names group at score 1; near matches (similarity >=
 * minScore) group with the lowest link score in the group as the group's score. Only accounts of the same client
 * (tenant) are ever grouped together. Accounts are bucketed by first token and by first 3 characters so a
 * 5000-account scan does not compare every pair. Groups: >= 2 accounts, sorted by score desc then size desc.
 */
export function groupSimilarAccounts<T extends SimilarityInput>(
  rows: T[],
  minScore: number = DEFAULT_MIN_SCORE,
  maxGroups: number = MAX_GROUPS,
): AccountGroup<T>[] {
  const threshold = Math.min(1, Math.max(MIN_SCORE_FLOOR, Number.isFinite(minScore) ? minScore : DEFAULT_MIN_SCORE));

  // 1. Exact groups: one node per (client, normalised name).
  interface Node { norm: string; client: string; members: T[] }
  const nodes: Node[] = [];
  const nodeByKey = new Map<string, Node>();
  for (const r of rows) {
    const norm = normaliseName(r.name);
    if (!norm) continue;
    const client = r.client_id ?? '';
    const k = `${client}\u0000${norm}`;
    let n = nodeByKey.get(k);
    if (!n) { n = { norm, client, members: [] }; nodeByKey.set(k, n); nodes.push(n); }
    n.members.push(r);
  }

  // 2. Union-find over the nodes, linked when similar enough.
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const linkScores = new Map<number, number>(); // root -> lowest link score in the component
  const union = (a: number, b: number, score: number) => {
    const ra = find(a); const rb = find(b);
    const lo = Math.min(score, linkScores.get(ra) ?? 1, linkScores.get(rb) ?? 1);
    if (ra !== rb) parent[rb] = ra;
    linkScores.set(ra, lo);
    if (ra !== rb) linkScores.delete(rb);
  };

  if (threshold < 1) {
    const buckets = new Map<string, number[]>();
    const add = (k: string, i: number) => { const b = buckets.get(k); if (b) b.push(i); else buckets.set(k, [i]); };
    nodes.forEach((n, i) => {
      add(`t:${n.client}:${firstToken(n.norm)}`, i);
      add(`p:${n.client}:${n.norm.slice(0, 3)}`, i);
    });
    const done = new Set<string>();
    const WINDOW = 60; // a pathological bucket (thousands of "tata ...") is compared against its sorted neighbours only
    for (const idxs of buckets.values()) {
      if (idxs.length < 2) continue;
      const list = idxs.length > 1500 ? [...idxs].sort((x, y) => nodes[x].norm.localeCompare(nodes[y].norm)) : idxs;
      for (let x = 0; x < list.length; x++) {
        const end = list.length > 1500 ? Math.min(list.length, x + 1 + WINDOW) : list.length;
        for (let y = x + 1; y < end; y++) {
          const i = list[x]; const j = list[y];
          const pk = i < j ? `${i}:${j}` : `${j}:${i}`;
          if (done.has(pk)) continue;
          done.add(pk);
          const a = nodes[i].norm; const b = nodes[j].norm;
          // Cheap length gate: the ratio can never reach the threshold when the lengths are this far apart.
          if (1 - Math.abs(a.length - b.length) / Math.max(a.length, b.length) < threshold) continue;
          const s = similarity(a, b);
          if (s >= threshold) union(i, j, s);
        }
      }
    }
  }

  // 3. Collect components with >= 2 accounts.
  const comps = new Map<number, Node[]>();
  nodes.forEach((n, i) => { const r = find(i); const c = comps.get(r); if (c) c.push(n); else comps.set(r, [n]); });
  const groups: AccountGroup<T>[] = [];
  const usedKeys = new Set<string>();
  for (const [root, comp] of comps) {
    const accounts = comp.flatMap((n) => n.members);
    if (accounts.length < 2) continue;
    // Oldest first: the natural "keep" candidate leads the group.
    accounts.sort((x, y) => String(x.created_at ?? '').localeCompare(String(y.created_at ?? '')) || String(x.id).localeCompare(String(y.id)));
    const score = comp.length === 1 ? 1 : Math.round((linkScores.get(root) ?? threshold) * 1000) / 1000;
    let key = normaliseName(accounts[0].name);
    if (usedKeys.has(key)) { let n = 2; while (usedKeys.has(`${key}#${n}`)) n++; key = `${key}#${n}`; }
    usedKeys.add(key);
    groups.push({ key, score, accounts });
  }
  groups.sort((a, b) => b.score - a.score || b.accounts.length - a.accounts.length || a.key.localeCompare(b.key));
  return groups.slice(0, maxGroups);
}

/** Parse the `min_score` query value: 0.7..1, default 0.88. */
export function parseMinScore(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MIN_SCORE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MIN_SCORE;
  return Math.min(1, Math.max(MIN_SCORE_FLOOR, n));
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;
interface DbErr { code?: string; message?: string }

const MISSING_CODES = new Set(['PGRST204', 'PGRST205', '42703', '42P01']);
/** The table or column is not in this tenant's database (PostgREST / Postgres "not found" family). */
export function isMissingSchemaError(e: DbErr | null | undefined): boolean {
  if (!e) return false;
  if (e.code && MISSING_CODES.has(e.code)) return true;
  return /could not find|does not exist/i.test(String(e.message ?? ''));
}

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// ─────────────────────────────────────────────────────────────────────────────
// Similar accounts
// ─────────────────────────────────────────────────────────────────────────────

export interface SimilarAccount {
  id: string; name: string; city: string | null; state: string | null; industry: string | null;
  owner_id: string | null; owner_name: string | null; created_at: string | null;
  contact_count: number; lead_count: number; deal_count: number;
}
export interface SimilarGroup { key: string; score: number; accounts: SimilarAccount[] }

export interface SimilarOpts {
  orgId: string;
  clientId: string | null;
  /** Hierarchy visibility (same as the accounts list): null/undefined = unrestricted, [] = nothing. */
  visibleOwnerIds?: string[] | null;
  minScore?: number;
}

const PAGE = 1000; // PostgREST's default max rows per response

/** The caller's live accounts, scoped exactly like the accounts list (org + strict client + owner visibility). */
async function loadScopedAccounts(o: SimilarOpts): Promise<Row[]> {
  if (o.visibleOwnerIds && o.visibleOwnerIds.length === 0) return [];
  const out: Row[] = [];
  for (let from = 0; from < MAX_ACCOUNTS_SCANNED; from += PAGE) {
    const to = Math.min(from + PAGE, MAX_ACCOUNTS_SCANNED) - 1;
    let q: any = supabaseAdmin.from('crm_accounts').select('*').eq('org_id', o.orgId).is('deleted_at', null);
    if (o.clientId) q = q.eq('client_id', o.clientId); // strict tenant isolation, as the list does for accounts
    if (o.visibleOwnerIds) q = q.or(`owner_id.in.(${o.visibleOwnerIds.join(',')})`);
    q = q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
    const { data, error } = await q;
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < to - from + 1) break;
  }
  return out.slice(0, MAX_ACCOUNTS_SCANNED);
}

/** account_id -> row count for one table; a failing query yields an empty map (counts read 0), never an error. */
async function countByAccount(table: string, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const batch of chunk(ids, 150)) {
    for (let from = 0; from < 50 * PAGE; from += PAGE) {
      let data: Row[] | null = null;
      try {
        const res: any = await supabaseAdmin.from(table).select('account_id').in('account_id', batch).is('deleted_at', null).range(from, from + PAGE - 1);
        if (res.error) throw new Error(res.error.message);
        data = res.data ?? [];
      } catch (e) {
        logger.warn({ table, err: (e as Error).message }, 'accounts/similar: count query failed, counts read 0');
        return counts;
      }
      for (const r of data as Row[]) if (r.account_id) counts.set(r.account_id, (counts.get(r.account_id) ?? 0) + 1);
      if ((data as Row[]).length < PAGE) break;
    }
  }
  return counts;
}

export async function findSimilarAccountGroups(o: SimilarOpts): Promise<{ groups: SimilarGroup[] }> {
  const rows = await loadScopedAccounts(o);
  const groups = groupSimilarAccounts(rows as SimilarInputRow[], o.minScore ?? DEFAULT_MIN_SCORE, MAX_GROUPS);
  if (groups.length === 0) return { groups: [] };

  const ids = Array.from(new Set(groups.flatMap((g) => g.accounts.map((a) => String(a.id)))));
  const [contacts, leads, deals] = await Promise.all([
    countByAccount('crm_contacts', ids), countByAccount('crm_leads', ids), countByAccount('crm_deals', ids),
  ]);
  const stamped = await stampOwnerNames(groups.flatMap((g) => g.accounts) as Row[]);
  const byId = new Map<string, Row>(stamped.map((a) => [String(a.id), a]));

  return {
    groups: groups.map((g) => ({
      key: g.key,
      score: g.score,
      accounts: g.accounts.map((a): SimilarAccount => {
        const r = byId.get(String(a.id)) ?? (a as Row);
        return {
          id: r.id, name: r.name ?? '', city: r.city ?? null, state: r.state ?? null, industry: r.industry ?? null,
          owner_id: r.owner_id ?? null, owner_name: r.owner_name ?? null, created_at: r.created_at ?? null,
          contact_count: contacts.get(r.id) ?? 0, lead_count: leads.get(r.id) ?? 0, deal_count: deals.get(r.id) ?? 0,
        };
      }),
    })),
  };
}
type SimilarInputRow = SimilarityInput;

// ─────────────────────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeMoved {
  contacts: number; leads: number; converted_leads: number; deals: number; activities: number; notes: number;
  sites: number; visits: number; account_updates: number; expenses: number; form_submissions: number; child_accounts: number;
}
export interface DuplicateContact { keep_contact_id: string; other_contact_id: string; reason: 'same_email' | 'same_phone' }
export interface MergeResult {
  dry_run: boolean;
  kept: Row;
  merged_ids: string[];
  moved: MergeMoved;
  skipped: string[];
  duplicate_contacts: DuplicateContact[];
}
export interface MergeInput { keep_id: string; merge_ids: string[]; dry_run?: boolean }
export interface MergeCtx {
  orgId: string;
  clientId: string | null;
  user: { id?: string | null; role?: string | null } | null | undefined;
}

/**
 * Who may merge: the same "tenant admin" predicate the CRM uses to let a user view and edit every record in the
 * tenant (`isTenantAdmin` in middleware/auth.ts: super_admin, admin, main_admin, sub_admin, client, city_manager).
 * A merge rewrites other people's contacts, deals and activities and removes accounts, so reps and supervisors
 * (who only manage their own team) cannot do it.
 */
export function assertCanMerge(user: MergeCtx['user']): void {
  if (!isTenantAdmin(user)) {
    throw new AppError(403, 'Only an admin can merge accounts', 'FORBIDDEN');
  }
}

interface MoveStep {
  table: string;
  column: string;
  bucket: keyof MergeMoved;
  /** Only rows where `col` = `val` (e.g. notes linked through entity_type = 'account'). */
  where?: [string, string];
  /** Extra variants of an already-counted table: a missing column is ignored, not reported in `skipped`. */
  quiet?: boolean;
  /** account ids that must never be re-pointed (the kept account and the merged ones, for child accounts). */
  excludeIds?: string[];
}

function moveSteps(keepId: string, mergeIds: string[]): MoveStep[] {
  return [
    { table: 'crm_contacts', column: 'account_id', bucket: 'contacts' },
    { table: 'crm_leads', column: 'account_id', bucket: 'leads' },
    { table: 'crm_leads', column: 'converted_account_id', bucket: 'converted_leads' },
    { table: 'crm_deals', column: 'account_id', bucket: 'deals' },
    { table: 'crm_activities', column: 'account_id', bucket: 'activities' },
    { table: 'crm_notes', column: 'account_id', bucket: 'notes' },
    // Notes written from the account page are linked by entity_type/entity_id (or linked_to_type/linked_to_id).
    { table: 'crm_notes', column: 'entity_id', bucket: 'notes', where: ['entity_type', 'account'], quiet: true },
    { table: 'crm_notes', column: 'linked_to_id', bucket: 'notes', where: ['linked_to_type', 'account'], quiet: true },
    { table: 'crm_sites', column: 'account_id', bucket: 'sites' },
    { table: 'crm_visits', column: 'account_id', bucket: 'visits' },
    { table: 'crm_account_updates', column: 'account_id', bucket: 'account_updates' },
    { table: 'expense_claims', column: 'account_id', bucket: 'expenses' },
    { table: 'form_submissions', column: 'account_id', bucket: 'form_submissions' },
    { table: 'crm_accounts', column: 'parent_account_id', bucket: 'child_accounts', excludeIds: [keepId, ...mergeIds] },
  ];
}

const emptyMoved = (): MergeMoved => ({
  contacts: 0, leads: 0, converted_leads: 0, deals: 0, activities: 0, notes: 0, sites: 0, visits: 0,
  account_updates: 0, expenses: 0, form_submissions: 0, child_accounts: 0,
});

/** Columns copied onto the kept account from the merged ones when the kept value is blank. */
export const FILL_COLUMNS = [
  'domain', 'website', 'phone', 'email', 'industry', 'company_size', 'size',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'owner_id',
] as const;

/** The columns of `keep` to change so it absorbs the blanks / tags / custom fields of `merged` (in merge_ids order). */
export function computeKeepPatch(keep: Row, merged: Row[], opts: { clearParent?: boolean } = {}): Row {
  const patch: Row = {};
  for (const col of FILL_COLUMNS) {
    if (!(col in keep)) continue; // not a column in this tenant's table
    if (!isEmpty(keep[col])) continue;
    const donor = merged.find((m) => !isEmpty(m[col]));
    if (donor) patch[col] = typeof donor[col] === 'string' ? donor[col].trim() : donor[col];
  }
  const keepTags: string[] = Array.isArray(keep.tags) ? keep.tags : [];
  const tags = [...keepTags];
  for (const m of merged) for (const t of Array.isArray(m.tags) ? m.tags : []) if (!tags.includes(t)) tags.push(t);
  if (tags.length !== keepTags.length) patch.tags = tags;

  const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
  const donors = merged.map((m) => (isObj(m.custom_fields) ? { ...m.custom_fields } : {}));
  for (const d of donors) { delete d.merged_into; delete d.merged_at; }
  // Earlier merge_ids win over later ones, and the kept account's own values win over all of them.
  const cf: Row = Object.assign({}, ...[...donors].reverse(), isObj(keep.custom_fields) ? keep.custom_fields : {});
  if (JSON.stringify(cf) !== JSON.stringify(isObj(keep.custom_fields) ? keep.custom_fields : {})) patch.custom_fields = cf;

  if (opts.clearParent && keep.parent_account_id) patch.parent_account_id = null;
  return patch;
}

/** Duplicate people under one account: same lower-cased email, or same digits-only phone (>= 6 digits). Oldest = keep. */
export function findDuplicateContacts(contacts: Row[]): DuplicateContact[] {
  const sorted = [...contacts].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id)));
  const out: DuplicateContact[] = [];
  const seen = new Set<string>();
  const pair = (keepC: Row, other: Row, reason: DuplicateContact['reason']) => {
    const k = `${keepC.id}:${other.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ keep_contact_id: keepC.id, other_contact_id: other.id, reason });
  };
  const scan = (keyOf: (c: Row) => string, reason: DuplicateContact['reason']) => {
    const first = new Map<string, Row>();
    for (const c of sorted) {
      const k = keyOf(c);
      if (!k) continue;
      const f = first.get(k);
      if (!f) first.set(k, c); else pair(f, c, reason);
    }
  };
  scan((c) => String(c.email ?? '').trim().toLowerCase(), 'same_email');
  scan((c) => { const d = String(c.phone ?? '').replace(/\D/g, ''); return d.length >= 6 ? d : ''; }, 'same_phone');
  return out;
}

/** Load the accounts named in the request and make sure every one may be merged by this caller. */
async function loadAndValidate(ctx: MergeCtx, keepId: string, mergeIds: string[]): Promise<{ keep: Row; merged: Row[] }> {
  const wanted = [keepId, ...mergeIds];
  const { data, error } = await supabaseAdmin.from('crm_accounts').select('*').eq('org_id', ctx.orgId).in('id', wanted);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const byId = new Map<string, Row>(((data ?? []) as Row[]).map((r) => [String(r.id).toLowerCase(), r]));

  // A row of another client (or one we cannot see at all) is "not found", exactly like crud.get would answer.
  const visible = (r: Row | undefined): r is Row => !!r && (!ctx.clientId || r.client_id === ctx.clientId);
  const missing = wanted.filter((id) => !visible(byId.get(id.toLowerCase())));
  if (missing.length) throw new AppError(404, `Account not found: ${missing.join(', ')}`, 'NOT_FOUND');

  const gone = wanted.filter((id) => byId.get(id.toLowerCase())!.deleted_at);
  if (gone.length) {
    const hints = gone.map((id) => {
      const into = (byId.get(id.toLowerCase())!.custom_fields as Row | null)?.merged_into;
      return into ? `${id} (already merged into ${into})` : `${id} (deleted)`;
    });
    throw new AppError(400, `These accounts are already deleted or merged: ${hints.join(', ')}`, 'ALREADY_MERGED');
  }

  const keep = byId.get(keepId.toLowerCase())!;
  const merged = mergeIds.map((id) => byId.get(id.toLowerCase())!);
  // Without a client picker an admin sees the whole org: never fold one tenant's account into another's.
  const clients = new Set([keep, ...merged].map((r) => r.client_id ?? null));
  if (clients.size > 1) throw new AppError(400, 'These accounts belong to different clients and cannot be merged', 'VALIDATION');
  return { keep, merged };
}

/** Does any ancestor of `keep` appear in `mergedSet`? Then re-pointing that branch at keep would close a loop. */
async function hasMergedAncestor(keep: Row, mergedSet: Set<string>): Promise<boolean> {
  const seen = new Set<string>([String(keep.id)]);
  let cur: string | null = keep.parent_account_id ?? null;
  for (let hop = 0; hop < 25 && cur && !seen.has(cur); hop++) {
    if (mergedSet.has(cur)) return true;
    seen.add(cur);
    const { data, error } = await supabaseAdmin.from('crm_accounts').select('id, parent_account_id').eq('id', cur).maybeSingle();
    if (error || !data) return false;
    cur = (data as Row).parent_account_id ?? null;
  }
  return false;
}

async function countStep(step: MoveStep, ids: string[]): Promise<{ count: number; error: DbErr | null }> {
  let q: any = supabaseAdmin.from(step.table).select('id', { count: 'exact', head: true }).in(step.column, ids);
  if (step.where) q = q.eq(step.where[0], step.where[1]);
  if (step.excludeIds?.length) q = q.not('id', 'in', `(${step.excludeIds.join(',')})`);
  const { count, error } = await q;
  return { count: count ?? 0, error: error ?? null };
}

async function moveStep(step: MoveStep, ids: string[], keepId: string): Promise<{ count: number; error: DbErr | null }> {
  let q: any = supabaseAdmin.from(step.table).update({ [step.column]: keepId }).in(step.column, ids);
  if (step.where) q = q.eq(step.where[0], step.where[1]);
  if (step.excludeIds?.length) q = q.not('id', 'in', `(${step.excludeIds.join(',')})`);
  const { data, error } = await q.select('id');
  return { count: Array.isArray(data) ? data.length : 0, error: error ?? null };
}

/** Contacts under the kept account (or, in a dry run, under it and the accounts about to be merged into it). */
async function duplicateContactsUnder(accountIds: string[]): Promise<DuplicateContact[]> {
  try {
    const res: any = await supabaseAdmin
      .from('crm_contacts').select('id, email, phone, created_at').in('account_id', accountIds).is('deleted_at', null).limit(5000);
    if (res.error) throw new Error(res.error.message);
    return findDuplicateContacts((res.data ?? []) as Row[]).slice(0, 500);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'accounts/merge: duplicate-contact scan failed');
    return [];
  }
}

export async function mergeAccounts(ctx: MergeCtx, input: MergeInput): Promise<MergeResult> {
  assertCanMerge(ctx.user);
  const dryRun = input.dry_run === true;
  const keepId = String(input.keep_id).toLowerCase();
  const mergeIds = input.merge_ids.map((i) => String(i).toLowerCase());
  if (mergeIds.length < 1 || mergeIds.length > MAX_MERGE_IDS) throw new AppError(400, `Merge between 1 and ${MAX_MERGE_IDS} accounts at a time`, 'VALIDATION');
  if (mergeIds.includes(keepId)) throw new AppError(400, 'keep_id cannot also be in merge_ids', 'VALIDATION');
  if (new Set(mergeIds).size !== mergeIds.length) throw new AppError(400, 'merge_ids must not contain duplicates', 'VALIDATION');

  const { keep, merged } = await loadAndValidate(ctx, keepId, mergeIds);
  const patch = computeKeepPatch(keep, merged, { clearParent: await hasMergedAncestor(keep, new Set(mergeIds)) });

  const moved = emptyMoved();
  const skipped: string[] = [];
  const skip = (table: string) => { if (!skipped.includes(table)) skipped.push(table); };

  for (const step of moveSteps(keepId, mergeIds)) {
    const { count, error } = dryRun ? await countStep(step, mergeIds) : await moveStep(step, mergeIds, keepId);
    if (error) {
      if (isMissingSchemaError(error)) { if (!step.quiet) skip(step.table); continue; }
      logger.error({ table: step.table, column: step.column, err: error.message }, 'accounts/merge: move failed');
      throw new AppError(
        500,
        `Merge stopped while moving ${step.table}.${step.column}: ${error.message}. No account was deleted; run the merge again to finish.`,
        'MERGE_FAILED',
      );
    }
    moved[step.bucket] += count;
  }

  let kept: Row = { ...keep, ...patch };
  const nowIso = new Date().toISOString();
  if (!dryRun) {
    if (Object.keys(patch).length) {
      kept = await writeAccountResilient(patch, 'patch', (p) =>
        crud.update('crm_accounts', ctx.orgId, keepId, p, ctx.user?.id ?? undefined, ctx.clientId)) as Row;
    }
    for (const m of merged) {
      const cf = (m.custom_fields && typeof m.custom_fields === 'object' && !Array.isArray(m.custom_fields)) ? m.custom_fields : {};
      try {
        await crud.update('crm_accounts', ctx.orgId, String(m.id), {
          deleted_at: nowIso,
          custom_fields: { ...cf, merged_into: keepId, merged_at: nowIso },
        }, ctx.user?.id ?? undefined, ctx.clientId);
      } catch (e) {
        const msg = e instanceof AppError ? e.message : (e as Error).message;
        throw new AppError(500, `Merge stopped while retiring account ${m.id}: ${msg}. Run the merge again to finish.`, 'MERGE_FAILED');
      }
    }
  }

  const duplicate_contacts = await duplicateContactsUnder(dryRun ? [keepId, ...mergeIds] : [keepId]);
  return {
    dry_run: dryRun,
    kept: (await stampOwnerName(kept)) ?? kept,
    merged_ids: mergeIds,
    moved,
    skipped,
    duplicate_contacts,
  };
}
