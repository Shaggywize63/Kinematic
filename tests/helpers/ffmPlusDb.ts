/**
 * An in-memory PostgREST-style database for the FFM analytics (plus) tests.
 *
 * Unlike tests/helpers/supabaseMock.ts (which records the query a service built), this one APPLIES the
 * filters to seeded rows, so a test can assert the numbers a handler computes AND that another org's rows
 * never reach it. Supported: select (+ the route_plans -> route_plan_outlets embed), eq, neq, in, is, gt, gte,
 * lt, lte, not(col, 'in' | 'is' | 'eq', ...), order (several), range, limit, single, maybeSingle.
 * Timestamp strings (containing 'T') are compared as instants, everything else as plain strings / numbers.
 */
type Row = Record<string, any>;

export interface FfmDb {
  client: { from: (table: string) => any };
  /** Replace every table. */
  reset: (tables?: Record<string, Row[]>) => void;
  tables: Record<string, Row[]>;
  /** One entry per query: table + [method, args] ops, for asserting the query that was built. */
  queries: Array<{ table: string; ops: Array<[string, unknown[]]> }>;
  /** Make every read of `table` fail with this message (simulates a missing table). */
  failTable: (table: string, message?: string) => void;
}

const EMBEDS: Record<string, Record<string, string>> = { route_plans: { route_plan_outlets: 'route_plan_id' } };

const inst = (v: unknown): number | unknown => (typeof v === 'string' && v.includes('T') && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : v);
/** Instants compare as instants, numbers as numbers, everything else (YYYY-MM-DD dates, ids) as strings. */
const cmp = (a: unknown, b: unknown): number => {
  const x = inst(a); const y = inst(b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  const xs = String(a); const ys = String(b);
  return xs < ys ? -1 : xs > ys ? 1 : 0;
};

export function createFfmDb(): FfmDb {
  let tables: Record<string, Row[]> = {};
  const failing = new Map<string, string>();
  const queries: FfmDb['queries'] = [];

  const builder = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    queries.push({ table, ops });
    let selectCols = '*';
    let single: 'single' | 'maybeSingle' | null = null;

    const run = (): { data: any; error: { message: string; code?: string } | null } => {
      if (failing.has(table)) return { data: null, error: { message: failing.get(table)! } };
      let rows: Row[] = (tables[table] || []).map((r) => ({ ...r }));
      let from = 0; let to: number | null = null; let limit: number | null = null;
      const orders: Array<{ col: string; asc: boolean }> = [];
      for (const [m, a] of ops) {
        const [col, val, val2] = a as [string, any, any];
        if (m === 'eq') rows = rows.filter((r) => (r[col] ?? null) === val);
        else if (m === 'neq') rows = rows.filter((r) => (r[col] ?? null) !== val);
        else if (m === 'in') rows = rows.filter((r) => (val as any[]).includes(r[col]));
        else if (m === 'is') rows = rows.filter((r) => (r[col] ?? null) === val);
        else if (m === 'gte') rows = rows.filter((r) => r[col] != null && cmp(r[col], val) >= 0);
        else if (m === 'gt') rows = rows.filter((r) => r[col] != null && cmp(r[col], val) > 0);
        else if (m === 'lte') rows = rows.filter((r) => r[col] != null && cmp(r[col], val) <= 0);
        else if (m === 'lt') rows = rows.filter((r) => r[col] != null && cmp(r[col], val) < 0);
        else if (m === 'not') {
          if (val === 'in') {
            const list = String(val2).replace(/^\(|\)$/g, '').split(',').map((x) => x.trim());
            rows = rows.filter((r) => !list.includes(String(r[col])));
          } else if (val === 'is') rows = rows.filter((r) => (r[col] ?? null) !== val2);
          else if (val === 'eq') rows = rows.filter((r) => r[col] !== val2);
        } else if (m === 'order') {
          orders.push({ col, asc: (val as { ascending?: boolean } | undefined)?.ascending !== false });
        } else if (m === 'range') { from = col as unknown as number; to = val as number; }
        else if (m === 'limit') limit = col as unknown as number;
      }
      for (const o of orders.slice().reverse()) {
        rows.sort((a, b) => (a[o.col] === b[o.col] ? 0 : (a[o.col] ?? '') < (b[o.col] ?? '') ? (o.asc ? -1 : 1) : (o.asc ? 1 : -1)));
      }
      if (to != null) rows = rows.slice(from, to + 1);
      if (limit != null) rows = rows.slice(0, limit);
      for (const [child, fk] of Object.entries(EMBEDS[table] || {})) {
        if (selectCols.includes(`${child}(`)) {
          rows = rows.map((r) => ({ ...r, [child]: (tables[child] || []).filter((c) => c[fk] === r.id).map((c) => ({ ...c })) }));
        }
      }
      if (single) {
        if (rows.length === 0) return single === 'maybeSingle' ? { data: null, error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    };

    const b: any = {};
    for (const m of ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'not', 'order', 'range', 'limit', 'or', 'ilike']) {
      b[m] = (...args: unknown[]) => { ops.push([m, args]); return b; };
    }
    b.select = (cols?: string) => { selectCols = cols || '*'; ops.push(['select', [cols]]); return b; };
    b.single = () => { single = 'single'; return b; };
    b.maybeSingle = () => { single = 'maybeSingle'; return b; };
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad);
    return b;
  };

  const db: FfmDb = {
    client: { from: (table: string) => builder(table) },
    reset: (t = {}) => { tables = JSON.parse(JSON.stringify(t)); db.tables = tables; failing.clear(); queries.length = 0; },
    tables,
    queries,
    failTable: (table, message = 'relation does not exist') => { failing.set(table, message); },
  };
  return db;
}
