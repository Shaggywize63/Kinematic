/**
 * Find similar accounts + merge them. The pure helpers are tested directly; the DB paths run against a tiny in-memory
 * PostgREST fake (`../src/lib/supabase` is mocked) so we can assert exactly which rows move and what is never written.
 */
type Row = Record<string, any>;

// ── in-memory PostgREST fake ────────────────────────────────────────────────
const db: { tables: Record<string, Row[]>; missingTables: Set<string>; missingCols: Record<string, Set<string>>; failTables: Record<string, string>; writes: string[] } =
  { tables: {}, missingTables: new Set(), missingCols: {}, failTables: {}, writes: [] };

function parseOr(expr: string): Array<(r: Row) => boolean> {
  // Supports the `col.is.null`, `col.eq.X` and `col.in.(a,b)` forms the CRUD helpers produce.
  const parts = expr.split(/,(?![^()]*\))/);
  return parts.map((p) => {
    const m = /^([a-z_]+)\.(is|eq|in)\.(.*)$/.exec(p)!;
    const [, col, op, val] = m;
    if (op === 'is') return (r: Row) => r[col] === null || r[col] === undefined;
    if (op === 'eq') return (r: Row) => String(r[col]) === val;
    const set = new Set(val.replace(/^\(|\)$/g, '').split(','));
    return (r: Row) => set.has(String(r[col]));
  });
}

class MockQ {
  private op: 'select' | 'update' = 'select';
  private payload: Row = {};
  private preds: Array<(r: Row) => boolean> = [];
  private cols: string[] = [];
  private head = false;
  private wantCount = false;
  private returning = false;
  private rangeFrom = 0;
  private rangeTo = Infinity;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'update') this.returning = true;
    this.wantCount = opts?.count === 'exact'; this.head = !!opts?.head; return this;
  }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  private col(c: string) { this.cols.push(c); }
  eq(c: string, v: unknown) { this.col(c); this.preds.push((r) => String(r[c]) === String(v)); return this; }
  neq(c: string, v: unknown) { this.col(c); this.preds.push((r) => String(r[c]) !== String(v)); return this; }
  in(c: string, vs: unknown[]) { this.col(c); const s = new Set(vs.map(String)); this.preds.push((r) => s.has(String(r[c]))); return this; }
  is(c: string, v: null) { this.col(c); this.preds.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _op: string, v: string) { this.col(c); const s = new Set(v.replace(/^\(|\)$/g, '').split(',')); this.preds.push((r) => !s.has(String(r[c]))); return this; }
  or(expr: string) { const ps = parseOr(expr); this.preds.push((r) => ps.some((p) => p(r))); return this; }
  order() { return this; }
  limit(n: number) { this.rangeTo = n - 1; return this; }
  range(a: number, b: number) { this.rangeFrom = a; this.rangeTo = b; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  private run(): { data?: any; error?: any; count?: number } {
    const t = this.table;
    if (db.failTables[t]) return { error: { code: 'XX000', message: db.failTables[t] } };
    if (db.missingTables.has(t)) return { error: { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` } };
    const gone = db.missingCols[t];
    const touched = [...this.cols, ...(this.op === 'update' ? Object.keys(this.payload) : [])];
    const bad = gone ? touched.find((c) => gone.has(c)) : undefined;
    if (bad) return { error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${t}' in the schema cache` } };
    const rows = (db.tables[t] ??= []);
    const hit = rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') {
      db.writes.push(`${t}:${Object.keys(this.payload).join(',')}`);
      hit.forEach((r) => Object.assign(r, this.payload));
      const data = hit.map((r) => ({ ...r }));
      if (this.mode === 'single') return data.length === 1 ? { data: data[0] } : { error: { code: 'PGRST116', message: 'no rows' } };
      return { data: this.returning ? data : null };
    }
    if (this.head) return { count: hit.length, data: null };
    const page = hit.slice(this.rangeFrom, this.rangeTo + 1).map((r) => ({ ...r }));
    if (this.mode === 'single') return page.length === 1 ? { data: page[0] } : { error: { code: 'PGRST116', message: 'no rows' } };
    if (this.mode === 'maybe') return { data: page[0] ?? null };
    return { data: page, ...(this.wantCount ? { count: hit.length } : {}) };
  }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve().then(() => this.run()).then(res, rej); }
}

jest.mock('../src/lib/supabase', () => ({ supabaseAdmin: { from: (t: string) => new MockQ(t) } }));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import {
  normaliseName, similarity, levenshtein, levenshteinRatio, groupSimilarAccounts, parseMinScore,
  computeKeepPatch, findDuplicateContacts, findSimilarAccountGroups, mergeAccounts, isMissingSchemaError,
} from '../src/services/crm/accountMerge.service';
import { accountMergeSchema } from '../src/validators/crm.validators';
import { AppError } from '../src/utils';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = u(900);
const ADMIN = { id: u(901), role: 'admin' };
const REP = { id: u(902), role: 'sales_rep' };
const KEEP = u(1); const M1 = u(2); const M2 = u(3);

const acct = (id: string, name: string, extra: Row = {}): Row => ({
  id, org_id: ORG, client_id: null, name, deleted_at: null, created_at: `2026-01-0${(Number(id.slice(-1)) % 9) + 1}T00:00:00Z`,
  domain: null, website: null, phone: null, email: null, industry: null, company_size: null,
  address_line1: null, address_line2: null, city: null, state: null, postal_code: null, owner_id: null,
  tags: [], custom_fields: {}, parent_account_id: null, ...extra,
});

function seed(extraTables: Record<string, Row[]> = {}) {
  db.tables = {
    users: [{ id: u(500), name: 'Asha', email: 'a@x.com' }],
    crm_accounts: [acct(KEEP, 'NTPC Lara Ltd.'), acct(M1, 'NTPC Lara'), acct(M2, 'N.T.P.C. Lara Pvt Limited')],
    crm_contacts: [], crm_leads: [], crm_deals: [], crm_activities: [], crm_notes: [], crm_sites: [], crm_visits: [],
    crm_account_updates: [], expense_claims: [], form_submissions: [],
    ...extraTables,
  };
  db.missingTables = new Set(); db.missingCols = {}; db.failTables = {}; db.writes = [];
}
const account = (id: string) => db.tables.crm_accounts.find((r) => r.id === id)!;
const run = (input: Record<string, unknown>, ctx: Partial<Parameters<typeof mergeAccounts>[0]> = {}) =>
  mergeAccounts({ orgId: ORG, clientId: null, user: ADMIN, ...ctx }, { keep_id: KEEP, merge_ids: [M1, M2], ...input } as any);

beforeEach(() => seed());

// ── pure helpers ────────────────────────────────────────────────────────────
describe('normaliseName', () => {
  it('lower-cases, drops legal suffixes and punctuation, collapses spaces', () => {
    expect(normaliseName('NTPC Lara Ltd.')).toBe('ntpc lara');
    expect(normaliseName('  NTPC   Lara  Private   Limited ')).toBe('ntpc lara');
    expect(normaliseName('The Tata Steel Co.')).toBe('tata steel');
    expect(normaliseName('Acme Corp, Inc')).toBe('acme');
    expect(normaliseName('Foo LLP')).toBe('foo');
    expect(normaliseName('N.T.P.C. Lara (Pvt.) Ltd')).toBe('ntpc lara');
  });
  it('turns & into and and ignores apostrophes and accents', () => {
    expect(normaliseName('Larsen & Toubro')).toBe('larsen and toubro');
    expect(normaliseName('Larsen and Toubro Ltd')).toBe('larsen and toubro');
    expect(normaliseName("Ben's Café")).toBe('bens cafe');
  });
  it('never normalises a real name to empty', () => {
    expect(normaliseName('The Company')).toBe('the company');
    expect(normaliseName(null)).toBe('');
    expect(normaliseName('...')).toBe('');
  });
});

describe('similarity', () => {
  it('levenshtein basics', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshteinRatio('abc', 'abc')).toBe(1);
    expect(levenshteinRatio('', '')).toBe(0);
  });
  it('is 1 for equal names and for the same words in another order', () => {
    expect(similarity('ntpc lara', 'ntpc lara')).toBe(1);
    expect(similarity('lara ntpc', 'ntpc lara')).toBe(1);
  });
  it('scores a typo above the default threshold and different companies below it', () => {
    expect(similarity('tata steell', 'tata steel')).toBeGreaterThanOrEqual(0.88);
    expect(similarity('ntpc lara', 'ntpc barh')).toBeLessThan(0.88);
    expect(similarity('tata steel', 'tata motors')).toBeLessThan(0.88);
  });
  it('is not a subset match: "ntpc" is not "ntpc lara"', () => {
    expect(similarity('ntpc', 'ntpc lara')).toBeLessThan(0.88);
  });
  it('never treats different numbers as a typo', () => {
    expect(similarity('plant 1001', 'plant 1002')).toBeLessThanOrEqual(0.5);
    expect(similarity('', 'x')).toBe(0);
  });
  it('parses min_score into 0.7..1 with a default', () => {
    expect(parseMinScore(undefined)).toBe(0.88);
    expect(parseMinScore('abc')).toBe(0.88);
    expect(parseMinScore('0.2')).toBe(0.7);
    expect(parseMinScore('5')).toBe(1);
    expect(parseMinScore('0.9')).toBe(0.9);
  });
});

describe('groupSimilarAccounts', () => {
  const rows = [
    { id: 'a', name: 'NTPC Lara', created_at: '2026-02-01' },
    { id: 'b', name: 'NTPC Lara Ltd.', created_at: '2026-01-01' },
    { id: 'c', name: 'ntpc lara pvt. ltd', created_at: '2026-03-01' },
    { id: 'd', name: 'Tata Steell', created_at: '2026-01-01' },
    { id: 'e', name: 'Tata Steel Limited', created_at: '2026-01-02' },
    { id: 'f', name: 'NTPC Barh', created_at: '2026-01-01' },
    { id: 'g', name: 'Reliance', created_at: '2026-01-01' },
  ];
  it('groups exact normalised matches at score 1, oldest first, and leaves non-matches out', () => {
    const groups = groupSimilarAccounts(rows);
    const ntpc = groups.find((g) => g.accounts.some((a) => a.id === 'a'))!;
    expect(ntpc.score).toBe(1);
    expect(ntpc.accounts.map((a) => a.id)).toEqual(['b', 'a', 'c']);
    expect(ntpc.key).toBe('ntpc lara');
    expect(groups.flatMap((g) => g.accounts.map((a) => a.id))).not.toContain('f');
    expect(groups.flatMap((g) => g.accounts.map((a) => a.id))).not.toContain('g');
  });
  it('groups near matches with a score below 1, and sorts exact groups first', () => {
    const groups = groupSimilarAccounts(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].score).toBe(1);
    const tata = groups[1];
    expect(tata.accounts.map((a) => a.id).sort()).toEqual(['d', 'e']);
    expect(tata.score).toBeGreaterThanOrEqual(0.88);
    expect(tata.score).toBeLessThan(1);
  });
  it('min_score 1 keeps only exact groups; a looser score is clamped to 0.7', () => {
    expect(groupSimilarAccounts(rows, 1)).toHaveLength(1);
    expect(groupSimilarAccounts(rows, 0.1).length).toBeGreaterThanOrEqual(2);
  });
  it('never groups across clients, and never makes a group of one', () => {
    const g = groupSimilarAccounts([
      { id: '1', name: 'Acme', client_id: 'c1' }, { id: '2', name: 'Acme Ltd', client_id: 'c2' }, { id: '3', name: 'Solo' },
    ]);
    expect(g).toEqual([]);
  });
  it('sorts by score desc then size desc and caps the group count', () => {
    const many = [
      { id: 'x1', name: 'Alpha One' }, { id: 'x2', name: 'Alpha One Ltd' },
      { id: 'y1', name: 'Beta Two' }, { id: 'y2', name: 'Beta Two' }, { id: 'y3', name: 'Beta Two Inc' },
    ];
    const g = groupSimilarAccounts(many);
    expect(g.map((x) => x.accounts.length)).toEqual([3, 2]);
    expect(groupSimilarAccounts(many, 0.88, 1)).toHaveLength(1);
  });
  it('does not group sites that differ only by a number', () => {
    expect(groupSimilarAccounts([{ id: '1', name: 'Plant 1001' }, { id: '2', name: 'Plant 1002' }])).toEqual([]);
  });
  it('handles a large input without comparing every pair', () => {
    const big = Array.from({ length: 4000 }, (_, i) => ({ id: String(i), name: `Company ${String.fromCharCode(97 + (i % 26))}${i} Works` }));
    const t0 = Date.now();
    groupSimilarAccounts(big);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

describe('computeKeepPatch', () => {
  it('fills only blank columns from the first merged account that has a value', () => {
    const keep = acct(KEEP, 'A', { city: 'Raipur', phone: '  ' });
    const patch = computeKeepPatch(keep, [
      acct(M1, 'A', { city: 'Korba', phone: '111', domain: 'a.com' }),
      acct(M2, 'A', { phone: '222', domain: 'other.com', industry: 'Power', owner_id: u(5) }),
    ]);
    expect(patch).toMatchObject({ phone: '111', domain: 'a.com', industry: 'Power', owner_id: u(5) });
    expect(patch.city).toBeUndefined();
  });
  it('unions tags and shallow-merges custom_fields with the kept values winning', () => {
    const keep = acct(KEEP, 'A', { tags: ['vip', 'b2b'], custom_fields: { grade: 'A', k: 1 } });
    const patch = computeKeepPatch(keep, [
      acct(M1, 'A', { tags: ['b2b', 'coal'], custom_fields: { grade: 'B', x: 'm1', y: 'm1' } }),
      acct(M2, 'A', { tags: ['coal', 'new'], custom_fields: { x: 'm2', z: 'm2', merged_into: 'old' } }),
    ]);
    expect(patch.tags).toEqual(['vip', 'b2b', 'coal', 'new']);
    expect(patch.custom_fields).toEqual({ grade: 'A', k: 1, x: 'm1', y: 'm1', z: 'm2' });
  });
  it('returns an empty patch when nothing changes, and skips columns the tenant lacks', () => {
    const keep: Row = { id: KEEP, name: 'A', tags: [], custom_fields: {} };
    expect(computeKeepPatch(keep, [acct(M1, 'A', { city: 'Korba' })])).toEqual({});
  });
  it('clears the parent when asked', () => {
    expect(computeKeepPatch(acct(KEEP, 'A', { parent_account_id: M1 }), [], { clearParent: true })).toEqual({ parent_account_id: null });
  });
});

describe('findDuplicateContacts', () => {
  it('pairs contacts that share an email (case-insensitive) or a digits-only phone, oldest as keep', () => {
    const d = findDuplicateContacts([
      { id: 'c1', email: 'Raj@X.com', phone: '+91 98765-43210', created_at: '2026-01-01' },
      { id: 'c2', email: 'raj@x.com', phone: null, created_at: '2026-02-01' },
      { id: 'c3', email: 'other@x.com', phone: '(91) 9876543210', created_at: '2026-03-01' },
      { id: 'c4', email: null, phone: '12', created_at: '2026-03-01' },
      { id: 'c5', email: null, phone: '12', created_at: '2026-03-02' },
    ]);
    expect(d).toEqual([
      { keep_contact_id: 'c1', other_contact_id: 'c2', reason: 'same_email' },
      { keep_contact_id: 'c1', other_contact_id: 'c3', reason: 'same_phone' },
    ]);
  });
});

describe('isMissingSchemaError', () => {
  it.each(['PGRST204', 'PGRST205', '42703', '42P01'])('treats %s as missing schema', (code) => {
    expect(isMissingSchemaError({ code, message: 'x' })).toBe(true);
  });
  it('matches the message and rejects other errors', () => {
    expect(isMissingSchemaError({ message: "Could not find the table 'x'" })).toBe(true);
    expect(isMissingSchemaError({ code: '23503', message: 'fk violation' })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });
});

// ── validation ──────────────────────────────────────────────────────────────
describe('accountMergeSchema', () => {
  it('accepts a good body', () => {
    expect(accountMergeSchema.parse({ keep_id: KEEP, merge_ids: [M1, M2], dry_run: true }).dry_run).toBe(true);
  });
  it('rejects keep_id inside merge_ids', () => {
    expect(() => accountMergeSchema.parse({ keep_id: KEEP, merge_ids: [M1, KEEP] })).toThrow(/keep_id/);
  });
  it('rejects more than 20 ids, none, duplicates and bad uuids', () => {
    expect(() => accountMergeSchema.parse({ keep_id: KEEP, merge_ids: Array.from({ length: 21 }, (_, i) => u(100 + i)) })).toThrow(/at most 20/);
    expect(() => accountMergeSchema.parse({ keep_id: KEEP, merge_ids: [] })).toThrow();
    expect(() => accountMergeSchema.parse({ keep_id: KEEP, merge_ids: [M1, M1] })).toThrow(/duplicates/);
    expect(() => accountMergeSchema.parse({ keep_id: 'nope', merge_ids: [M1] })).toThrow();
    expect(() => accountMergeSchema.parse({ keep_id: KEEP, merge_ids: ['nope'] })).toThrow();
  });
  it('accepts exactly 20 ids', () => {
    expect(accountMergeSchema.parse({ keep_id: KEEP, merge_ids: Array.from({ length: 20 }, (_, i) => u(100 + i)) }).merge_ids).toHaveLength(20);
  });
});

// ── GET /similar ────────────────────────────────────────────────────────────
describe('findSimilarAccountGroups', () => {
  it('returns groups with owner names and per-account counts', async () => {
    db.tables.crm_accounts.push(acct(u(4), 'Unrelated Corp'));
    account(M1).owner_id = u(500);
    db.tables.crm_contacts.push({ id: 'c1', account_id: M1, deleted_at: null }, { id: 'c2', account_id: M1, deleted_at: null }, { id: 'c3', account_id: KEEP, deleted_at: '2026-01-01' });
    db.tables.crm_leads.push({ id: 'l1', account_id: KEEP, deleted_at: null });
    db.tables.crm_deals.push({ id: 'd1', account_id: M2, deleted_at: null });
    const { groups } = await findSimilarAccountGroups({ orgId: ORG, clientId: null });
    expect(groups).toHaveLength(1);
    expect(groups[0].score).toBe(1);
    const byId = Object.fromEntries(groups[0].accounts.map((a) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual([KEEP, M1, M2].sort());
    expect(byId[M1]).toMatchObject({ owner_name: 'Asha', contact_count: 2, lead_count: 0, deal_count: 0 });
    expect(byId[KEEP]).toMatchObject({ contact_count: 0, lead_count: 1 });
    expect(byId[M2].deal_count).toBe(1);
    expect(Object.keys(byId[M1]).sort()).toEqual(
      ['contact_count', 'created_at', 'city', 'deal_count', 'id', 'industry', 'lead_count', 'name', 'owner_id', 'owner_name', 'state'].sort(),
    );
  });
  it('skips soft-deleted accounts and other clients when a client is in scope', async () => {
    account(M1).deleted_at = '2026-02-01';
    account(M2).client_id = 'client-b';
    account(KEEP).client_id = 'client-a';
    const { groups } = await findSimilarAccountGroups({ orgId: ORG, clientId: 'client-a' });
    expect(groups).toEqual([]);
  });
  it('a failing count query yields 0, not an error', async () => {
    db.failTables.crm_deals = 'boom';
    db.tables.crm_leads.push({ id: 'l1', account_id: KEEP, deleted_at: null });
    const { groups } = await findSimilarAccountGroups({ orgId: ORG, clientId: null });
    expect(groups[0].accounts.every((a) => a.deal_count === 0)).toBe(true);
    expect(groups[0].accounts.find((a) => a.id === KEEP)!.lead_count).toBe(1);
  });
  it('returns nothing when the owner visibility list is empty', async () => {
    expect(await findSimilarAccountGroups({ orgId: ORG, clientId: null, visibleOwnerIds: [] })).toEqual({ groups: [] });
  });
});

// ── POST /merge ─────────────────────────────────────────────────────────────
const seedRefs = () => {
  db.tables.crm_contacts.push({ id: 'ct1', account_id: M1, email: 'raj@x.com', phone: '98765 43210', created_at: '2026-01-01', deleted_at: null }, { id: 'ct2', account_id: M2, deleted_at: null });
  db.tables.crm_leads.push({ id: 'l1', account_id: M1, converted_account_id: null }, { id: 'l2', account_id: null, converted_account_id: M2 }, { id: 'l3', account_id: M1, converted_account_id: M1 });
  db.tables.crm_deals.push({ id: 'd1', account_id: M1 }, { id: 'd2', account_id: KEEP });
  db.tables.crm_activities.push({ id: 'a1', account_id: M2 });
  db.tables.crm_notes.push({ id: 'n1', account_id: M1 }, { id: 'n2', entity_type: 'account', entity_id: M2 }, { id: 'n3', entity_type: 'lead', entity_id: M2 });
  db.tables.crm_sites.push({ id: 's1', account_id: M1 });
  db.tables.crm_visits.push({ id: 'v1', account_id: M2 });
  db.tables.crm_account_updates.push({ id: 'u1', account_id: M1 });
  db.tables.expense_claims.push({ id: 'e1', account_id: M2 });
  db.tables.form_submissions.push({ id: 'f1', account_id: M1 });
  db.tables.crm_accounts.push(acct(u(10), 'Child plant', { parent_account_id: M1 }));
};

describe('mergeAccounts', () => {
  it('moves every listed reference to the kept account, then soft-deletes the merged ones', async () => {
    seedRefs();
    const r = await run({});
    expect(r.dry_run).toBe(false);
    expect(r.merged_ids).toEqual([M1, M2]);
    expect(r.skipped).toEqual([]);
    expect(r.moved).toEqual({
      contacts: 2, leads: 2, converted_leads: 2, deals: 1, activities: 1, notes: 2, sites: 1, visits: 1,
      account_updates: 1, expenses: 1, form_submissions: 1, child_accounts: 1,
    });
    for (const v of Object.values(r.moved)) expect(typeof v).toBe('number');
    const t = db.tables;
    expect(t.crm_contacts.every((c) => c.account_id === KEEP)).toBe(true);
    expect(t.crm_leads.map((l) => [l.account_id, l.converted_account_id])).toEqual([[KEEP, null], [null, KEEP], [KEEP, KEEP]]);
    expect(t.crm_deals.every((d) => d.account_id === KEEP)).toBe(true);
    expect(t.crm_activities[0].account_id).toBe(KEEP);
    expect(t.crm_notes[0].account_id).toBe(KEEP);
    expect(t.crm_notes[1].entity_id).toBe(KEEP);
    expect(t.crm_notes[2].entity_id).toBe(M2); // a LEAD note that happens to share the id column is untouched
    expect(t.crm_sites[0].account_id).toBe(KEEP);
    expect(t.crm_visits[0].account_id).toBe(KEEP);
    expect(t.crm_account_updates[0].account_id).toBe(KEEP);
    expect(t.expense_claims[0].account_id).toBe(KEEP);
    expect(t.form_submissions[0].account_id).toBe(KEEP);
    expect(account(u(10)).parent_account_id).toBe(KEEP);
    for (const id of [M1, M2]) {
      expect(account(id).deleted_at).toBeTruthy();
      expect(account(id).custom_fields.merged_into).toBe(KEEP);
      expect(typeof account(id).custom_fields.merged_at).toBe('string');
    }
    expect(account(KEEP).deleted_at).toBeNull();
    expect(r.kept.id).toBe(KEEP);
  });

  it('dry_run counts everything and writes nothing', async () => {
    seedRefs();
    const before = JSON.stringify(db.tables);
    const r = await run({ dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.moved).toMatchObject({ contacts: 2, leads: 2, converted_leads: 2, deals: 1, notes: 2, child_accounts: 1 });
    expect(db.writes).toEqual([]);
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it('skips a table that does not exist in this tenant and carries on', async () => {
    seedRefs();
    db.missingTables.add('crm_visits');
    db.missingCols.expense_claims = new Set(['account_id']);
    const r = await run({});
    expect(r.skipped.sort()).toEqual(['crm_visits', 'expense_claims']);
    expect(r.moved.visits).toBe(0);
    expect(r.moved.expenses).toBe(0);
    expect(r.moved.contacts).toBe(2);
    expect(account(M1).deleted_at).toBeTruthy();
    expect(db.tables.crm_visits[0].account_id).toBe(M2);
  });

  it('a missing entity_id / linked_to_id notes column is ignored silently', async () => {
    seedRefs();
    db.missingCols.crm_notes = new Set(['entity_id', 'linked_to_id']);
    const r = await run({});
    expect(r.skipped).toEqual([]);
    expect(r.moved.notes).toBe(1);
  });

  it('any other database error aborts with a 500 naming the table, and deletes nothing', async () => {
    seedRefs();
    db.failTables.crm_deals = 'deadlock detected';
    await expect(run({})).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('crm_deals') });
    expect(account(M1).deleted_at).toBeNull();
    expect(account(M2).deleted_at).toBeNull();
  });

  describe('parent / child accounts', () => {
    it('makes children of a merged account children of keep', async () => {
      seedRefs();
      await run({});
      expect(account(u(10)).parent_account_id).toBe(KEEP);
    });
    it('clears keep.parent_account_id when its parent is a merged account (no self-parent)', async () => {
      account(KEEP).parent_account_id = M1;
      const r = await run({});
      expect(account(KEEP).parent_account_id).toBeNull();
      expect(r.moved.child_accounts).toBe(0); // keep itself is not "a child to move"
      expect(r.kept.parent_account_id).toBeNull();
    });
    it('also clears it when a deeper ancestor is merged (would otherwise loop)', async () => {
      db.tables.crm_accounts.push(acct(u(20), 'Middle', { parent_account_id: M2 }));
      account(KEEP).parent_account_id = u(20);
      await run({});
      expect(account(KEEP).parent_account_id).toBeNull();
      expect(account(u(20)).parent_account_id).toBe(KEEP);
    });
    it('leaves keep.parent_account_id alone when its parent is unrelated', async () => {
      db.tables.crm_accounts.push(acct(u(30), 'Group HQ'));
      account(KEEP).parent_account_id = u(30);
      await run({});
      expect(account(KEEP).parent_account_id).toBe(u(30));
    });
    it('does not re-point a merged account that was a child of another merged account', async () => {
      account(M2).parent_account_id = M1;
      const r = await run({});
      expect(r.moved.child_accounts).toBe(0);
      expect(account(M2).parent_account_id).toBe(M1);
    });
  });

  it('fills blanks, unions tags and merges custom_fields on the kept account', async () => {
    Object.assign(account(KEEP), { city: 'Raipur', tags: ['vip'], custom_fields: { grade: 'A' } });
    Object.assign(account(M1), { city: 'Korba', phone: '111', domain: 'lara.in', tags: ['coal'], custom_fields: { grade: 'B', x: 1 } });
    Object.assign(account(M2), { phone: '222', industry: 'Power', owner_id: u(500), tags: ['coal', 'vip'] });
    const r = await run({});
    const k = account(KEEP);
    expect(k).toMatchObject({ city: 'Raipur', phone: '111', domain: 'lara.in', industry: 'Power', owner_id: u(500) });
    expect(k.tags).toEqual(['vip', 'coal']);
    expect(k.custom_fields).toEqual({ grade: 'A', x: 1 });
    expect(r.kept).toMatchObject({ phone: '111', owner_name: 'Asha' });
  });

  it('writes only the changed columns to the kept row', async () => {
    account(M1).phone = '111';
    await run({});
    const keepWrite = db.writes.find((w) => w.startsWith('crm_accounts:') && w.includes('phone'));
    expect(keepWrite).toBeDefined();
    expect(keepWrite!.split(':')[1].split(',').filter((c) => c !== 'updated_by')).toEqual(['phone']);
  });

  it('survives a tenant missing optional account columns (resilient write)', async () => {
    account(M1).phone = '111';
    account(M1).address_line1 = '1 Mall Road';
    db.missingCols.crm_accounts = new Set(['address_line1']); // PostgREST rejects the column, as on the live Kinematic DB
    const r = await run({});
    expect(account(KEEP).phone).toBe('111');
    expect(account(KEEP).address_line1).toBeNull();
    expect(r.merged_ids).toHaveLength(2);
    expect(account(M1).deleted_at).toBeTruthy();
  });

  it('reports duplicate contacts under the kept account without merging them', async () => {
    db.tables.crm_contacts.push(
      { id: 'ct1', account_id: KEEP, email: 'Raj@x.com', phone: null, created_at: '2026-01-01', deleted_at: null },
      { id: 'ct2', account_id: M1, email: 'raj@x.com', phone: '98765 43210', created_at: '2026-02-01', deleted_at: null },
      { id: 'ct3', account_id: M2, email: 'z@x.com', phone: '98765-43210', created_at: '2026-03-01', deleted_at: null },
    );
    const r = await run({});
    expect(r.duplicate_contacts).toEqual([
      { keep_contact_id: 'ct1', other_contact_id: 'ct2', reason: 'same_email' },
      { keep_contact_id: 'ct2', other_contact_id: 'ct3', reason: 'same_phone' },
    ]);
    expect(db.tables.crm_contacts).toHaveLength(3); // nothing removed
    expect(db.tables.crm_contacts.every((c) => c.account_id === KEEP)).toBe(true);
  });

  it('dry run previews duplicate contacts across keep and the accounts to be merged', async () => {
    db.tables.crm_contacts.push(
      { id: 'ct1', account_id: KEEP, email: 'raj@x.com', created_at: '2026-01-01', deleted_at: null },
      { id: 'ct2', account_id: M1, email: 'raj@x.com', created_at: '2026-02-01', deleted_at: null },
    );
    const r = await run({ dry_run: true });
    expect(r.duplicate_contacts).toEqual([{ keep_contact_id: 'ct1', other_contact_id: 'ct2', reason: 'same_email' }]);
  });

  describe('permissions and validation', () => {
    it('forbids non-admins (403) before touching anything', async () => {
      seedRefs();
      await expect(run({}, { user: REP })).rejects.toMatchObject({ statusCode: 403 });
      await expect(run({}, { user: undefined })).rejects.toMatchObject({ statusCode: 403 });
      expect(db.writes).toEqual([]);
    });
    it.each(['super_admin', 'admin', 'main_admin', 'sub_admin', 'client', 'city_manager'])('allows %s', async (role) => {
      seed();
      await expect(run({ dry_run: true }, { user: { id: u(1), role } })).resolves.toBeDefined();
    });
    it('rejects keep_id inside merge_ids and too many ids at the service level too', async () => {
      await expect(run({ merge_ids: [KEEP] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(run({ merge_ids: Array.from({ length: 21 }, (_, i) => u(100 + i)) })).rejects.toMatchObject({ statusCode: 400 });
      await expect(run({ merge_ids: [M1, M1] })).rejects.toMatchObject({ statusCode: 400 });
    });
    it('404s on an unknown account and writes nothing', async () => {
      await expect(run({ merge_ids: [M1, u(77)] })).rejects.toMatchObject({ statusCode: 404 });
      expect(db.writes).toEqual([]);
    });
    it('404s on an account outside the caller client scope', async () => {
      account(M1).client_id = 'client-b';
      account(KEEP).client_id = 'client-a';
      account(M2).client_id = 'client-a';
      await expect(run({}, { clientId: 'client-a' })).rejects.toMatchObject({ statusCode: 404 });
      expect(db.writes).toEqual([]);
    });
    it('refuses to merge accounts of different clients when no client is picked', async () => {
      account(M1).client_id = 'client-b';
      account(KEEP).client_id = 'client-a';
      account(M2).client_id = 'client-a';
      await expect(run({})).rejects.toMatchObject({ statusCode: 400 });
      expect(db.writes).toEqual([]);
    });
    it('is idempotent: merging an already-merged account is a clear 400 and writes nothing', async () => {
      seedRefs();
      await run({});
      const writesAfterFirst = db.writes.length;
      const err: AppError = await run({}).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/already merged into/);
      expect(db.writes).toHaveLength(writesAfterFirst);
    });
    it('rejects a deleted keep account', async () => {
      account(KEEP).deleted_at = '2026-01-01';
      await expect(run({})).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
