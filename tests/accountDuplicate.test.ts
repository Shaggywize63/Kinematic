/**
 * Manual "New Account" duplicate guard + the account → leads sub-resource route, against an
 * in-memory PostgREST fake (same style as leadRefAndType.test.ts).
 *
 *   - POST /crm/accounts blocks a same-name duplicate in the SAME org + client scope with
 *     409 DUPLICATE_ACCOUNT (and surfaces the existing { id, name }); the match is trimmed +
 *     case-insensitive, ignores soft-deleted rows, and never crosses a client or org boundary.
 *   - A uniquely-named account still creates (201); a crafted name with PostgREST-reserved
 *     characters cannot break the scoping (injection-guarded) and still creates.
 *   - GET /crm/accounts/:id/leads returns the account's leads (account_id filter), and a tenant
 *     whose crm_leads predates the account_id column gets an empty list, not a 500.
 */
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;

interface FakeDb {
  tables: Record<string, Row[]>;
  missingCols: Record<string, Set<string>>;
  seq: number;
}

jest.mock('../src/lib/supabase', () => {
  const db: FakeDb = { tables: {}, missingCols: {}, seq: 0 };

  const splitOr = (expr: string) => expr.split(/,(?![^()]*\))/);
  const likeToRegex = (pat: string): RegExp => {
    let out = '';
    for (const c of pat) out += c === '%' || c === '*' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(`^${out}$`, 'is');
  };
  const ilike = (v: unknown, pat: string) => v !== null && v !== undefined && likeToRegex(pat).test(String(v));
  const orParts = (expr: string) => splitOr(expr).map((p) => {
    const m = /^([a-z_>-]+)\.(is|eq|ilike|in)\.(.*)$/.exec(p)!;
    const [, col, op, val] = m;
    const test = op === 'is' ? (r: Row) => r[col] === null || r[col] === undefined
      : op === 'eq' ? (r: Row) => String(r[col]) === val.replace(/^"|"$/g, '')
      : op === 'ilike' ? (r: Row) => ilike(r[col], val)
      : (() => { const set = new Set(val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))); return (r: Row) => set.has(String(r[col])); })();
    return { col, test };
  });

  class Q {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: any;
    private preds: Array<(r: Row) => boolean> = [];
    private cols: string[] = [];
    private orders: Array<{ c: string; asc: boolean }> = [];
    private returning = false;
    private from = 0;
    private to = Infinity;
    private mode: 'many' | 'single' | 'maybe' = 'many';
    constructor(private t: string) {}
    select(c?: string) {
      if (this.op === 'select' && c && c !== '*') this.cols.push(...c.split(',').map((x) => x.trim()).filter((x) => /^[a-z_]+$/.test(x)));
      if (this.op !== 'select') this.returning = true;
      return this;
    }
    insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
    update(p: Row) { this.op = 'update'; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.cols.push(c); this.preds.push((r) => String(r[c]) === String(v)); return this; }
    in(c: string, vs: unknown[]) { this.cols.push(c); const s = new Set(vs.map(String)); this.preds.push((r) => s.has(String(r[c]))); return this; }
    is(c: string, v: null) { this.cols.push(c); this.preds.push((r) => (r[c] ?? null) === v); return this; }
    gte(c: string, v: any) { this.cols.push(c); this.preds.push((r) => String(r[c]) >= String(v)); return this; }
    lte(c: string, v: any) { this.cols.push(c); this.preds.push((r) => String(r[c]) <= String(v)); return this; }
    ilike(c: string, pat: string) { this.cols.push(c); this.preds.push((r) => ilike(r[c], pat)); return this; }
    or(expr: string) {
      const parts = orParts(expr);
      parts.forEach((p) => this.cols.push(p.col));
      this.preds.push((r) => parts.some((p) => p.test(r)));
      return this;
    }
    order(c: string, o?: { ascending?: boolean }) { this.orders.push({ c, asc: o?.ascending !== false }); return this; }
    limit(n: number) { this.to = this.from + n - 1; return this; }
    range(a: number, b: number) { this.from = a; this.to = b; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }

    private finish(rows: Row[]): any {
      const data = rows.map((r) => ({ ...r }));
      if (this.mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      if (this.mode === 'maybe') return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }

    private run(): any {
      const t = this.t;
      const gone = db.missingCols[t];
      const payloadRows: Row[] = this.op === 'insert' ? (Array.isArray(this.payload) ? this.payload : [this.payload]) : this.op === 'update' ? [this.payload] : [];
      const touched = [...this.cols, ...payloadRows.flatMap((r) => Object.keys(r))];
      const bad = gone ? touched.find((c) => gone.has(c)) : undefined;
      if (bad) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${t}' in the schema cache` } };
      const rows = (db.tables[t] ??= []);

      if (this.op === 'insert') {
        const made: Row[] = [];
        for (const p of payloadRows) {
          made.push({ id: `00000000-0000-4000-8000-${String(++db.seq + 100000).padStart(12, '0')}`, deleted_at: null, created_at: '2026-06-01T00:00:00Z', ...p });
        }
        rows.push(...made);
        return this.returning ? this.finish(made) : { data: null, error: null };
      }

      const hit = rows.filter((r) => this.preds.every((p) => p(r)));
      let sorted = hit.slice();
      for (const { c, asc } of [...this.orders].reverse()) {
        sorted = sorted.sort((a, b) => {
          const x = a[c] ?? ''; const y = b[c] ?? '';
          const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
          return asc ? cmp : -cmp;
        });
      }
      return this.finish(sorted.slice(this.from, this.to + 1));
    }
    then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  }

  const client = { from: (t: string) => new Q(t), rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null }, error: { message: 'mock' } }) } };
  return { __db: db, supabaseAdmin: client, supabase: client, getUserClient: () => client };
});

// The create path's custom-field validation is not under test here — pass it through.
jest.mock('../src/services/crm/customFields.service', () => ({
  ...jest.requireActual('../src/services/crm/customFields.service'),
  validateAndStampCustomFields: jest.fn(async (_o: string, _c: string | null, _e: string, cf: unknown) => cf ?? {}),
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn(async () => undefined) }));

let mockUser: Row = {};
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => { req.user = { ...mockUser }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db: db } = require('../src/lib/supabase') as { __db: FakeDb };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const ORG2 = '00000000-0000-0000-0000-0000000000bb';
const CLIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const adminA = { id: '33333333-3333-3333-3333-333333333333', org_id: ORG, role: 'admin', client_id: CLIENT_A, org_role_data_scope: 'all' };

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? err.statusCode ?? 500).json({ success: false, error: { code: err.code ?? 'UNHANDLED', message: err.message } }));
const get = (url: string) => request(app).get(url);
const post = (url: string, body: unknown) => request(app).post(url).send(body as object);

let n = 0;
const uid = () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const account = (extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: CLIENT_A, name: 'Acme Corp', deleted_at: null, created_at: '2026-05-01T00:00:00Z', ...extra };
  (db.tables.crm_accounts ??= []).push(row);
  return row;
};
const lead = (extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: CLIENT_A, first_name: 'Asha', account_id: null, deleted_at: null, created_at: '2026-05-01T00:00:00Z', ...extra };
  (db.tables.crm_leads ??= []).push(row);
  return row;
};

beforeEach(() => {
  db.tables = { crm_accounts: [], crm_leads: [] };
  db.missingCols = {};
  db.seq = 0;
  n = 0;
  mockUser = { ...adminA };
});

describe('POST /crm/accounts — duplicate-name guard', () => {
  it('creates a uniquely-named account (201)', async () => {
    const res = await post('/crm/accounts', { name: 'Brand New Co' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Brand New Co', org_id: ORG, client_id: CLIENT_A });
    expect(db.tables.crm_accounts).toHaveLength(1);
  });

  it('blocks a same-name duplicate with 409 DUPLICATE_ACCOUNT and the existing { id, name }', async () => {
    const existing = account({ name: 'Acme Corp' });
    const res = await post('/crm/accounts', { name: 'Acme Corp' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      code: 'DUPLICATE_ACCOUNT',
      error: 'An account named "Acme Corp" already exists',
      existing: { id: existing.id, name: 'Acme Corp' },
    });
    // nothing inserted
    expect(db.tables.crm_accounts).toHaveLength(1);
  });

  it('matches case-insensitively and after trimming whitespace', async () => {
    const existing = account({ name: 'Acme Corp' });
    for (const name of ['acme corp', '  ACME CORP  ', 'Acme Corp']) {
      const res = await post('/crm/accounts', { name });
      expect(res.status).toBe(409);
      expect(res.body.existing.id).toBe(existing.id);
    }
    expect(db.tables.crm_accounts).toHaveLength(1);
  });

  it('ignores soft-deleted accounts (a deleted same-name does not block)', async () => {
    account({ name: 'Ghost Ltd', deleted_at: '2026-04-01T00:00:00Z' });
    const res = await post('/crm/accounts', { name: 'Ghost Ltd' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Ghost Ltd');
  });

  it('is tenant-safe: the same name under a DIFFERENT client is not blocked', async () => {
    account({ name: 'Shared Name', client_id: CLIENT_B });
    const res = await post('/crm/accounts', { name: 'Shared Name' }); // caller scoped to CLIENT_A
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Shared Name', client_id: CLIENT_A });
  });

  it('is tenant-safe: the same name in a DIFFERENT org is not blocked', async () => {
    account({ name: 'Org2 Co', org_id: ORG2 });
    const res = await post('/crm/accounts', { name: 'Org2 Co' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Org2 Co', org_id: ORG });
  });

  it('injection-guarded: a crafted name cannot break scoping and still creates', async () => {
    // A name that, unescaped, could try to smuggle an extra PostgREST predicate.
    account({ name: 'Secret', org_id: ORG2 });
    const crafted = 'New,org_id.eq.' + ORG2;
    const res = await post('/crm/accounts', { name: crafted });
    expect(res.status).toBe(201); // not matched against ORG2's row, no 500
    expect(res.body.data.name).toBe(crafted);
  });
});

describe('GET /crm/accounts/:id/leads', () => {
  it('returns the leads linked to the account (account_id filter), scoped to the org', async () => {
    const acc = account({ name: 'Linked Co' });
    lead({ first_name: 'Linked One', account_id: acc.id });
    lead({ first_name: 'Linked Two', account_id: acc.id });
    lead({ first_name: 'Other', account_id: uid() });        // different account
    lead({ first_name: 'Unlinked', account_id: null });      // no account

    const res = await get(`/crm/accounts/${acc.id}/leads`);
    expect(res.status).toBe(200);
    const names = res.body.data.map((r: Row) => r.first_name).sort();
    expect(names).toEqual(['Linked One', 'Linked Two']);
  });

  it('returns an empty list (not 500) on a tenant whose crm_leads predates account_id', async () => {
    const acc = account({ name: 'Old Tenant Co' });
    db.missingCols.crm_leads = new Set(['account_id']);
    const res = await get(`/crm/accounts/${acc.id}/leads`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
