/**
 * A faithful, chainable Supabase / PostgREST query-builder double.
 *
 * The real `supabaseAdmin` from `src/lib/supabase.ts` is a thin proxy over a
 * PostgREST fluent builder: `from(table).select(cols).eq(...).is(...).or(...)
 * .order(...).range(...)` and finally `await`ed (or `.single()`) into
 * `{ data, error, count }`. Our services only ever touch that fluent surface,
 * so this double records every call in the chain and resolves to a response
 * the test configured for the table.
 *
 * Two things a test can assert on:
 *   1. The *result* the service returns (rows / errors bubbled up correctly).
 *   2. The *query the service built* — every `.eq('org_id', …)`, `.is(
 *      'deleted_at', null)`, `.or('client_id.is.null,…')`, `.range(…)` is
 *      captured, so tenant-scoping / soft-delete / pagination are verifiable.
 */

export interface BuilderResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
}

export interface RecordedOp {
  method: string;
  args: unknown[];
}

export interface RecordedChain {
  table: string;
  ops: RecordedOp[];
  /** Convenience: every `.eq(col, val)` as a `col -> val` map. */
  eqs: Record<string, unknown>;
  /** Convenience: every `.or(expr)` argument. */
  ors: string[];
  /** True once `.single()`/`.maybeSingle()` was called. */
  single: boolean;
}

type ResponseFor = BuilderResult | ((chain: RecordedChain) => BuilderResult);

export interface SupabaseMock {
  /** The object services import as `supabaseAdmin` / `supabase`. */
  client: {
    from: (table: string) => unknown;
    auth: { getUser: (token: string) => Promise<{ data: { user: unknown }; error: unknown }> };
  };
  /** Queue a response for the *next* query against `table` (FIFO). */
  queue: (table: string, res: ResponseFor) => void;
  /** Set a default response for every query against `table`. */
  setDefault: (table: string, res: ResponseFor) => void;
  /** Every chain that was built, in order. */
  chains: RecordedChain[];
  /** Chains against a specific table. */
  chainsFor: (table: string) => RecordedChain[];
  reset: () => void;
}

const TERMINAL_CHAIN_METHODS = [
  'eq', 'neq', 'is', 'or', 'in', 'ilike', 'like', 'gt', 'gte', 'lt', 'lte',
  'not', 'contains', 'containedBy', 'filter', 'match', 'order', 'range',
  'limit', 'select', 'insert', 'update', 'upsert', 'delete', 'returns',
  'overlaps', 'textSearch', 'csv',
];

export function createSupabaseMock(): SupabaseMock {
  const chains: RecordedChain[] = [];
  const queues = new Map<string, ResponseFor[]>();
  const defaults = new Map<string, ResponseFor>();

  const resolveResponse = (chain: RecordedChain): BuilderResult => {
    const q = queues.get(chain.table);
    let res: ResponseFor | undefined;
    if (q && q.length) res = q.shift();
    else res = defaults.get(chain.table);
    const base: BuilderResult = res
      ? typeof res === 'function'
        ? (res as (c: RecordedChain) => BuilderResult)(chain)
        : res
      : { data: [], error: null, count: 0 };
    return { data: base.data ?? [], error: base.error ?? null, count: base.count ?? null };
  };

  const makeBuilder = (chain: RecordedChain) => {
    const settle = (): BuilderResult => {
      const r = resolveResponse(chain);
      if (chain.single) {
        const rows = Array.isArray(r.data) ? r.data : r.data == null ? [] : [r.data];
        if (r.error) return { data: null, error: r.error };
        // PostgREST `.single()` errors when it doesn't get exactly one row.
        if (rows.length === 0) {
          return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        }
        return { data: rows[0], error: null };
      }
      return r;
    };

    const builder: Record<string, unknown> = {};

    for (const method of TERMINAL_CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        chain.ops.push({ method, args });
        if (method === 'eq') chain.eqs[String(args[0])] = args[1];
        if (method === 'or') chain.ors.push(String(args[0]));
        return builder;
      };
    }

    builder.single = () => {
      chain.single = true;
      chain.ops.push({ method: 'single', args: [] });
      return builder;
    };
    builder.maybeSingle = () => {
      chain.single = true;
      chain.ops.push({ method: 'maybeSingle', args: [] });
      return builder;
    };

    // Make the builder awaitable (thenable) so `await q` and `await q.single()`
    // both resolve to `{ data, error, count }`.
    builder.then = (onFulfilled: (v: BuilderResult) => unknown, onRejected?: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(settle()).then(onFulfilled, onRejected);
      } catch (e) {
        return Promise.reject(e).then(onFulfilled, onRejected);
      }
    };
    builder.catch = (onRejected: (e: unknown) => unknown) => Promise.resolve(settle()).catch(onRejected);

    return builder;
  };

  const client = {
    from: (table: string) => {
      const chain: RecordedChain = { table, ops: [], eqs: {}, ors: [], single: false };
      chains.push(chain);
      return makeBuilder(chain);
    },
    auth: {
      getUser: async (_token: string) => ({ data: { user: null }, error: { message: 'mock: no auth' } }),
    },
  };

  return {
    client,
    queue: (table, res) => {
      const arr = queues.get(table) ?? [];
      arr.push(res);
      queues.set(table, arr);
    },
    setDefault: (table, res) => defaults.set(table, res),
    chains,
    chainsFor: (table) => chains.filter((c) => c.table === table),
    reset: () => {
      chains.length = 0;
      queues.clear();
      defaults.clear();
    },
  };
}
