/**
 * Account geofence (latitude / longitude) persistence. The web + mobile New Account forms send
 * latitude/longitude from the Google place pick; accountSchema must accept them (not strip them)
 * and the create + patch routes must pass them straight through to the persisted crm_accounts row.
 *
 *   - accountSchema keeps latitude/longitude (create), coerces string input, enforces ranges, and
 *     accountSchema.partial() (the PATCH route) keeps them and accepts null to clear.
 *   - POST /crm/accounts persists latitude/longitude onto the inserted row and echoes them back.
 *   - PATCH /crm/accounts/:id persists latitude/longitude onto the stored row.
 *
 * Route tests use the same in-memory PostgREST fake style as accountDuplicate.test.ts (extended so
 * update actually mutates the stored row).
 */
import express from 'express';
import request from 'supertest';
import { accountSchema } from '../src/validators/crm.validators';

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

      if (this.op === 'update') {
        for (const r of hit) Object.assign(r, this.payload);
        return this.returning ? this.finish(hit) : { data: null, error: null };
      }

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

// The create/patch path's custom-field validation is not under test here — pass it through.
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
const CLIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const adminA = { id: '33333333-3333-3333-3333-333333333333', org_id: ORG, role: 'admin', client_id: CLIENT_A, org_role_data_scope: 'all' };

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? err.statusCode ?? 500).json({ success: false, error: { code: err.code ?? 'UNHANDLED', message: err.message } }));
const patch = (url: string, body: unknown) => request(app).patch(url).send(body as object);
const post = (url: string, body: unknown) => request(app).post(url).send(body as object);

let n = 0;
const uid = () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const account = (extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: CLIENT_A, name: 'Acme Corp', deleted_at: null, created_at: '2026-05-01T00:00:00Z', ...extra };
  (db.tables.crm_accounts ??= []).push(row);
  return row;
};

beforeEach(() => {
  db.tables = { crm_accounts: [] };
  db.missingCols = {};
  db.seq = 0;
  n = 0;
  mockUser = { ...adminA };
});

describe('accountSchema geofence fields', () => {
  it('keeps latitude/longitude instead of stripping them (create)', () => {
    const r = accountSchema.parse({ name: 'Acme', latitude: 20.2961, longitude: 85.8245 });
    expect(r).toMatchObject({ latitude: 20.2961, longitude: 85.8245 });
  });

  it('coerces string coordinates to numbers', () => {
    const r = accountSchema.parse({ name: 'Acme', latitude: '12.9716', longitude: '77.5946' });
    expect(r.latitude).toBe(12.9716);
    expect(r.longitude).toBe(77.5946);
  });

  it('keeps them on partial() (the PATCH route) and accepts null to clear', () => {
    expect(accountSchema.partial().parse({ latitude: 28.6139, longitude: 77.209 })).toMatchObject({ latitude: 28.6139, longitude: 77.209 });
    expect(accountSchema.partial().parse({ latitude: null, longitude: null })).toEqual({ latitude: null, longitude: null });
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => accountSchema.parse({ name: 'Acme', latitude: 120, longitude: 0 })).toThrow();
    expect(() => accountSchema.parse({ name: 'Acme', latitude: 0, longitude: 200 })).toThrow();
  });
});

describe('POST /crm/accounts — geofence persistence', () => {
  it('persists latitude/longitude onto the created row and echoes them back', async () => {
    const res = await post('/crm/accounts', { name: 'Geo Co', latitude: 20.2961, longitude: 85.8245 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Geo Co', latitude: 20.2961, longitude: 85.8245 });
    expect(db.tables.crm_accounts).toHaveLength(1);
    expect(db.tables.crm_accounts[0]).toMatchObject({ latitude: 20.2961, longitude: 85.8245 });
  });
});

describe('PATCH /crm/accounts/:id — geofence persistence', () => {
  it('persists latitude/longitude onto the stored row', async () => {
    const acc = account({ name: 'Movable Co', latitude: null, longitude: null });
    const res = await patch(`/crm/accounts/${acc.id}`, { latitude: 12.9716, longitude: 77.5946 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ latitude: 12.9716, longitude: 77.5946 });
    expect(db.tables.crm_accounts[0]).toMatchObject({ id: acc.id, latitude: 12.9716, longitude: 77.5946 });
  });
});
