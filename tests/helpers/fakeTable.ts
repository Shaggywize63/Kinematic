/**
 * A tiny in-memory table for the Supabase double: it APPLIES the filters a query recorded (eq / is / in /
 * gte / lte / neq, order, limit) to a fixture, so a test can assert on what a query returns, not just on
 * which filters it built — e.g. that an entry dated the 31st is in January's total and the 1st is not.
 * Inserts answer with the inserted row (plus an id and created_at); updates and `or` are not evaluated.
 */
import type { RecordedChain, BuilderResult } from './supabaseMock';

type Row = Record<string, any>;

export function fakeTable(rows: Row[], opts: { insertDefaults?: Row } = {}) {
  return (chain: RecordedChain): BuilderResult => {
    const insert = chain.ops.find((o) => o.method === 'insert');
    if (insert) return { data: { id: 'new-id', created_at: '2026-01-15T10:00:00.000Z', deleted_at: null, ...opts.insertDefaults, ...(insert.args[0] as Row) } };
    let out = rows.slice();
    for (const op of chain.ops) {
      const [col, val] = op.args as [string, any];
      if (op.method === 'eq') out = out.filter((r) => r[col] === val);
      else if (op.method === 'neq') out = out.filter((r) => r[col] !== val);
      else if (op.method === 'is') out = out.filter((r) => (r[col] ?? null) === val);
      else if (op.method === 'in') out = out.filter((r) => (val as any[]).includes(r[col]));
      else if (op.method === 'gte') out = out.filter((r) => r[col] != null && String(r[col]) >= val);
      else if (op.method === 'lte') out = out.filter((r) => r[col] != null && String(r[col]) <= val);
    }
    for (const op of chain.ops.filter((o) => o.method === 'order').reverse()) {
      const [col, o] = op.args as [string, { ascending?: boolean } | undefined];
      const dir = o?.ascending === false ? -1 : 1;
      out = out.slice().sort((a, b) => (a[col] < b[col] ? -dir : a[col] > b[col] ? dir : 0));
    }
    const limit = chain.ops.find((o) => o.method === 'limit');
    if (limit) out = out.slice(0, limit.args[0] as number);
    return { data: out };
  };
}
