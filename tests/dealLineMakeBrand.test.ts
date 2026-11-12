/**
 * Deal lines for connected-B2B (Spark & Ray): make, brand, MAC funnel reference and order value, over HTTP against an
 * in-memory PostgREST fake:
 *
 *   - storage in the line's custom_fields with make/brand name snapshots, line JSON shape (incl. `reference`);
 *   - validation (unknown / deleted / foreign make and brand), a database without the makes/brands tables;
 *   - product defaults, explicit null clears, other custom_fields keys preserved;
 *   - the MAC rule (create, merged PATCH, items[] with line numbers, case-insensitive, other brands optional);
 *   - the deal roll-up on the list / detail / lead deals / account deals (batched, failure tolerant);
 *   - connected-B2B only: every other tenant ignores the keys and gets byte-identical responses;
 *   - a deal raised against a lead derives its account; a lead can have several deals.
 */
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;

interface FakeDb {
  tables: Record<string, Row[]>;
  missingTables: Set<string>;
  failTables: Set<string>;
  /** `${op}:${table}` for every statement that ran. */
  calls: string[];
  seq: number;
}

jest.mock('../src/lib/supabase', () => {
  const db: FakeDb = { tables: {}, missingTables: new Set(), failTables: new Set(), calls: [], seq: 0 };

  const splitOr = (expr: string) => expr.split(/,(?![^()]*\))/);
  const orPred = (expr: string): ((r: Row) => boolean) => {
    const parts = splitOr(expr).map((p) => {
      const m = /^([a-z_]+)\.(is|eq|in)\.(.*)$/.exec(p);
      if (!m) return () => true;
      const [, col, op, val] = m;
      if (op === 'is') return (r: Row) => r[col] === null || r[col] === undefined;
      if (op === 'eq') return (r: Row) => String(r[col]) === val;
      const set = new Set(val.replace(/^\(|\)$/g, '').split(','));
      return (r: Row) => set.has(String(r[col]));
    });
    return (r) => parts.some((p) => p(r));
  };

  class Q {
    private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private payload: any;
    private preds: Array<(r: Row) => boolean> = [];
    private orders: Array<{ c: string; asc: boolean }> = [];
    private returning = false;
    private from = 0;
    private to = Infinity;
    private mode: 'many' | 'single' | 'maybe' = 'many';
    constructor(private t: string) {}
    select() { if (this.op !== 'select') this.returning = true; return this; }
    insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
    update(p: Row) { this.op = 'update'; this.payload = p; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c: string, v: unknown) { this.preds.push((r) => String(r[c]) === String(v)); return this; }
    neq(c: string, v: unknown) { this.preds.push((r) => String(r[c]) !== String(v)); return this; }
    in(c: string, vs: unknown[]) { const s = new Set(vs.map(String)); this.preds.push((r) => s.has(String(r[c]))); return this; }
    is(c: string, v: null) { this.preds.push((r) => (r[c] ?? null) === v); return this; }
    or(expr: string) { this.preds.push(orPred(expr)); return this; }
    gte() { return this; }
    lte() { return this; }
    ilike() { return this; }
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
      db.calls.push(`${this.op}:${t}`);
      if (db.failTables.has(t)) return { data: null, error: { code: 'XX000', message: 'boom' } };
      if (db.missingTables.has(t)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` } };
      const rows = (db.tables[t] ??= []);
      if (this.op === 'insert') {
        const made: Row[] = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p: Row) => {
          const row: Row = { id: `00000000-0000-4000-8000-${String(++db.seq + 100000).padStart(12, '0')}`, deleted_at: null, created_at: '2026-01-01T00:00:00Z', ...p };
          if (t === 'crm_deal_line_items') row.line_total = Number(row.quantity ?? 1) * Number(row.unit_price ?? 0) * (1 - Number(row.discount_pct ?? 0) / 100);
          return row;
        });
        rows.push(...made);
        return this.returning ? this.finish(made) : { data: null, error: null };
      }
      const hit = rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.op === 'update') { hit.forEach((r) => Object.assign(r, this.payload)); return this.returning ? this.finish(hit) : { data: null, error: null }; }
      if (this.op === 'delete') { db.tables[t] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
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

// The deal service is real everywhere except the four entry points the routes use for list / detail / create, which
// read and write the same fake tables without the pipeline / custom-field / automation machinery.
jest.mock('../src/services/crm/deals.service', () => {
  const actual = jest.requireActual('../src/services/crm/deals.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { supabaseAdmin } = require('../src/lib/supabase');
  return {
    ...actual,
    listDealsWithCount: async (org: string) => {
      const { data } = await supabaseAdmin.from('crm_deals').select('*').eq('org_id', org).is('deleted_at', null);
      return { rows: data, total: data.length, page: 1, limit: 50 };
    },
    dealsTotals: async () => ({ total_value: 0, total_volume_kg: 0 }),
    getDeal: async (org: string, id: string) => {
      const { data } = await supabaseAdmin.from('crm_deals').select('*').eq('org_id', org).eq('id', id).is('deleted_at', null).maybeSingle();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      if (!data) throw new (require('../src/utils').AppError)(404, 'Deal not found', 'NOT_FOUND');
      return data;
    },
    createDeal: async (org: string, payload: Row) => {
      const { data } = await supabaseAdmin.from('crm_deals').insert({
        org_id: org, name: payload.name, client_id: payload.client_id ?? null, account_id: payload.account_id ?? null,
        lead_id: payload.lead_id ?? null, amount: payload.amount ?? 0,
      }).select('*').single();
      return data;
    },
  };
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

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
const SPARK = 'c0218852-0a19-4dd0-b9fa-72f9e32ed0d8'; // connected-B2B client
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // any other tenant

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ success: false, error: { code: 'UNHANDLED', message: err.message } }));

// The router wraps a plain JSON body as { success: true, data }; the tests read the payload itself (lists that already
// carry totals / pagination keep their envelope).
const unwrap = async (r: request.Test): Promise<request.Response> => {
  const res = await r;
  const b = res.body;
  if (b && typeof b === 'object' && !Array.isArray(b) && b.success === true && 'data' in b && Object.keys(b).length === 2) res.body = b.data;
  return res;
};
const withClient = (r: request.Test, client?: string) => unwrap(client ? r.set('X-Client-Id', client) : r);
const get = (url: string, client = SPARK) => withClient(request(app).get(url), client);
const post = (url: string, body: unknown, client = SPARK) => withClient(request(app).post(url).send(body as object), client);
const patch = (url: string, body: unknown, client = SPARK) => withClient(request(app).patch(url).send(body as object), client);

let n = 0;
const uid = () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const tax = (table: 'crm_makes' | 'crm_brands', name: string, extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: null, name, is_active: true, deleted_at: null, ...extra };
  db.tables[table].push(row);
  return row;
};
const product = (sku: string, extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: SPARK, sku, name: `Product ${sku}`, price: 100, tax_rate_pct: 0, unit: 'nos', deleted_at: null, ...extra };
  db.tables.crm_products.push(row);
  return row;
};
const deal = (extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, client_id: SPARK, name: 'Deal', amount: 0, deleted_at: null, ...extra };
  db.tables.crm_deals.push(row);
  return row;
};
const line = (dealId: string, cf: Row, extra: Row = {}): Row => {
  const row = { id: uid(), org_id: ORG, deal_id: dealId, name: 'Item', sku: null, product_id: null, quantity: 1, unit_price: 100, discount_pct: 0, line_total: 100, position: 0, custom_fields: cf, ...extra };
  db.tables.crm_deal_line_items.push(row);
  return row;
};
const lines = (dealId?: string) => db.tables.crm_deal_line_items.filter((l) => !dealId || l.deal_id === dealId);
const queries = (table: string) => db.calls.filter((c) => c === `select:${table}`).length;

beforeEach(() => {
  db.tables = { crm_makes: [], crm_brands: [], crm_products: [], crm_deals: [], crm_deal_line_items: [], crm_leads: [], crm_accounts: [] };
  db.missingTables = new Set(); db.failTables = new Set(); db.calls = []; db.seq = 0;
});

// ── lines: storage, validation, defaults ────────────────────────────────────
describe('POST /deals/:id/line-items (connected-B2B)', () => {
  it('stores make / brand (with name snapshots), funnel reference and order value in custom_fields and returns them on the line', async () => {
    const d = deal(); const make = tax('crm_makes', 'Festo'); const brand = tax('crm_brands', 'PHD'); const p = product('13280');
    const res = await post(`/crm/deals/${d.id}/line-items`, {
      product_id: p.id, quantity: 2, unit_price: 50, make_id: make.id, brand_id: brand.id, funnel_ref: '  F-7  ', order_value: 80,
    });
    expect(res.status).toBe(201);
    expect(lines(d.id)[0].custom_fields).toEqual({
      make_id: make.id, make_name: 'Festo', brand_id: brand.id, brand_name: 'PHD', funnel_ref: 'F-7', order_value: 80,
    });
    expect(res.body).toMatchObject({
      name: 'Product 13280', sku: '13280', reference: '13280', quantity: 2, unit_price: 50, line_total: 100,
      make_id: make.id, make_name: 'Festo', brand_id: brand.id, brand_name: 'PHD', funnel_ref: 'F-7', order_value: 80,
    });
  });

  it('a plain line gets every new key as null and the reference from sku', async () => {
    const d = deal();
    const res = await post(`/crm/deals/${d.id}/line-items`, { name: 'Loose item', sku: 'X-1', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ reference: 'X-1', make_id: null, brand_id: null, make_name: null, brand_name: null, funnel_ref: null, order_value: null });
    expect(lines(d.id)[0].custom_fields).toEqual({});
  });

  it('refuses an unknown, deleted or other-org make / brand with 400 VALIDATION', async () => {
    const d = deal();
    const gone = tax('crm_makes', 'Old', { deleted_at: '2026-01-01T00:00:00Z' });
    const foreign = tax('crm_brands', 'Theirs', { org_id: OTHER_ORG });
    for (const [body, message] of [
      [{ name: 'a', make_id: uid() }, 'Make not found'],
      [{ name: 'a', make_id: gone.id }, 'Make not found'],
      [{ name: 'a', brand_id: uid() }, 'Brand not found'],
      [{ name: 'a', brand_id: foreign.id }, 'Brand not found'],
    ] as const) {
      const res = await post(`/crm/deals/${d.id}/line-items`, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: 'VALIDATION', message });
    }
    expect(lines()).toHaveLength(0);
  });

  it('validates the body: bad uuid, negative order value, a funnel reference over 60 characters', async () => {
    const d = deal();
    for (const body of [{ make_id: 'nope' }, { order_value: -1 }, { order_value: 'x' }, { funnel_ref: 'x'.repeat(61) }]) {
      expect((await post(`/crm/deals/${d.id}/line-items`, { name: 'a', ...body })).status).toBe(400);
    }
    expect((await post(`/crm/deals/${d.id}/line-items`, { name: 'a', funnel_ref: 'x'.repeat(60), order_value: 0 })).status).toBe(201);
  });

  it('blank funnel reference is stored as nothing', async () => {
    const d = deal();
    await post(`/crm/deals/${d.id}/line-items`, { name: 'a', funnel_ref: '   ' });
    expect(lines(d.id)[0].custom_fields).toEqual({});
  });

  it('degrades when the makes / brands tables do not exist: the line saves, funnel reference and order value are kept', async () => {
    const d = deal();
    db.missingTables = new Set(['crm_makes', 'crm_brands']);
    const res = await post(`/crm/deals/${d.id}/line-items`, { name: 'a', make_id: uid(), brand_id: uid(), funnel_ref: 'F1', order_value: 5 });
    expect(res.status).toBe(201);
    expect(lines(d.id)[0].custom_fields).toEqual({ funnel_ref: 'F1', order_value: 5 });
    expect(res.body).toMatchObject({ make_id: null, brand_id: null, funnel_ref: 'F1', order_value: 5 });
  });

  it('a missing makes table alone still stores the brand', async () => {
    const d = deal(); const brand = tax('crm_brands', 'BEKO');
    db.missingTables = new Set(['crm_makes']);
    const res = await post(`/crm/deals/${d.id}/line-items`, { name: 'a', make_id: uid(), brand_id: brand.id });
    expect(res.status).toBe(201);
    expect(lines(d.id)[0].custom_fields).toEqual({ brand_id: brand.id, brand_name: 'BEKO' });
  });

  it('a non-schema database error while validating is a 500, not a silent pass', async () => {
    const d = deal();
    db.failTables = new Set(['crm_makes']);
    const res = await post(`/crm/deals/${d.id}/line-items`, { name: 'a', make_id: uid() });
    expect(res.status).toBe(500);
    expect(lines()).toHaveLength(0);
  });

  it('defaults make and brand from the product; an explicit value wins; explicit null clears', async () => {
    const d = deal(); const m1 = tax('crm_makes', 'Festo'); const m2 = tax('crm_makes', 'SMC'); const b = tax('crm_brands', 'BEKO');
    const p = product('A1', { make_id: m1.id, brand_id: b.id });
    const dflt = await post(`/crm/deals/${d.id}/line-items`, { product_id: p.id });
    expect(dflt.body).toMatchObject({ make_id: m1.id, make_name: 'Festo', brand_id: b.id, brand_name: 'BEKO' });
    const explicit = await post(`/crm/deals/${d.id}/line-items`, { product_id: p.id, make_id: m2.id });
    expect(explicit.body).toMatchObject({ make_id: m2.id, make_name: 'SMC', brand_id: b.id });
    const cleared = await post(`/crm/deals/${d.id}/line-items`, { product_id: p.id, make_id: null, brand_id: null });
    expect(cleared.body).toMatchObject({ make_id: null, make_name: null, brand_id: null, brand_name: null });
    expect(lines(d.id)[2].custom_fields).toEqual({});
  });

  it('a product without make / brand columns, or pointing at a deleted make, gives no default', async () => {
    const d = deal(); const gone = tax('crm_makes', 'Old', { deleted_at: '2026-01-01T00:00:00Z' });
    const bare = product('B1'); // no make_id / brand_id keys at all (column missing)
    const stale = product('B2', { make_id: gone.id });
    for (const p of [bare, stale]) {
      const res = await post(`/crm/deals/${d.id}/line-items`, { product_id: p.id });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ make_id: null, brand_id: null });
    }
  });

  it('keeps the other custom_fields keys sent with the line', async () => {
    const d = deal(); const brand = tax('crm_brands', 'PHD');
    await post(`/crm/deals/${d.id}/line-items`, { name: 'a', brand_id: brand.id, custom_fields: { colour: 'red', make_id: 'spoofed' } });
    expect(lines(d.id)[0].custom_fields).toEqual({ colour: 'red', brand_id: brand.id, brand_name: 'PHD' });
  });
});

// ── lines: PATCH ────────────────────────────────────────────────────────────
describe('PATCH /line-items/:id (connected-B2B)', () => {
  it('changes only what was sent, re-snapshotting names and preserving other custom_fields keys', async () => {
    const d = deal(); const m1 = tax('crm_makes', 'Festo'); const m2 = tax('crm_makes', 'SMC'); const b = tax('crm_brands', 'PHD');
    const l = line(d.id, { colour: 'red', make_id: m1.id, make_name: 'Festo', brand_id: b.id, brand_name: 'PHD', order_value: 10 });
    const res = await patch(`/crm/line-items/${l.id}`, { make_id: m2.id, funnel_ref: ' R9 ' });
    expect(res.status).toBe(200);
    expect(l.custom_fields).toEqual({ colour: 'red', make_id: m2.id, make_name: 'SMC', brand_id: b.id, brand_name: 'PHD', order_value: 10, funnel_ref: 'R9' });
    expect(res.body).toMatchObject({ make_name: 'SMC', brand_name: 'PHD', funnel_ref: 'R9', order_value: 10, reference: null });
  });

  it('a patch that leaves make / brand alone keeps their stored snapshot names', async () => {
    const d = deal(); const m = tax('crm_makes', 'Festo');
    const l = line(d.id, { make_id: m.id, make_name: 'Festo (old name)' });
    m.name = 'Renamed';
    await patch(`/crm/line-items/${l.id}`, { quantity: 3 });
    expect(l.custom_fields).toEqual({ make_id: m.id, make_name: 'Festo (old name)' });
    expect(l.quantity).toBe(3);
  });

  it('explicit null clears make, brand, funnel reference and order value', async () => {
    const d = deal(); const m = tax('crm_makes', 'Festo');
    const l = line(d.id, { colour: 'red', make_id: m.id, make_name: 'Festo', funnel_ref: 'F', order_value: 5 });
    const res = await patch(`/crm/line-items/${l.id}`, { make_id: null, funnel_ref: null, order_value: null });
    expect(res.status).toBe(200);
    expect(l.custom_fields).toEqual({ colour: 'red' });
    expect(res.body).toMatchObject({ make_id: null, make_name: null, funnel_ref: null, order_value: null });
  });

  it('validates the make / brand on patch', async () => {
    const d = deal(); const l = line(d.id, {});
    const res = await patch(`/crm/line-items/${l.id}`, { brand_id: uid() });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'VALIDATION', message: 'Brand not found' });
    expect(l.custom_fields).toEqual({});
  });

  it('an explicit custom_fields replaces the other keys but the make / brand / order keys survive', async () => {
    const d = deal(); const m = tax('crm_makes', 'Festo');
    const l = line(d.id, { colour: 'red', make_id: m.id, make_name: 'Festo', order_value: 7 });
    await patch(`/crm/line-items/${l.id}`, { custom_fields: { size: 'L' } });
    expect(l.custom_fields).toEqual({ size: 'L', make_id: m.id, make_name: 'Festo', order_value: 7 });
  });

  it('switching the product defaults make / brand from the new product unless they are sent', async () => {
    const d = deal(); const m1 = tax('crm_makes', 'Festo'); const m2 = tax('crm_makes', 'SMC');
    const p1 = product('P1', { make_id: m1.id }); const p2 = product('P2', { make_id: m2.id });
    const l = line(d.id, { make_id: m1.id, make_name: 'Festo' }, { product_id: p1.id });
    await patch(`/crm/line-items/${l.id}`, { product_id: p2.id });
    expect(l.custom_fields).toMatchObject({ make_id: m2.id, make_name: 'SMC' });
    await patch(`/crm/line-items/${l.id}`, { product_id: p1.id, make_id: null });
    expect(l.custom_fields.make_id).toBeUndefined();
  });

  it('works when the lists are not set up yet', async () => {
    const d = deal(); const l = line(d.id, { colour: 'red' });
    db.missingTables = new Set(['crm_makes', 'crm_brands']);
    const res = await patch(`/crm/line-items/${l.id}`, { make_id: uid(), order_value: 12 });
    expect(res.status).toBe(200);
    expect(l.custom_fields).toEqual({ colour: 'red', order_value: 12 });
  });

  it('an unknown line is still the old error, not a crash', async () => {
    const res = await patch(`/crm/line-items/${uid()}`, { quantity: 2 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_ERROR');
  });
});

// ── MAC rule ────────────────────────────────────────────────────────────────
describe('MAC funnel reference rule', () => {
  const MSG = 'MAC funnel reference is required for MAC products';

  it('is required on create for a MAC brand, ignoring case and spaces in the brand name', async () => {
    const d = deal();
    for (const name of ['MAC', 'mac', ' Mac ']) {
      const b = tax('crm_brands', name);
      for (const funnel of [undefined, null, '', '   ']) {
        const res = await post(`/crm/deals/${d.id}/line-items`, { name: 'a', brand_id: b.id, ...(funnel === undefined ? {} : { funnel_ref: funnel }) });
        expect(res.status).toBe(400);
        expect(res.body.error).toEqual({ code: 'VALIDATION', message: MSG });
      }
    }
    expect(lines()).toHaveLength(0);
  });

  it('accepts a MAC line with a funnel reference (trimmed)', async () => {
    const d = deal(); const b = tax('crm_brands', 'MAC');
    const res = await post(`/crm/deals/${d.id}/line-items`, { name: 'a', brand_id: b.id, funnel_ref: ' MF-001 ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ brand_name: 'MAC', funnel_ref: 'MF-001' });
  });

  it('is optional for every other brand', async () => {
    const d = deal(); const b = tax('crm_brands', 'MACHINE');
    expect((await post(`/crm/deals/${d.id}/line-items`, { name: 'a', brand_id: b.id })).status).toBe(201);
    const phd = tax('crm_brands', 'PHD');
    expect((await post(`/crm/deals/${d.id}/line-items`, { name: 'a', brand_id: phd.id })).status).toBe(201);
    expect((await post(`/crm/deals/${d.id}/line-items`, { name: 'a' })).status).toBe(201);
  });

  it('applies to a MAC brand defaulted from the product', async () => {
    const d = deal(); const b = tax('crm_brands', 'MAC'); const p = product('M1', { brand_id: b.id });
    const res = await post(`/crm/deals/${d.id}/line-items`, { product_id: p.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(MSG);
    expect((await post(`/crm/deals/${d.id}/line-items`, { product_id: p.id, funnel_ref: 'F-1' })).status).toBe(201);
    // switching the defaulted brand off removes the requirement
    expect((await post(`/crm/deals/${d.id}/line-items`, { product_id: p.id, brand_id: null })).status).toBe(201);
  });

  it('is evaluated on the merged result when patching', async () => {
    const d = deal(); const mac = tax('crm_brands', 'MAC'); const phd = tax('crm_brands', 'PHD');
    const plain = line(d.id, { brand_id: phd.id, brand_name: 'PHD' });
    // switching to MAC without a funnel reference: refused; with one: fine
    const refused = await patch(`/crm/line-items/${plain.id}`, { brand_id: mac.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: 'VALIDATION', message: MSG });
    expect(plain.custom_fields).toEqual({ brand_id: phd.id, brand_name: 'PHD' });
    expect((await patch(`/crm/line-items/${plain.id}`, { brand_id: mac.id, funnel_ref: 'MF-2' })).status).toBe(200);
    // an unrelated patch on a MAC line that already has its reference passes ...
    expect((await patch(`/crm/line-items/${plain.id}`, { quantity: 4 })).status).toBe(200);
    expect((await patch(`/crm/line-items/${plain.id}`, { order_value: 99 })).status).toBe(200);
    // ... clearing the reference does not
    const cleared = await patch(`/crm/line-items/${plain.id}`, { funnel_ref: null });
    expect(cleared.status).toBe(400);
    expect(plain.custom_fields.funnel_ref).toBe('MF-2');
    // moving off MAC makes the reference optional again
    expect((await patch(`/crm/line-items/${plain.id}`, { brand_id: phd.id, funnel_ref: null })).status).toBe(200);
  });

  it('a patch of a legacy MAC line without a reference is refused until one is given', async () => {
    const d = deal(); const mac = tax('crm_brands', 'MAC');
    const l = line(d.id, { brand_id: mac.id, brand_name: 'MAC' });
    expect((await patch(`/crm/line-items/${l.id}`, { quantity: 2 })).status).toBe(400);
    expect((await patch(`/crm/line-items/${l.id}`, { quantity: 2, funnel_ref: 'MF-3' })).status).toBe(200);
  });
});

// ── GET line items ──────────────────────────────────────────────────────────
describe('GET /deals/:id/line-items', () => {
  it('carries make / brand / funnel reference / order value, reference and line_total on every line', async () => {
    const d = deal();
    line(d.id, { make_id: 'm', make_name: 'Festo', brand_id: 'b', brand_name: 'MAC', funnel_ref: 'F1', order_value: 90 }, { sku: '13280', line_total: 100, position: 0 });
    line(d.id, {}, { sku: null, line_total: 40, position: 1 });
    const res = await get(`/crm/deals/${d.id}/line-items`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ reference: '13280', line_total: 100, make_id: 'm', make_name: 'Festo', brand_id: 'b', brand_name: 'MAC', funnel_ref: 'F1', order_value: 90 });
    expect(res.body[1]).toMatchObject({ reference: null, line_total: 40, make_id: null, make_name: null, brand_id: null, brand_name: null, funnel_ref: null, order_value: null });
  });

  it('is decided by the deal\'s own client even without a client picker', async () => {
    const d = deal(); line(d.id, { brand_name: 'PHD' });
    const res = await get(`/crm/deals/${d.id}/line-items`, '');
    expect(res.body[0]).toHaveProperty('brand_name', 'PHD');
    expect(res.body[0]).toHaveProperty('reference');
  });
});

// ── deal create with items[] ────────────────────────────────────────────────
describe('POST /deals with items[] (connected-B2B)', () => {
  it('stores make / brand / funnel / order per line, in order, and totals the quoted value', async () => {
    const m = tax('crm_makes', 'Festo'); const mac = tax('crm_brands', 'MAC'); const phd = tax('crm_brands', 'PHD'); const p = product('13280');
    const res = await post('/crm/deals', {
      name: 'Pneumatics', items: [
        { product_id: p.id, name: 'Valve', quantity: 2, unit_price: 50, make_id: m.id, brand_id: mac.id, funnel_ref: ' MF-1 ' },
        { name: 'Cylinder', quantity: 1, unit_price: 30, brand_id: phd.id, order_value: 25 },
        { name: 'Plain', quantity: 1, unit_price: 5 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(135);
    const stored = lines().sort((a, b) => a.position - b.position);
    expect(stored.map((l) => l.position)).toEqual([0, 1, 2]);
    expect(stored[0].custom_fields).toEqual({ make_id: m.id, make_name: 'Festo', brand_id: mac.id, brand_name: 'MAC', funnel_ref: 'MF-1' });
    expect(stored[1].custom_fields).toEqual({ brand_id: phd.id, brand_name: 'PHD', order_value: 25 });
    expect(stored[2].custom_fields).toEqual({});
    expect(stored.every((l) => l.deal_id === res.body.id)).toBe(true);
  });

  it('numbers the line in the MAC error and writes nothing', async () => {
    const mac = tax('crm_brands', 'MAC');
    const res = await post('/crm/deals', {
      name: 'D', items: [
        { name: 'ok', quantity: 1, unit_price: 1 },
        { name: 'mac no ref', quantity: 1, unit_price: 1, brand_id: mac.id },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'VALIDATION', message: 'Line 2: MAC funnel reference is required for MAC products' });
    expect(db.tables.crm_deals).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  it('numbers an unknown make / brand the same way and applies product defaults', async () => {
    const mac = tax('crm_brands', 'mac'); const p = product('M1', { brand_id: mac.id });
    const bad = await post('/crm/deals', { name: 'D', items: [{ name: 'a', quantity: 1, unit_price: 1 }, { name: 'b', quantity: 1, unit_price: 1 }, { name: 'c', quantity: 1, unit_price: 1, make_id: uid() }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Line 3: Make not found');
    const defaulted = await post('/crm/deals', { name: 'D', items: [{ name: 'x', quantity: 1, unit_price: 1 }, { product_id: p.id, name: 'y', quantity: 1, unit_price: 1 }] });
    expect(defaulted.status).toBe(400);
    expect(defaulted.body.error.message).toBe('Line 2: MAC funnel reference is required for MAC products');
    expect(db.tables.crm_deals).toHaveLength(0);
    const ok = await post('/crm/deals', { name: 'D', items: [{ product_id: p.id, name: 'y', quantity: 1, unit_price: 1, funnel_ref: 'F' }] });
    expect(ok.status).toBe(201);
    expect(lines()[0].custom_fields).toMatchObject({ brand_name: 'mac', funnel_ref: 'F' });
  });

  it('saves the deal when the lists do not exist yet', async () => {
    db.missingTables = new Set(['crm_makes', 'crm_brands']);
    const res = await post('/crm/deals', { name: 'D', items: [{ name: 'a', quantity: 1, unit_price: 9, make_id: uid(), brand_id: uid(), funnel_ref: 'F', order_value: 3 }] });
    expect(res.status).toBe(201);
    expect(lines()[0].custom_fields).toEqual({ funnel_ref: 'F', order_value: 3 });
  });

  it('PATCH /deals/:id leaves the lines alone (they are edited through the line routes), as before', async () => {
    const d = deal(); line(d.id, { order_value: 5 });
    const res = await patch(`/crm/deals/${d.id}`, { name: 'Renamed', items: [{ name: 'x', quantity: 1, unit_price: 1, brand_id: uid() }] });
    expect(res.status).toBe(200);
    expect(lines(d.id)).toHaveLength(1);
    expect(lines(d.id)[0].custom_fields).toEqual({ order_value: 5 });
  });
});

// ── other tenants ───────────────────────────────────────────────────────────
describe('other tenants are unchanged', () => {
  it('ignores the keys on POST / PATCH of a line and returns the stored row as it always did', async () => {
    const d = deal({ client_id: OTHER }); const mac = tax('crm_brands', 'MAC');
    const created = await post(`/crm/deals/${d.id}/line-items`, { name: 'a', sku: 'S1', brand_id: mac.id, make_id: uid(), funnel_ref: 'x', order_value: 5 }, OTHER);
    expect(created.status).toBe(201); // no MAC rule, no make check
    expect(lines(d.id)[0].custom_fields).toEqual({});
    for (const k of ['make_id', 'brand_id', 'make_name', 'brand_name', 'funnel_ref', 'order_value', 'reference']) expect(created.body).not.toHaveProperty(k);
    const patched = await patch(`/crm/line-items/${lines(d.id)[0].id}`, { brand_id: mac.id, funnel_ref: null, order_value: 3, quantity: 2 }, OTHER);
    expect(patched.status).toBe(200);
    expect(lines(d.id)[0].custom_fields).toEqual({});
    expect(lines(d.id)[0].quantity).toBe(2);
    expect(patched.body).not.toHaveProperty('order_value');
    expect(db.calls).not.toContain('select:crm_makes');
    expect(db.calls).not.toContain('select:crm_brands');
  });

  it('keeps a caller\'s own custom_fields verbatim, even keys named like ours', async () => {
    const d = deal({ client_id: OTHER });
    await post(`/crm/deals/${d.id}/line-items`, { name: 'a', custom_fields: { brand_name: 'MAC', note: 'n' } }, OTHER);
    expect(lines(d.id)[0].custom_fields).toEqual({ brand_name: 'MAC', note: 'n' });
  });

  it('lists lines without the new keys', async () => {
    const d = deal({ client_id: OTHER }); line(d.id, { brand_name: 'MAC' }, { sku: 'S1' });
    const res = await get(`/crm/deals/${d.id}/line-items`, OTHER);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).not.toHaveProperty('reference');
    expect(res.body[0]).not.toHaveProperty('brand_name');
  });

  it('does not store lines on deal create (items are a connected-B2B feature) and does not look anything up', async () => {
    const mac = tax('crm_brands', 'MAC');
    const res = await post('/crm/deals', { name: 'D', items: [{ name: 'a', quantity: 1, unit_price: 1, brand_id: mac.id }] }, OTHER);
    expect(res.status).toBe(201);
    expect(lines()).toHaveLength(0);
    expect(db.calls).not.toContain('select:crm_brands');
  });
});

// ── deal roll-up ────────────────────────────────────────────────────────────
describe('deal roll-up (line_count, quoted_amount, order_amount, brands)', () => {
  const seed = () => {
    const a = deal({ name: 'A', amount: 300, lead_id: 'L1', account_id: 'AC1' });
    const b = deal({ name: 'B', amount: 50, lead_id: 'L1', account_id: 'AC1' });
    const c = deal({ name: 'C', amount: 10, lead_id: 'L1', account_id: 'AC1' });
    line(a.id, { brand_name: 'MAC', order_value: 100 }); line(a.id, { brand_name: 'PHD', order_value: 150.5 });
    line(a.id, { brand_name: ' MAC ' }); line(a.id, { brand_name: '' });
    line(b.id, { brand_name: 'BEKO' });
    return { a, b, c };
  };
  const byName = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

  it('stamps the deals list with one batched read of the lines', async () => {
    seed();
    const res = await get('/crm/deals');
    expect(res.status).toBe(200);
    const rows = byName(res.body.data);
    expect(rows.A).toMatchObject({ line_count: 4, quoted_amount: 300, order_amount: 250.5, brands: ['MAC', 'PHD'] });
    expect(rows.B).toMatchObject({ line_count: 1, quoted_amount: 50, order_amount: null, brands: ['BEKO'] });
    expect(rows.C).toMatchObject({ line_count: 0, quoted_amount: 10, order_amount: null, brands: [] });
    expect(queries('crm_deal_line_items')).toBe(1);
  });

  it('stamps the deal detail, the lead\'s deals and the account\'s deals', async () => {
    const { a } = seed();
    const detail = await get(`/crm/deals/${a.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: a.id, line_count: 4, quoted_amount: 300, order_amount: 250.5, brands: ['MAC', 'PHD'] });
    const forLead = await get('/crm/leads/L1/deals');
    expect(forLead.status).toBe(200);
    expect(forLead.body).toHaveLength(3);
    expect(byName(forLead.body).A).toMatchObject({ line_count: 4, order_amount: 250.5 });
    const forAccount = await get('/crm/accounts/AC1/deals');
    expect(forAccount.status).toBe(200);
    expect(byName(forAccount.body).B).toMatchObject({ line_count: 1, brands: ['BEKO'] });
  });

  it('a read failure never 500s: counts 0, order null, no brands, quoted still the deal amount', async () => {
    seed();
    db.failTables = new Set(['crm_deal_line_items']);
    const res = await get('/crm/deals');
    expect(res.status).toBe(200);
    expect(byName(res.body.data).A).toMatchObject({ line_count: 0, quoted_amount: 300, order_amount: null, brands: [] });
    expect((await get('/crm/leads/L1/deals')).status).toBe(200);
  });

  it('leaves other tenants\' deals untouched and runs no line query for them', async () => {
    const d = deal({ client_id: OTHER, name: 'X', amount: 5 }); line(d.id, { brand_name: 'MAC', order_value: 5 });
    const list = await get('/crm/deals', OTHER);
    expect(list.status).toBe(200);
    for (const k of ['line_count', 'quoted_amount', 'order_amount', 'brands']) expect(list.body.data[0]).not.toHaveProperty(k);
    const detail = await get(`/crm/deals/${d.id}`, OTHER);
    expect(detail.body).not.toHaveProperty('line_count');
    const forLead = await get('/crm/leads/L1/deals', OTHER);
    expect(forLead.status).toBe(200);
    expect(queries('crm_deal_line_items')).toBe(0);
  });

  it('only the connected-B2B deals of a mixed list are stamped, and only they are queried', async () => {
    const s = deal({ name: 'S', amount: 1 }); const o = deal({ name: 'O', client_id: OTHER, amount: 2 });
    line(s.id, { brand_name: 'PHD' }); line(o.id, { brand_name: 'MAC' });
    const res = await get('/crm/deals', '');
    const rows = byName(res.body.data);
    expect(rows.S).toMatchObject({ line_count: 1, brands: ['PHD'] });
    expect(rows.O).not.toHaveProperty('line_count');
    expect(queries('crm_deal_line_items')).toBe(1);
  });
});

// ── deal -> account from the lead ───────────────────────────────────────────
describe('deal consistency with the lead', () => {
  const lead = (extra: Row = {}): Row => {
    const row = { id: uid(), org_id: ORG, client_id: SPARK, status: 'open', converted_account_id: null, account_id: null, deleted_at: null, ...extra };
    db.tables.crm_leads.push(row);
    return row;
  };
  const account = (extra: Row = {}): Row => {
    const row = { id: uid(), org_id: ORG, name: 'Acme', deleted_at: null, ...extra };
    db.tables.crm_accounts.push(row);
    return row;
  };

  it('derives the account from the lead\'s company account when none is given', async () => {
    const ac = account(); const l = lead({ account_id: ac.id });
    const res = await post('/crm/deals', { name: 'D', lead_id: l.id });
    expect(res.status).toBe(201);
    expect(res.body.account_id).toBe(ac.id);
  });

  it('prefers the account the lead was converted into, and an explicit account wins over both', async () => {
    const conv = account({ name: 'Converted' }); const co = account({ name: 'Company' }); const explicit = account({ name: 'Explicit' });
    const l = lead({ converted_account_id: conv.id, account_id: co.id });
    expect((await post('/crm/deals', { name: 'D', lead_id: l.id })).body.account_id).toBe(conv.id);
    expect((await post('/crm/deals', { name: 'D', lead_id: l.id, account_id: explicit.id })).body.account_id).toBe(explicit.id);
  });

  it('a lead can have several deals, all on its account', async () => {
    const ac = account(); const l = lead({ account_id: ac.id });
    const first = await post('/crm/deals', { name: 'Requirement 1', lead_id: l.id });
    const second = await post('/crm/deals', { name: 'Requirement 2', lead_id: l.id });
    const third = await post('/crm/deals', { name: 'Requirement 3', lead_id: l.id });
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);
    expect(db.tables.crm_deals.filter((x) => x.lead_id === l.id).map((x) => x.account_id)).toEqual([ac.id, ac.id, ac.id]);
  });

  it('an account that has since been deleted is dropped when inferred, but refused when named', async () => {
    const gone = account({ deleted_at: '2026-01-01T00:00:00Z' }); const l = lead({ account_id: gone.id });
    const inferred = await post('/crm/deals', { name: 'D', lead_id: l.id });
    expect(inferred.status).toBe(201);
    expect(inferred.body.account_id).toBeNull();
    const named = await post('/crm/deals', { name: 'D', lead_id: l.id, account_id: gone.id });
    expect(named.status).toBe(400);
    expect(named.body.error.message).toBe('That customer account was not found');
  });

  it('does not touch other tenants: no account is derived', async () => {
    const ac = account(); const l = lead({ client_id: OTHER, account_id: ac.id });
    const res = await post('/crm/deals', { name: 'D', lead_id: l.id }, OTHER);
    expect(res.status).toBe(201);
    expect(res.body.account_id).toBeNull();
  });
});
