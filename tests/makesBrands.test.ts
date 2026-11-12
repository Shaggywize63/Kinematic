/**
 * Makes and Brands (CRM product catalogue) over HTTP, against an in-memory PostgREST fake:
 *
 *   - /makes and /brands: CRUD, case-insensitive duplicate names (per org + client), in-use delete, product_count;
 *   - products: make_id / brand_id validation, make_name / brand_name stamping, list filters, reference
 *     uniqueness on create and patch;
 *   - POST /products/bulk: create / update / skip / errors, create_missing and update_existing off, price parsing,
 *     duplicate references in the file, the 2000-row cap, category matching;
 *   - a database without the migration: 503 NOT_MIGRATED on writes, product reads keep working.
 */
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;

// ── in-memory PostgREST fake ────────────────────────────────────────────────
interface FakeDb {
  tables: Record<string, Row[]>;
  missingTables: Set<string>;
  missingCols: Record<string, Set<string>>;
  failTables: Record<string, string>;
  seq: number;
  /** Runs once before the next insert (simulates a concurrent writer). */
  beforeInsert?: () => void;
  /** Refuses an inserted row with this message (simulates a database constraint). */
  rejectInsert?: (table: string, row: Row) => string | undefined;
}

jest.mock('../src/lib/supabase', () => {
  const db: FakeDb = { tables: {}, missingTables: new Set(), missingCols: {}, failTables: {}, seq: 0 };

  const splitOr = (expr: string) => expr.split(/,(?![^()]*\))/);
  const likeToRegex = (pat: string): RegExp => {
    let out = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '\\' && i + 1 < pat.length) { out += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
      if (c === '%' || c === '*') out += '.*';
      else if (c === '_') out += '.';
      else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`, 'is');
  };
  const ilike = (v: unknown, pat: string) => v !== null && v !== undefined && likeToRegex(pat).test(String(v));
  const orPred = (expr: string): ((r: Row) => boolean) => {
    const parts = splitOr(expr).map((p) => {
      const m = /^([a-z_]+)\.(is|eq|ilike|in)\.(.*)$/.exec(p)!;
      const [, col, op, val] = m;
      if (op === 'is') return (r: Row) => r[col] === null || r[col] === undefined;
      if (op === 'eq') return (r: Row) => String(r[col]) === val;
      if (op === 'ilike') return (r: Row) => ilike(r[col], val);
      const set = new Set(val.replace(/^\(|\)$/g, '').split(','));
      return (r: Row) => set.has(String(r[col]));
    });
    return (r) => parts.some((p) => p(r));
  };

  const uniqueKey = (t: string, r: Row) => `${r.org_id}|${r.client_id ?? ''}|${String(r.name).toLowerCase()}`;

  class Q {
    private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private payload: any;
    private preds: Array<(r: Row) => boolean> = [];
    private cols: string[] = [];
    private orders: Array<{ c: string; asc: boolean }> = [];
    private head = false;
    private wantCount = false;
    private returning = false;
    private from = 0;
    private to = Infinity;
    private mode: 'many' | 'single' | 'maybe' = 'many';
    constructor(private t: string) {}
    select(_c?: string, o?: { count?: string; head?: boolean }) {
      if (this.op !== 'select') this.returning = true;
      this.wantCount = o?.count === 'exact'; this.head = !!o?.head; return this;
    }
    insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
    update(p: Row) { this.op = 'update'; this.payload = p; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c: string, v: unknown) { this.cols.push(c); this.preds.push((r) => String(r[c]) === String(v)); return this; }
    neq(c: string, v: unknown) { this.cols.push(c); this.preds.push((r) => String(r[c]) !== String(v)); return this; }
    in(c: string, vs: unknown[]) { this.cols.push(c); const s = new Set(vs.map(String)); this.preds.push((r) => s.has(String(r[c]))); return this; }
    is(c: string, v: null) { this.cols.push(c); this.preds.push((r) => (r[c] ?? null) === v); return this; }
    ilike(c: string, pat: string) { this.cols.push(c); this.preds.push((r) => ilike(r[c], pat)); return this; }
    or(expr: string) { const p = orPred(expr); this.preds.push(p); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orders.push({ c, asc: o?.ascending !== false }); return this; }
    limit(n: number) { this.to = this.from + n - 1; return this; }
    range(a: number, b: number) { this.from = a; this.to = b; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }

    private finish(rows: Row[], count?: number): any {
      const data = rows.map((r) => ({ ...r }));
      if (this.mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      if (this.mode === 'maybe') return { data: data[0] ?? null, error: null };
      return { data, error: null, ...(this.wantCount ? { count: count ?? rows.length } : {}) };
    }

    private run(): any {
      const t = this.t;
      if (db.failTables[t]) return { data: null, error: { code: 'XX000', message: db.failTables[t] } };
      if (db.missingTables.has(t)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` } };
      const gone = db.missingCols[t];
      const payloadRows: Row[] = this.op === 'insert' ? (Array.isArray(this.payload) ? this.payload : [this.payload]) : this.op === 'update' ? [this.payload] : [];
      const touched = [...this.cols, ...payloadRows.flatMap((r) => Object.keys(r))];
      const bad = gone ? touched.find((c) => gone.has(c)) : undefined;
      if (bad) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${t}' in the schema cache` } };
      const rows = (db.tables[t] ??= []);

      if (this.op === 'insert') {
        if (db.beforeInsert) { const f = db.beforeInsert; db.beforeInsert = undefined; f(); }
        const made: Row[] = [];
        for (const p of payloadRows) {
          const refused = db.rejectInsert?.(t, p);
          if (refused) return { data: null, error: { code: '23514', message: refused } };
          const row: Row = { id: `00000000-0000-4000-8000-${String(++db.seq + 100000).padStart(12, '0')}`, deleted_at: null, created_at: '2026-01-01T00:00:00Z', ...p };
          if ((t === 'crm_makes' || t === 'crm_brands')) {
            const clash = rows.concat(made).some((r) => !r.deleted_at && uniqueKey(t, r) === uniqueKey(t, row));
            if (clash) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "uq_${t}_org_client_name"` } };
          }
          made.push(row);
        }
        rows.push(...made);
        return this.returning ? this.finish(made) : { data: null, error: null };
      }

      const hit = rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.op === 'update') {
        hit.forEach((r) => Object.assign(r, this.payload));
        return this.returning ? this.finish(hit) : { data: null, error: null };
      }
      if (this.op === 'delete') { db.tables[t] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }

      let sorted = hit.slice();
      for (const { c, asc } of [...this.orders].reverse()) {
        sorted = sorted.sort((a, b) => {
          const x = a[c] ?? ''; const y = b[c] ?? '';
          const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
          return asc ? cmp : -cmp;
        });
      }
      if (this.head) return { data: null, error: null, count: sorted.length };
      return this.finish(sorted.slice(this.from, this.to + 1), sorted.length);
    }
    then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  }
  const client = { from: (t: string) => new Q(t), auth: { getUser: async () => ({ data: { user: null }, error: { message: 'mock' } }) } };
  return { __db: db, supabaseAdmin: client, supabase: client, getUserClient: () => client };
});
jest.mock('../src/services/ai.service', () => ({
  AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) },
}));
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: null };
    next();
  },
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
import { parsePrice } from '../src/services/crm/productImport.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
const CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOT_MIGRATED = 'Makes and brands are not set up in this database yet. Apply migration_makes_brands.sql.';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ success: false, error: { code: 'UNHANDLED', message: err.message } }));

const get = (url: string, client?: string) => { const r = request(app).get(url); return client ? r.set('X-Client-Id', client) : r; };
const post = (url: string, body: unknown, client?: string) => { const r = request(app).post(url).send(body as object); return client ? r.set('X-Client-Id', client) : r; };
const patch = (url: string, body: unknown, client?: string) => { const r = request(app).patch(url).send(body as object); return client ? r.set('X-Client-Id', client) : r; };
const del = (url: string, client?: string) => { const r = request(app).delete(url); return client ? r.set('X-Client-Id', client) : r; };

let n = 0;
const uid = () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const tax = (table: 'crm_makes' | 'crm_brands', name: string, extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: null, name, description: null, is_active: true, sort_order: 0, deleted_at: null, ...extra };
  db.tables[table].push(row);
  return row;
};
const product = (sku: string, extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: null, sku, name: `Product ${sku}`, price: 0, is_active: true, deleted_at: null, make_id: null, brand_id: null, ...extra };
  db.tables.crm_products.push(row);
  return row;
};
const products = () => db.tables.crm_products;

beforeEach(() => {
  db.tables = { crm_makes: [], crm_brands: [], crm_products: [], crm_product_categories: [] };
  db.missingTables = new Set(); db.missingCols = {}; db.failTables = {}; db.seq = 0;
  db.beforeInsert = undefined; db.rejectInsert = undefined;
});

// ── makes / brands CRUD ─────────────────────────────────────────────────────
describe.each([
  ['makes', 'make', 'crm_makes', 'make_id'],
  ['brands', 'brand', 'crm_brands', 'brand_id'],
] as const)('/%s', (path, label, table, column) => {
  const Label = label[0].toUpperCase() + label.slice(1);
  const url = `/crm/${path}`;

  it('creates (201), lists sorted by sort_order then name with product_count, and defaults the fields', async () => {
    const created = await post(url, { name: '  Zeta  ' });
    expect(created.status).toBe(201);
    expect(created.body.success).toBe(true);
    expect(created.body.data).toMatchObject({ name: 'Zeta', is_active: true, sort_order: 0, org_id: ORG, client_id: null, product_count: 0 });
    await post(url, { name: 'Alpha', sort_order: 5, description: 'first' });
    await post(url, { name: 'Beta', sort_order: 0 });
    const zeta = db.tables[table].find((r) => r.name === 'Zeta')!;
    product('P1', { [column]: zeta.id });
    product('P2', { [column]: zeta.id });
    product('P3', { [column]: zeta.id, deleted_at: '2026-01-02T00:00:00Z' }); // deleted products don't count

    const list = await get(url);
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: Row) => r.name)).toEqual(['Beta', 'Zeta', 'Alpha']);
    expect(list.body.data.map((r: Row) => r.product_count)).toEqual([0, 2, 0]);
  });

  it('filters by q (name) and is_active', async () => {
    tax(table, 'Parker'); tax(table, 'Festo'); tax(table, 'Park Lane', { is_active: false });
    expect((await get(`${url}?q=park`)).body.data.map((r: Row) => r.name).sort()).toEqual(['Park Lane', 'Parker']);
    expect((await get(`${url}?is_active=false`)).body.data.map((r: Row) => r.name)).toEqual(['Park Lane']);
    expect((await get(`${url}?is_active=true&q=park`)).body.data.map((r: Row) => r.name)).toEqual(['Parker']);
  });

  it('validates the name (required, 1..120) and the other fields', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 'ok', sort_order: 1.5 }, { name: 'ok', is_active: 'yes' }]) {
      const res = await post(url, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
    expect((await post(url, { name: 'x'.repeat(120) })).status).toBe(201);
  });

  it('refuses a duplicate name case-insensitively with 409 DUPLICATE', async () => {
    await post(url, { name: 'Acme' });
    const dup = await post(url, { name: ' ACME ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toEqual({ code: 'DUPLICATE', message: `A ${label} named "ACME" already exists` });
    expect(db.tables[table]).toHaveLength(1);
  });

  it('allows the same name in another client, and again once the first one is deleted', async () => {
    await post(url, { name: 'Acme' });
    expect((await post(url, { name: 'acme' }, CLIENT)).status).toBe(201);
    const first = db.tables[table].find((r) => r.client_id === null)!;
    expect((await del(`${url}/${first.id}`)).status).toBe(204);
    expect((await post(url, { name: 'ACME' })).status).toBe(201);
  });

  it('maps a unique-index race (23505) to the same 409', async () => {
    // another writer inserts the same name between our pre-check and our insert
    db.beforeInsert = () => { tax(table, 'Racy'); };
    const res = await post(url, { name: 'racy' });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'DUPLICATE', message: `A ${label} named "racy" already exists` });
    expect(db.tables[table]).toHaveLength(1);
  });

  it('PATCH updates partially, refuses renaming onto another name, and 404s an unknown id', async () => {
    const a = tax(table, 'Alpha'); tax(table, 'Beta');
    const ok = await patch(`${url}/${a.id}`, { description: 'x', is_active: false, sort_order: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Alpha', description: 'x', is_active: false, sort_order: 3, product_count: 0 });
    const clash = await patch(`${url}/${a.id}`, { name: 'BETA' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('DUPLICATE');
    // renaming to a different case of itself is fine
    expect((await patch(`${url}/${a.id}`, { name: 'ALPHA' })).body.data.name).toBe('ALPHA');
    const missing = await patch(`${url}/${uid()}`, { name: 'Nope' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe(`${Label} not found`);
    expect((await patch(`${url}/not-a-uuid`, { name: 'Nope' })).status).toBe(404);
    expect((await patch(`${url}/${a.id}`, { name: '' })).status).toBe(400);
  });

  it('DELETE soft-deletes an unused row (204) and the row disappears from the list', async () => {
    const a = tax(table, 'Alpha');
    expect((await del(`${url}/${a.id}`)).status).toBe(204);
    expect(a.deleted_at).toBeTruthy();
    expect((await get(url)).body.data).toEqual([]);
    expect((await del(`${url}/${a.id}`)).status).toBe(404);
  });

  it('DELETE of a row still used by live products is 409 IN_USE (deleted products do not count)', async () => {
    const a = tax(table, 'Alpha');
    product('P1', { [column]: a.id }); product('P2', { [column]: a.id });
    const res = await del(`${url}/${a.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'IN_USE', message: 'Used by 2 products. Switch it off instead.' });
    expect(a.deleted_at).toBeNull();
    products().forEach((p) => { p.deleted_at = '2026-02-01T00:00:00Z'; });
    expect((await del(`${url}/${a.id}`)).status).toBe(204);
  });

  it('is isolated per org and per client', async () => {
    tax(table, 'Other org', { org_id: OTHER_ORG });
    tax(table, 'Org level'); tax(table, 'Client level', { client_id: CLIENT });
    const other = tax(table, 'Another client', { client_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    expect((await get(url)).body.data.map((r: Row) => r.name).sort()).toEqual(['Another client', 'Client level', 'Org level']);
    // a picked client is strict (its own rows only), like the other tenant-isolated CRM lists
    expect((await get(url, CLIENT)).body.data.map((r: Row) => r.name)).toEqual(['Client level']);
    expect((await patch(`${url}/${other.id}`, { name: 'x' }, CLIENT)).status).toBe(404);
  });

  it('creates under the caller client', async () => {
    const res = await post(url, { name: 'Scoped' }, CLIENT);
    expect(res.body.data.client_id).toBe(CLIENT);
  });

  it('answers 503 NOT_MIGRATED when the table is missing (every verb)', async () => {
    db.missingTables.add(table);
    const id = uid();
    for (const res of [await get(url), await post(url, { name: 'A' }), await patch(`${url}/${id}`, { name: 'A' }), await del(`${url}/${id}`)]) {
      expect(res.status).toBe(503);
      expect(res.body.error).toEqual({ code: 'NOT_MIGRATED', message: NOT_MIGRATED });
    }
  });

  it('any other database failure stays a DB_ERROR, not NOT_MIGRATED', async () => {
    db.failTables[table] = 'disk on fire';
    const res = await get(url);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_ERROR');
  });
});

// ── products: make / brand links ────────────────────────────────────────────
describe('product make_id / brand_id', () => {
  it('accepts a live make and brand on create and returns make_name / brand_name', async () => {
    const make = tax('crm_makes', 'Festo'); const brand = tax('crm_brands', 'MAC');
    const res = await post('/crm/products', { sku: '13280', name: 'Valve', make_id: make.id, brand_id: brand.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ sku: '13280', make_id: make.id, brand_id: brand.id, make_name: 'Festo', brand_name: 'MAC' });
    expect(products()[0]).toMatchObject({ make_id: make.id, brand_id: brand.id, org_id: ORG });
  });

  it('rejects an unknown, deleted or other-org make/brand with 400 VALIDATION', async () => {
    const gone = tax('crm_makes', 'Old', { deleted_at: '2026-01-01T00:00:00Z' });
    const foreign = tax('crm_brands', 'Foreign', { org_id: OTHER_ORG });
    for (const [body, message] of [
      [{ make_id: uid() }, 'Make not found'],
      [{ make_id: gone.id }, 'Make not found'],
      [{ brand_id: uid() }, 'Brand not found'],
      [{ brand_id: foreign.id }, 'Brand not found'],
    ] as const) {
      const res = await post('/crm/products', { sku: 'X1', name: 'X', ...body });
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: 'VALIDATION', message });
    }
    expect(products()).toHaveLength(0);
    // a malformed id is a plain schema error
    expect((await post('/crm/products', { sku: 'X1', name: 'X', make_id: 'nope' })).status).toBe(400);
  });

  it('PATCH sets, changes and clears the links, validating each id', async () => {
    const m1 = tax('crm_makes', 'Festo'); const m2 = tax('crm_makes', 'SMC'); const b = tax('crm_brands', 'PHD');
    const p = product('A1');
    let res = await patch(`/crm/products/${p.id}`, { make_id: m1.id, brand_id: b.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ make_name: 'Festo', brand_name: 'PHD' });
    res = await patch(`/crm/products/${p.id}`, { make_id: m2.id });
    expect(res.body.data).toMatchObject({ make_name: 'SMC', brand_name: 'PHD' });
    res = await patch(`/crm/products/${p.id}`, { make_id: null });
    expect(res.body.data).toMatchObject({ make_id: null, make_name: null, brand_name: 'PHD' });
    res = await patch(`/crm/products/${p.id}`, { brand_id: uid() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Brand not found');
  });

  it('a make or brand of another client is not found for a picked client', async () => {
    const other = tax('crm_makes', 'Theirs', { client_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    const res = await post('/crm/products', { sku: 'Z1', name: 'Z', make_id: other.id }, CLIENT);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Make not found');
  });

  it('stamps make_name / brand_name on list and detail (null when unlinked)', async () => {
    const make = tax('crm_makes', 'Festo'); const brand = tax('crm_brands', 'MAC');
    const a = product('A1', { make_id: make.id, brand_id: brand.id }); product('A2');
    const list = await get('/crm/products');
    expect(list.status).toBe(200);
    const byRef = Object.fromEntries(list.body.data.map((r: Row) => [r.sku, r]));
    expect(byRef.A1).toMatchObject({ make_name: 'Festo', brand_name: 'MAC' });
    expect(byRef.A2).toMatchObject({ make_name: null, brand_name: null });
    const detail = await get(`/crm/products/${a.id}`);
    expect(detail.body.data).toMatchObject({ id: a.id, make_name: 'Festo', brand_name: 'MAC' });
  });

  it('filters the list by make_id and brand_id and validates them', async () => {
    const m1 = tax('crm_makes', 'Festo'); const m2 = tax('crm_makes', 'SMC'); const b = tax('crm_brands', 'MAC');
    product('A1', { make_id: m1.id, brand_id: b.id }); product('A2', { make_id: m2.id, brand_id: b.id }); product('A3');
    const refs = async (qs: string) => (await get(`/crm/products?${qs}`)).body.data.map((r: Row) => r.sku).sort();
    expect(await refs(`make_id=${m1.id}`)).toEqual(['A1']);
    expect(await refs(`brand_id=${b.id}`)).toEqual(['A1', 'A2']);
    expect(await refs(`make_id=${m2.id}&brand_id=${b.id}`)).toEqual(['A2']);
    const bad = await get('/crm/products?make_id=zzz');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
    expect((await get('/crm/products?brand_id=zzz')).status).toBe(400);
  });

  it('a name lookup failure never 500s a product read', async () => {
    const make = tax('crm_makes', 'Festo');
    product('A1', { make_id: make.id });
    db.failTables.crm_makes = 'boom';
    const res = await get('/crm/products');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ sku: 'A1', make_name: null, brand_name: null });
  });
});

// ── product reference uniqueness ────────────────────────────────────────────
describe('product reference (sku) uniqueness', () => {
  it('refuses a duplicate on create, case-insensitively and ignoring surrounding spaces', async () => {
    await post('/crm/products', { sku: 'ab-100', name: 'One' });
    for (const sku of ['ab-100', 'AB-100', ' Ab-100 ']) {
      const res = await post('/crm/products', { sku, name: 'Two' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE');
      expect(res.body.error.message).toBe(`A product with reference "${sku.trim()}" already exists`);
    }
    expect(products()).toHaveLength(1);
  });

  it('uses the exact message from the contract', async () => {
    product('13280');
    const res = await post('/crm/products', { sku: '13280', name: 'Valve' });
    expect(res.body.error.message).toBe('A product with reference "13280" already exists');
  });

  it('treats % and _ in a reference literally', async () => {
    product('13280');
    expect((await post('/crm/products', { sku: '13_80', name: 'Odd' })).status).toBe(201);
    expect((await post('/crm/products', { sku: '1%', name: 'Odd2' })).status).toBe(201);
  });

  it('ignores deleted products, other orgs and other clients', async () => {
    product('R1', { deleted_at: '2026-01-01T00:00:00Z' });
    product('R2', { org_id: OTHER_ORG });
    product('R3', { client_id: CLIENT });
    expect((await post('/crm/products', { sku: 'r1', name: 'a' })).status).toBe(201);
    expect((await post('/crm/products', { sku: 'r2', name: 'b' })).status).toBe(201);
    expect((await post('/crm/products', { sku: 'r3', name: 'c' })).status).toBe(201); // org-level list vs the client's
    expect((await post('/crm/products', { sku: 'r3', name: 'd' }, CLIENT)).status).toBe(409);
  });

  it('PATCH refuses changing the reference onto another product, but not onto itself', async () => {
    const a = product('A1'); product('B2');
    const clash = await patch(`/crm/products/${a.id}`, { sku: 'b2' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toEqual({ code: 'DUPLICATE', message: 'A product with reference "b2" already exists' });
    expect(a.sku).toBe('A1');
    expect((await patch(`/crm/products/${a.id}`, { sku: 'a1' })).status).toBe(200); // same product, different case
    expect((await patch(`/crm/products/${a.id}`, { sku: 'C3' })).status).toBe(200);
    expect(a.sku).toBe('C3');
    expect((await patch(`/crm/products/${a.id}`, { name: 'Renamed' })).status).toBe(200); // no reference change: no check
  });

  it('PATCH checks against the product\'s own client list', async () => {
    const a = product('A1', { client_id: CLIENT }); product('B2'); // B2 is in the org-level list
    expect((await patch(`/crm/products/${a.id}`, { sku: 'B2' }, CLIENT)).status).toBe(200);
  });

  it('PATCH of an unknown product is left to the generic route (404)', async () => {
    const res = await patch(`/crm/products/${uid()}`, { sku: 'ZZ', name: 'x' }, CLIENT);
    expect(res.status).toBe(404);
  });

  it('a product after a deleted one with the same reference is allowed (delete frees the reference)', async () => {
    const a = product('A1');
    expect((await del(`/crm/products/${a.id}`)).status).toBe(204);
    expect((await post('/crm/products', { sku: 'a1', name: 'Again' })).status).toBe(201);
  });
});

// ── bulk import ─────────────────────────────────────────────────────────────
describe('POST /products/bulk', () => {
  const bulk = (rows: unknown, extra: Row = {}, client?: string) => post('/crm/products/bulk', { rows, ...extra }, client);

  it('creates products with makes and brands, creating the missing ones once', async () => {
    const res = await bulk([
      { reference: '13280', name: 'Solenoid valve', make: 'Festo', brand: 'MAC', unit: 'nos', price: 1250.5, category: '', description: 'd' },
      { reference: '13281', name: 'Gripper', make: ' festo ', brand: 'PHD', price: '99' },
      { reference: 13282, name: 'Cup' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { created: 3, updated: 0, skipped: 0, errors: [], makes_created: ['Festo'], brands_created: ['MAC', 'PHD'] } });
    expect(db.tables.crm_makes).toHaveLength(1);
    expect(db.tables.crm_brands).toHaveLength(2);
    const p1 = products().find((p) => p.sku === '13280')!;
    expect(p1).toMatchObject({ name: 'Solenoid valve', unit: 'nos', price: 1250.5, description: 'd', org_id: ORG, client_id: null, currency: 'INR', tax_rate_pct: 0 });
    expect(p1.make_id).toBe(db.tables.crm_makes[0].id);
    expect(products().find((p) => p.sku === '13281')!.make_id).toBe(db.tables.crm_makes[0].id);
    expect(products().find((p) => p.sku === '13282')).toMatchObject({ price: 0 });
    expect(products().find((p) => p.sku === '13282')!.make_id).toBeUndefined();
  });

  it('matches existing makes and brands by case-insensitive trimmed name (inactive too), creating none', async () => {
    const make = tax('crm_makes', 'Festo', { is_active: false }); const brand = tax('crm_brands', 'MAC');
    const res = await bulk([{ reference: 'A1', name: 'A', make: 'FESTO ', brand: ' mac' }]);
    expect(res.body.data).toMatchObject({ created: 1, makes_created: [], brands_created: [] });
    expect(products()[0]).toMatchObject({ make_id: make.id, brand_id: brand.id });
    expect(db.tables.crm_makes).toHaveLength(1);
  });

  it('updates an existing product by reference (case-insensitive), leaving unmentioned fields alone', async () => {
    const make = tax('crm_makes', 'Festo');
    const p = product('ab-1', { name: 'Old', price: 10, unit: 'kg', description: 'keep', make_id: make.id });
    const res = await bulk([{ reference: 'AB-1', name: 'New name', price: '2,000' }]);
    expect(res.body.data).toMatchObject({ created: 0, updated: 1, skipped: 0, errors: [] });
    expect(products()).toHaveLength(1);
    expect(p).toMatchObject({ sku: 'ab-1', name: 'New name', price: 2000, unit: 'kg', description: 'keep', make_id: make.id });
  });

  it('update_existing=false skips an existing reference with a message', async () => {
    product('A1', { name: 'Old' });
    const res = await bulk([{ reference: 'a1', name: 'New' }, { reference: 'A2', name: 'Fresh' }], { update_existing: false });
    expect(res.body.data).toMatchObject({ created: 1, updated: 0, skipped: 1 });
    expect(res.body.data.errors).toEqual([{ row: 1, reference: 'a1', message: expect.stringContaining('already exists') }]);
    expect(products().find((p) => p.sku === 'A1')!.name).toBe('Old');
  });

  it('create_missing=false reports unknown makes/brands as row errors and creates nothing', async () => {
    tax('crm_makes', 'Festo');
    const res = await bulk([
      { reference: 'A1', name: 'a', make: 'Festo' },
      { reference: 'A2', name: 'b', make: 'Nope' },
      { reference: 'A3', name: 'c', brand: 'Ghost' },
    ], { create_missing: false });
    expect(res.body.data).toMatchObject({ created: 1, updated: 0, skipped: 0, makes_created: [], brands_created: [] });
    expect(res.body.data.errors).toEqual([
      { row: 2, reference: 'A2', message: 'Make "Nope" does not exist' },
      { row: 3, reference: 'A3', message: 'Brand "Ghost" does not exist' },
    ]);
    expect(db.tables.crm_makes).toHaveLength(1);
    expect(db.tables.crm_brands).toHaveLength(0);
    expect(products().map((p) => p.sku)).toEqual(['A1']);
  });

  it('reports blank references / names and bad prices per row (1-based) without blocking the rest', async () => {
    const res = await bulk([
      { reference: 'OK1', name: 'fine' },
      { reference: '  ', name: 'no ref' },
      { reference: 'NN', name: '' },
      { reference: 'BP', name: 'bad price', price: 'abc' },
      { reference: 'NEG', name: 'negative', price: -4 },
      'not an object',
      { reference: 'x'.repeat(121), name: 'long' },
      { reference: 'OK2', name: 'also fine', price: '1,250.50' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: 2, updated: 0, skipped: 0 });
    expect(res.body.data.errors).toEqual([
      { row: 2, reference: '', message: 'Reference is required' },
      { row: 3, reference: 'NN', message: 'Name is required' },
      { row: 4, reference: 'BP', message: 'Price "abc" is not a number' },
      { row: 5, reference: 'NEG', message: 'Price cannot be negative' },
      { row: 6, reference: '', message: 'Row is not an object' },
      { row: 7, reference: 'x'.repeat(121), message: 'Reference is longer than 120 characters' },
    ]);
    expect(products().find((p) => p.sku === 'OK2')!.price).toBe(1250.5);
  });

  it('parses prices', () => {
    expect(parsePrice('1,250.50')).toEqual({ value: 1250.5 });
    expect(parsePrice(' ₹ 1,25,000 ')).toEqual({ value: 125000 });
    expect(parsePrice('Rs. 99')).toEqual({ value: 99 });
    expect(parsePrice('.5')).toEqual({ value: 0.5 });
    expect(parsePrice(12)).toEqual({ value: 12 });
    expect(parsePrice('')).toEqual({ value: undefined });
    expect(parsePrice(undefined)).toEqual({ value: undefined });
    expect(parsePrice('1.2.3').error).toBeTruthy();
    expect(parsePrice('-5').error).toBe('Price cannot be negative');
    expect(parsePrice(NaN).error).toBeTruthy();
  });

  it('a duplicate reference inside the file: the later row wins, the earlier is skipped with a message', async () => {
    const res = await bulk([
      { reference: 'D1', name: 'first', price: 1 },
      { reference: 'U1', name: 'unique' },
      { reference: 'd1', name: 'second', price: 2 },
    ]);
    expect(res.body.data).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    expect(res.body.data.errors).toEqual([{ row: 1, reference: 'D1', message: expect.stringContaining('row 3') }]);
    expect(products().find((p) => p.sku === 'd1')).toMatchObject({ name: 'second', price: 2 });
    expect(products().filter((p) => p.sku.toLowerCase() === 'd1')).toHaveLength(1);
  });

  it('matches a category by name (case-insensitive) and ignores unknown ones without creating them', async () => {
    const cat = { id: uid(), org_id: ORG, client_id: null, name: 'Valves', deleted_at: null };
    db.tables.crm_product_categories.push(cat, { id: uid(), org_id: OTHER_ORG, client_id: null, name: 'Grippers', deleted_at: null });
    const res = await bulk([
      { reference: 'C1', name: 'a', category: ' valves ' },
      { reference: 'C2', name: 'b', category: 'Grippers' }, // other org's: unknown here
      { reference: 'C3', name: 'c', category: 'Mystery' },
    ]);
    expect(res.body.data).toMatchObject({ created: 3, errors: [] });
    expect(products().find((p) => p.sku === 'C1')!.category_id).toBe(cat.id);
    expect(products().find((p) => p.sku === 'C2')!.category_id).toBeUndefined();
    expect(db.tables.crm_product_categories).toHaveLength(2);
  });

  it('caps a file at 2000 rows (400) and accepts exactly 2000', async () => {
    const mk = (count: number) => Array.from({ length: count }, (_, i) => ({ reference: `R${i}`, name: `N${i}` }));
    const over = await bulk(mk(2001));
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('VALIDATION');
    expect(over.body.error.message).toContain('2000');
    expect(products()).toHaveLength(0);
    const exact = await bulk(mk(2000));
    expect(exact.status).toBe(200);
    expect(exact.body.data).toMatchObject({ created: 2000, errors: [] });
    expect(products()).toHaveLength(2000);
  });

  it('rejects a missing, non-array or empty rows with 400', async () => {
    expect((await post('/crm/products/bulk', {})).status).toBe(400);
    expect((await post('/crm/products/bulk', { rows: 'x' })).status).toBe(400);
    expect((await bulk([])).status).toBe(400);
  });

  it('is registered ahead of /products/:id (bulk is not read as a product id)', async () => {
    const res = await bulk([{ reference: 'B1', name: 'x' }]);
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
  });

  it('is scoped to the caller client: references are per client, products land on that client', async () => {
    product('S1'); // org-level S1
    const res = await bulk([{ reference: 'S1', name: 'client copy', make: 'Festo' }], {}, CLIENT);
    expect(res.body.data).toMatchObject({ created: 1, updated: 0, makes_created: ['Festo'] });
    expect(products().filter((p) => p.sku === 'S1')).toHaveLength(2);
    expect(products().find((p) => p.client_id === CLIENT)).toBeTruthy();
    expect(db.tables.crm_makes[0].client_id).toBe(CLIENT);
    // a second import updates the client's own copy, not the org-level one
    const again = await bulk([{ reference: 's1', name: 'renamed' }], {}, CLIENT);
    expect(again.body.data).toMatchObject({ created: 0, updated: 1 });
    expect(products().find((p) => p.client_id === null)!.name).toBe('Product S1');
  });

  it('a row the database refuses is reported alone (the batch falls back to single inserts)', async () => {
    db.rejectInsert = (t, row) => (t === 'crm_products' && row.sku === 'BAD' ? 'check constraint violated' : undefined);
    const res = await bulk([{ reference: 'G1', name: 'g' }, { reference: 'BAD', name: 'b' }, { reference: 'G2', name: 'g2' }]);
    expect(res.body.data).toMatchObject({ created: 2, updated: 0 });
    expect(res.body.data.errors).toEqual([{ row: 2, reference: 'BAD', message: 'check constraint violated' }]);
    expect(products().map((p) => p.sku).sort()).toEqual(['G1', 'G2']);
  });

  it('a plain import (no make/brand columns in the file) works on a database without the migration', async () => {
    db.missingTables.add('crm_makes'); db.missingTables.add('crm_brands');
    db.missingCols.crm_products = new Set(['make_id', 'brand_id']);
    const res = await bulk([{ reference: 'P1', name: 'plain' }]);
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
  });

  it('answers 503 NOT_MIGRATED when the file names a make/brand and the tables are missing', async () => {
    db.missingTables.add('crm_makes'); db.missingTables.add('crm_brands');
    db.missingCols.crm_products = new Set(['make_id', 'brand_id']);
    const res = await bulk([{ reference: 'P1', name: 'plain', make: 'Festo' }]);
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({ code: 'NOT_MIGRATED', message: NOT_MIGRATED });
    expect(products()).toHaveLength(0);
  });
});

// ── a database that has not been migrated ───────────────────────────────────
describe('NOT_MIGRATED mapping on products', () => {
  beforeEach(() => {
    db.missingTables.add('crm_makes'); db.missingTables.add('crm_brands');
    db.missingCols.crm_products = new Set(['make_id', 'brand_id']);
  });

  it('product reads keep working: list and detail return make_name / brand_name null', async () => {
    const p = product('A1'); delete p.make_id; delete p.brand_id;
    const list = await get('/crm/products');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ sku: 'A1', make_name: null, brand_name: null });
    const detail = await get(`/crm/products/${p.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ sku: 'A1', make_name: null, brand_name: null });
  });

  it('a plain product create and patch (no make/brand) still work', async () => {
    const created = await post('/crm/products', { sku: 'N1', name: 'plain', make_id: null, brand_id: null });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ sku: 'N1', make_name: null, brand_name: null });
    expect((await patch(`/crm/products/${created.body.data.id}`, { name: 'renamed' })).status).toBe(200);
  });

  it('writing a make or brand id is 503 NOT_MIGRATED', async () => {
    const p = product('A1');
    const bodies = [{ make_id: uid() }, { brand_id: uid() }];
    for (const body of bodies) {
      for (const res of [await post('/crm/products', { sku: 'W1', name: 'w', ...body }), await patch(`/crm/products/${p.id}`, body)]) {
        expect(res.status).toBe(503);
        expect(res.body.error).toEqual({ code: 'NOT_MIGRATED', message: NOT_MIGRATED });
      }
    }
    // clearing a link on a patch cannot work without the column either
    const clear = await patch(`/crm/products/${p.id}`, { make_id: null });
    expect(clear.status).toBe(503);
    expect(clear.body.error.code).toBe('NOT_MIGRATED');
  });

  it('filtering by make_id or brand_id is 503 NOT_MIGRATED', async () => {
    const res = await get(`/crm/products?make_id=${uid()}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_MIGRATED');
  });

  it('a missing-column error unrelated to make/brand is not relabelled', async () => {
    db.missingCols.crm_products = new Set(['make_id', 'brand_id', 'weight_kg']);
    const res = await post('/crm/products', { sku: 'W2', name: 'w', weight_kg: 3 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_ERROR');
  });
});
