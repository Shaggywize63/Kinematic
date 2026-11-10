/**
 * In-memory tables for the Supabase double that EVALUATE the filters a query
 * recorded, so a test can assert on what a query returns (another org's rows
 * never appear, a date window is inclusive, a soft-deleted row is skipped) and
 * not only on which filters were built.
 *
 * Supported: eq, neq, is, in, not(col, 'is'|'in', …), gt, gte, lt, lte, order,
 * range, limit. `or` is recorded (assert on `chain.ors`) but NOT evaluated. Embeds
 * are not joined: a fixture row carries them as a nested object (`crm_deal_stages:
 * { stage_type }`) and `eq('crm_deal_stages.stage_type', …)` follows that path.
 * Dates compare as ISO strings (all fixtures use ISO).
 */
import type { SupabaseMock, RecordedChain, BuilderResult } from './supabaseMock';

type Row = Record<string, any>;

/** Column lookup that also follows `embed.column` paths (fixtures carry embeds as nested objects). */
const get = (r: Row, col: string): any => (col.includes('.') ? col.split('.').reduce((o: any, k) => o?.[k], r) : r[col]);

const inList = (raw: unknown): string[] =>
  String(raw).replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));

export function evaluate(rows: Row[], chain: RecordedChain): BuilderResult {
  let out = rows.slice();
  for (const op of chain.ops) {
    const [a, b, c] = op.args as [string, any, any];
    switch (op.method) {
      case 'eq': out = out.filter((r) => get(r, a) === b); break;
      case 'neq': out = out.filter((r) => get(r, a) !== b); break;
      case 'is': out = out.filter((r) => (get(r, a) ?? null) === b); break;
      case 'in': out = out.filter((r) => (b as any[]).includes(get(r, a))); break;
      case 'gt': out = out.filter((r) => get(r, a) != null && String(get(r, a)) > String(b)); break;
      case 'gte': out = out.filter((r) => get(r, a) != null && String(get(r, a)) >= String(b)); break;
      case 'lt': out = out.filter((r) => get(r, a) != null && String(get(r, a)) < String(b)); break;
      case 'lte': out = out.filter((r) => get(r, a) != null && String(get(r, a)) <= String(b)); break;
      case 'not':
        if (b === 'is') out = out.filter((r) => (get(r, a) ?? null) !== c);
        else if (b === 'in') { const l = inList(c); out = out.filter((r) => !l.includes(String(get(r, a)))); }
        break;
      default: break;
    }
  }
  for (const op of chain.ops.filter((o) => o.method === 'order').reverse()) {
    const [col, o] = op.args as [string, { ascending?: boolean } | undefined];
    const dir = o?.ascending === false ? -1 : 1;
    out = out.slice().sort((x, y) => (x[col] < y[col] ? -dir : x[col] > y[col] ? dir : 0));
  }
  const limit = chain.ops.find((o) => o.method === 'limit');
  if (limit) out = out.slice(0, limit.args[0] as number);
  return { data: out };
}

/** Install the given tables as defaults on the mock. Tables not listed answer with no rows. */
export function installTables(mock: SupabaseMock, tables: Record<string, Row[]>) {
  for (const [name, rows] of Object.entries(tables)) {
    mock.setDefault(name, (chain) => evaluate(rows, chain));
  }
}
